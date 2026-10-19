// Faces for the front desk's webcam, against a real MongoDB and over HTTP
// through index.js as it runs (loaded as deskLink.test.js loads it).
//
// The desk registers a face only with consent and only as a well-formed
// SFace template, sealed under the gym's key; it downloads every face it can
// match -- not a departed member's, not one it cannot decrypt -- and a face
// punch keeps how sure the camera was. The web kiosk may do none of it, and a
// desk account without the enrolment grant may not register or remove a
// face. The office lists and removes faces; the person sees and deletes their
// own; and a face goes with the person when their account, their trainer
// record or their biometric consent does.

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

const INDEX = path.resolve(__dirname, '..', '..', 'index.js');
const MODEL = 'sface-2021dec';

let server;
let base;
let gym;
let otherGym;
let User;
let Trainer;
let FaceTemplate;
let Attendance;
let AttendanceLog;
let operator;
let noGrant;
let coach;
let admin;
let deskToken;
let kioskToken;
let plainDesk;

const test = h.suite(async () => {
  gym = await h.createGym('faces-gym', { name: 'Face Gym', timezone: h.middayZone() });
  otherGym = await h.createGym('faces-other', { name: 'Other Gym' });

  User = h.src('models/user');
  Trainer = h.src('gymfolio/models/trainerModel');
  FaceTemplate = h.src('attendance/models/faceTemplateModel');
  Attendance = h.src('attendance/models/attendanceModel');
  AttendanceLog = h.src('attendance/models/attendanceLogModel');
  const DesktopToken = h.src('attendance/models/desktopTokenModel');

  await h.inGym(gym, async () => {
    await h.ensureIndexes(FaceTemplate, Attendance, User);
    await h.src('services/roleService').ensureDefaultRoles();
    const staff = (firstName, extra) =>
      User.create({ firstName, lastName: 'Staff', email: `${firstName.toLowerCase()}@faces.test`, role: 'receptionist', employment: { isStaff: true }, ...extra });
    operator = await User.create({
      firstName: 'Front',
      lastName: 'Desk',
      email: 'front@faces.test',
      role: 'receptionist',
      employment: { isStaff: true },
      allowAttendanceApp: true,
      allowFingerprintEnrollment: true
    });
    noGrant = await staff('Nora', { allowAttendanceApp: true });
    coach = await User.create({ firstName: 'Cal', lastName: 'Coach', email: 'cal@faces.test', role: 'trainer', employment: { isStaff: true } });
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@faces.test', role: 'admin', employment: { isStaff: true } });

    deskToken = (await DesktopToken.issue(operator._id, { deviceLabel: 'FRONT-PC', clientApp: 'GymPilotAttendanceDesktop/1.4.0' })).token;
    kioskToken = (await DesktopToken.issue(operator._id, { deviceLabel: 'Kiosk', clientApp: 'GymPilotKiosk/1.0' })).token;
    plainDesk = (await DesktopToken.issue(noGrant._id, { deviceLabel: 'BACK-PC', clientApp: 'GymPilotAttendanceDesktop/1.4.0' })).token;
  });

  const dotenvPath = require.resolve('dotenv');
  require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config: () => ({ parsed: {} }) } };

  const express = require('express');
  const listen = express.application.listen;
  let app;
  express.application.listen = function captured() {
    app = this;
    return { close() {} };
  };
  try {
    require(INDEX);
  } finally {
    express.application.listen = listen;
  }

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

require('node:test').after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function send(method, url, { headers = {}, body, raw } = {}) {
  const payload = raw !== undefined ? raw : body ? JSON.stringify(body) : undefined;
  const res = await fetch(base + url, {
    method,
    headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: payload
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const atGym = { 'X-Tenant-Host': 'faces-gym.test' };
// The device fields ride on every desk request, as the Windows app sends them.
const desk = (route, body, token = deskToken) =>
  send('POST', `/api/desktop/${route}`, {
    headers: { ...atGym, Authorization: `Bearer ${token}` },
    body: { device_label: 'FRONT-PC', client_app: 'GymPilotAttendanceDesktop/1.4.0', ...body }
  });
const session = (user) => ({
  ...atGym,
  Authorization: `Bearer ${jwt.sign({ id: String(user._id), email: user.email, role: user.role || 'user', tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' })}`
});

// A unit vector of 128 numbers, as the desk sends them.
function vector(seed) {
  const raw = Array.from({ length: 128 }, (_, i) => Math.cos(seed * 17 + i * 0.37));
  const norm = Math.sqrt(raw.reduce((sum, n) => sum + n * n, 0));
  return raw.map((n) => n / norm);
}

let seq = 0;
function member(fields = {}) {
  seq += 1;
  return h.inGym(gym, () => User.create({ firstName: 'Face', lastName: `Member${seq}`, email: `face${seq}@faces.test`, ...fields }));
}

const enroll = (person, extra = {}, token) =>
  desk('face-enroll', { person_type: 'member', person_id: String(person._id), model: MODEL, embeddings: [vector(seq), vector(seq + 1)], consent: true, ...extra }, token);
const facesOf = (personId) => h.inGym(gym, () => FaceTemplate.find({ personId }).select('+embeddings').lean());

// Written after the response; give it a moment to land.
async function logged(filter) {
  for (let i = 0; i < 50; i += 1) {
    const row = await h.inGym(gym, () => AttendanceLog.findOne(filter).sort({ createdAt: -1 }).lean());
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

let mia;

test('a face is refused without consent, from another model, and as anything but 1 to 10 vectors of 128 numbers', async () => {
  mia = await member({ firstName: 'Mia', lastName: 'Member', memberCode: 'GP-0201' });
  const good = { person_type: 'member', person_id: String(mia._id), model: MODEL, embeddings: [vector(1)], consent: true };
  const refused = async (body, status, code, label) => {
    const res = await desk('face-enroll', body);
    assert.equal(res.status, status, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, false, label);
    if (code) assert.equal(res.body.code, code, label);
  };

  for (const consent of [undefined, false, 'true', 1, 'yes']) {
    await refused({ ...good, consent }, 400, 'CONSENT_REQUIRED', `consent ${JSON.stringify(consent)}`);
  }
  await refused({ ...good, model: 'arcface-r100' }, 400, 'BAD_TEMPLATE', 'another model');
  await refused({ ...good, model: undefined }, 400, 'BAD_TEMPLATE', 'no model');
  await refused({ ...good, embeddings: [] }, 400, 'BAD_TEMPLATE', 'no vectors');
  await refused({ ...good, embeddings: Array.from({ length: 11 }, (_, i) => vector(i)) }, 400, 'BAD_TEMPLATE', 'eleven vectors');
  await refused({ ...good, embeddings: [vector(1).slice(0, 127)] }, 400, 'BAD_TEMPLATE', '127 numbers');
  await refused({ ...good, embeddings: [[...vector(1).slice(0, 127), 'x']] }, 400, 'BAD_TEMPLATE', 'a string in it');
  await refused({ ...good, embeddings: [[...vector(1).slice(0, 127), null]] }, 400, 'BAD_TEMPLATE', 'a null (NaN as JSON)');
  await refused({ ...good, embeddings: vector(1) }, 400, 'BAD_TEMPLATE', 'one flat vector');

  // A number too large for a double arrives as Infinity.
  const huge = JSON.stringify({ ...good, embeddings: [[...vector(1).slice(0, 127), 12345]] }).replace('12345', '1e400');
  const infinite = await send('POST', '/api/desktop/face-enroll', { headers: { ...atGym, Authorization: `Bearer ${deskToken}` }, raw: huge });
  assert.equal(infinite.status, 400, JSON.stringify(infinite.body));
  assert.equal(infinite.body.code, 'BAD_TEMPLATE');

  await refused({ ...good, person_type: 'visitor' }, 400, null, 'person type');
  await refused({ ...good, person_id: 'nobody' }, 400, null, 'person id');
  await refused({ ...good, person_id: String(new h.state.mongoose.Types.ObjectId()) }, 404, null, 'nobody on file');

  assert.deepEqual(await facesOf(mia._id), [], 'nothing was stored');
});

test('a face is saved sealed, with who agreed and when; enrolling again replaces it', async () => {
  const vectors = [vector(11), vector(12), vector(13)];
  const first = await desk('face-enroll', { person_type: 'member', person_id: String(mia._id), model: MODEL, embeddings: vectors, consent: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, {
    success: true,
    message: 'Face saved for Mia Member.',
    data: { person_type: 'member', person_id: String(mia._id), count: 3 }
  });

  let [row] = await facesOf(mia._id);
  assert.equal(row.personType, 'member');
  assert.equal(row.model, MODEL);
  assert.equal(row.count, 3);
  assert.equal(String(row.consentBy), String(operator._id));
  assert.ok(row.consentAt instanceof Date && Date.now() - row.consentAt.getTime() < 60000);
  assert.equal(String(row.enrolledBy), String(operator._id));
  assert.equal(row.enrolledByName, 'Front Desk');
  assert.equal(row.device, 'FRONT-PC');
  assert.equal(row.isActive, true);
  assert.ok(!row.embeddings.includes(String(vectors[0][0]).slice(0, 8)), 'sealed, not in the clear');
  assert.deepEqual(await h.inGym(gym, () => FaceTemplate.decryptEmbeddings(row.embeddings)), vectors);
  // Not even its ciphertext comes out of an ordinary read.
  assert.equal((await h.inGym(gym, () => FaceTemplate.findById(row._id).lean())).embeddings, undefined);

  const again = await desk('face-enroll', { person_type: 'member', person_id: String(mia._id), model: MODEL, embeddings: [vector(14), vector(15)], consent: true });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.count, 2);
  const rows = await facesOf(mia._id);
  assert.equal(rows.length, 1, 'one face per person');
  [row] = rows;
  assert.equal(row.count, 2);
  assert.deepEqual(await h.inGym(gym, () => FaceTemplate.decryptEmbeddings(row.embeddings)), [vector(14), vector(15)]);

  const audit = await logged({ event: 'face_enroll', personId: mia._id });
  assert.ok(audit, 'in the audit trail');
  assert.equal(String(audit.userId), String(operator._id));
  assert.deepEqual(audit.meta, { count: 2, model: MODEL });
});

test("the desk downloads every face it can match: not a departed member's, not one sealed elsewhere", async () => {
  const gus = await member({ firstName: 'Gus', lastName: 'Gone' });
  assert.equal((await enroll(gus)).status, 200);
  await h.inGym(gym, () => User.updateOne({ _id: gus._id }, { $set: { isActive: false } }));

  // Sealed under the other gym's key: what a changed secret looks like too.
  const ina = await member({ firstName: 'Ina', lastName: 'Unreadable' });
  const foreign = await h.inGym(otherGym, () => FaceTemplate.encryptEmbeddings([vector(21)]));
  await h.inGym(gym, () => FaceTemplate.create({ personType: 'member', personId: ina._id, embeddings: foreign, model: MODEL, count: 1, consentAt: new Date() }));

  const res = await desk('face-templates', {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.model, MODEL);
  assert.equal(res.body.data.unreadable, 1);
  const ids = res.body.data.templates.map((t) => t.person_id);
  assert.ok(ids.includes(String(mia._id)));
  assert.ok(!ids.includes(String(gus._id)), 'a departed member stops matching');
  assert.ok(!ids.includes(String(ina._id)), 'an unreadable face is skipped');
  const theirs = res.body.data.templates.find((t) => t.person_id === String(mia._id));
  assert.deepEqual(theirs, { person_type: 'member', person_id: String(mia._id), embeddings: [vector(14), vector(15)] });

  const audit = await logged({ event: 'face_template_download' });
  assert.ok(audit);
  assert.equal(audit.meta.unreadable, 1);
  assert.ok(audit.meta.departed >= 1);
  assert.equal(audit.meta.count, res.body.data.templates.length);
});

test('the web kiosk may not touch faces at all; a desk without the enrolment grant may download but not register or remove', async () => {
  const body = { person_type: 'member', person_id: String(mia._id), model: MODEL, embeddings: [vector(1)], consent: true };
  for (const route of ['face-templates', 'face-enroll', 'face-remove']) {
    const res = await desk(route, body, kioskToken);
    assert.equal(res.status, 403, `${route}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'KIOSK_NOT_ALLOWED');
  }

  assert.equal((await desk('face-templates', {}, plainDesk)).status, 200);
  for (const route of ['face-enroll', 'face-remove']) {
    const res = await desk(route, body, plainDesk);
    assert.equal(res.status, 403, `${route}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.message, 'This account is not allowed to register fingerprints or faces.');
  }
  const [row] = await facesOf(mia._id);
  assert.equal(row.count, 2, 'untouched');
});

test('a face punch keeps how sure the camera was, on the visit and in the audit trail', async () => {
  const punch = (person, extra) =>
    desk('punch', { person_type: 'member', person_id: String(person._id), ...extra });

  for (const score of ['high', 1.5, -0.2, true]) {
    const res = await punch(mia, { method: 'face', match_score: score });
    assert.equal(res.status, 400, `${score}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, /match_score/);
  }

  const res = await punch(mia, { method: 'face', match_score: 0.61234, request_id: 'face-punch-0001' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.detail.action, 'check_in');
  const [visit] = await h.inGym(gym, () => Attendance.find({ personId: mia._id }).lean());
  assert.equal(visit.checkIn.method, 'face');
  assert.equal(visit.checkIn.matchScore, 0.612);

  const audit = await logged({ event: 'punch', personId: mia._id });
  assert.equal(audit.method, 'face');
  assert.equal(audit.meta.matchScore, 0.612);

  // Not a face: a score means nothing, and is not kept.
  const lou = await member();
  assert.equal((await punch(lou, { method: 'fingerprint', match_score: 0.9 })).body.success, true);
  const [plain] = await h.inGym(gym, () => Attendance.find({ personId: lou._id }).lean());
  assert.equal(plain.checkIn.method, 'fingerprint');
  assert.equal('matchScore' in plain.checkIn, false);
});

test('the office lists faces with their owners and dates; a view role cannot remove one, a manage role can', async () => {
  const listed = await send('GET', '/api/attendance/faces', { headers: session(coach) });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(!JSON.stringify(listed.body).includes('embeddings'), 'no vectors, sealed or not');
  assert.equal(listed.body.summary.unreadable, 1);
  assert.ok(listed.body.summary.departed >= 1);
  const row = listed.body.people.find((p) => p.person_id === String(mia._id));
  assert.equal(row.person_type, 'member');
  assert.equal(row.name, 'Mia Member');
  assert.equal(row.code, 'GP-0201');
  assert.equal(row.count, 2);
  assert.equal(row.readable, true);
  assert.equal(row.status, 'active');
  assert.equal(row.enrolled_by_name, 'Front Desk');
  assert.ok(row.enrolled_at && row.consent_at);
  assert.ok(listed.body.pagination.total >= 3);

  const found = await send('GET', '/api/attendance/faces?q=gp-0201', { headers: session(coach) });
  assert.deepEqual(found.body.people.map((p) => p.name), ['Mia Member']);
  const unreadable = await send('GET', '/api/attendance/faces?show=unreadable', { headers: session(coach) });
  assert.deepEqual(unreadable.body.people.map((p) => p.name), ['Ina Unreadable']);
  const departed = await send('GET', '/api/attendance/faces?show=departed', { headers: session(coach) });
  assert.ok(departed.body.people.some((p) => p.name === 'Gus Gone' && p.status === 'inactive'));

  const target = `/api/attendance/faces/member/${mia._id}`;
  const refused = await send('DELETE', target, { headers: session(coach) });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal((await facesOf(mia._id)).length, 1);

  const removed = await send('DELETE', target, { headers: session(operator) });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.success, true);
  assert.equal(removed.body.removed, 1);
  assert.match(removed.body.message, /Mia Member/);
  assert.deepEqual(await facesOf(mia._id), []);

  const gone = await send('DELETE', target, { headers: session(operator) });
  assert.equal(gone.status, 404);
  assert.deepEqual([gone.body.success, gone.body.removed], [false, 0]);
  assert.equal((await send('DELETE', '/api/attendance/faces/visitor/x', { headers: session(operator) })).status, 400);
});

test('the person sees whether their face is on file and deletes it themselves', async () => {
  const pat = await member({ firstName: 'Pat', lastName: 'Self' });
  const mine = () => send('GET', '/api/attendance/me/face', { headers: session(pat) });

  assert.deepEqual((await mine()).body, { success: true, data: { enrolled: false, enrolled_at: null } });
  assert.equal((await enroll(pat)).status, 200);
  const on = await mine();
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.data.enrolled, true);
  assert.ok(Math.abs(new Date(on.body.data.enrolled_at).getTime() - Date.now()) < 60000);
  assert.equal(on.body.data.enrolled_at, new Date(on.body.data.enrolled_at).toISOString());

  const withdrawn = await send('DELETE', '/api/attendance/me/face', { headers: session(pat) });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.body.success, true);
  assert.equal(withdrawn.body.removed, 1);
  assert.deepEqual(await facesOf(pat._id), []);
  assert.deepEqual((await mine()).body.data, { enrolled: false, enrolled_at: null });
  assert.equal((await send('DELETE', '/api/attendance/me/face', { headers: session(pat) })).body.removed, 0);

  const audit = await logged({ event: 'face_remove', personId: pat._id });
  assert.equal(String(audit.userId), String(pat._id));
  assert.deepEqual(audit.meta, { removed: 1, self: true });

  // Only their own: somebody else's face is not touched.
  const other = await member();
  assert.equal((await enroll(other)).status, 200);
  await send('DELETE', '/api/attendance/me/face', { headers: session(pat) });
  assert.equal((await facesOf(other._id)).length, 1);

  assert.equal((await send('GET', '/api/attendance/me/face', { headers: atGym })).status, 401);
});

test('the desk can take a face off file, and says so when there was none', async () => {
  const kim = await member();
  assert.equal((await enroll(kim)).status, 200);
  const body = { person_type: 'member', person_id: String(kim._id) };
  const res = await desk('face-remove', body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.removed, 1);
  assert.deepEqual(await facesOf(kim._id), []);
  const again = await desk('face-remove', body);
  assert.deepEqual([again.status, again.body.success, again.body.removed], [200, true, 0]);
  assert.equal((await desk('face-remove', { person_type: 'member', person_id: 'x' })).status, 400);
});

test('a face goes with the person: account deleted, trainer deleted, biometric consent withdrawn', async () => {
  const users = h.src('controller/userController');
  const trainers = h.src('gymfolio/controller/trainerController');
  const security = h.src('controller/securityController');

  // The account deleted from the Users screen.
  const leaving = await member();
  assert.equal((await enroll(leaving)).status, 200);
  const bearer = `Bearer ${jwt.sign({ id: String(admin._id), email: admin.email, role: 'admin' }, process.env.JWT_SECRET)}`;
  const deleted = await h.inGym(gym, () =>
    h.call(users.deleteUserById, { headers: { authorization: bearer }, user: { id: String(admin._id), role: 'admin' }, roleSlug: 'admin', params: { id: String(leaving._id) } })
  );
  assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
  assert.deepEqual(await facesOf(leaving._id), []);

  // A trainer record deleted.
  const tara = await h.inGym(gym, () => Trainer.create({ name: 'Tara Trainer', email: 'tara@faces.co', role: 'Coach' }));
  assert.equal((await enroll(tara, { person_type: 'staff' })).status, 200);
  assert.equal((await facesOf(tara._id)).length, 1);
  const removedTrainer = await h.inGym(gym, () => h.call(trainers.deleteTrainer, { params: { id: String(tara._id) } }));
  assert.equal(removedTrainer.statusCode, 200, JSON.stringify(removedTrainer.body));
  assert.deepEqual(await facesOf(tara._id), []);

  // Biometric consent withdrawn by the member: no to fingerprints is no to faces.
  const con = await member();
  assert.equal((await enroll(con)).status, 200);
  const withdrawn = await h.inGym(gym, () => h.call(security.setMyConsent, { user: { id: String(con._id) }, body: { biometric: false } }));
  assert.equal(withdrawn.statusCode, 200, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.body.data.facesRemoved, 1);
  assert.equal(withdrawn.body.message, 'Consent withdrawn and your stored face deleted.');
  assert.deepEqual(await facesOf(con._id), []);

  // ...or recorded as withdrawn by staff.
  const form = await member();
  assert.equal((await enroll(form)).status, 200);
  const recorded = await h.inGym(gym, () =>
    h.call(security.recordConsent, { user: { id: String(admin._id), role: 'admin' }, roleSlug: 'admin', params: { id: String(form._id) }, body: { biometric: false } })
  );
  assert.equal(recorded.statusCode, 200, JSON.stringify(recorded.body));
  assert.match(recorded.body.message, /their face deleted/);
  assert.deepEqual(await facesOf(form._id), []);
});
