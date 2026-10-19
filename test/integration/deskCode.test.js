// Checking in with your own phone, against a real MongoDB and over HTTP
// through index.js as it runs: the desk's screen (the Windows app or the web
// kiosk) asks for its rotating code, the member's signed-in phone sends it
// back, and the visit is recorded at that desk -- under its desk account and
// its PC's name, with the method `desk_code`. The answer is the desk punch's:
// check-in, check-out, "already checked in", refused at the door, and the
// same answer again for a request sent twice. A code that is stale, forged,
// another gym's, or from a screen that has since been signed out is refused
// with its own code, and one account is paused after ten tries in a minute.
//
// index.js is loaded the way deskLink.test.js loads it: dotenv replaced first,
// the app captured at listen() and served on a port of this test's.

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

const INDEX = path.resolve(__dirname, '..', '..', 'index.js');

let server;
let base;
let gym;
let otherGym;
let User;
let DesktopToken;
let Attendance;
let AttendanceLog;
let deskCode;
let operator;
let deskToken;
let kioskToken;

const test = h.suite(async () => {
  gym = await h.createGym('desk-code-gym', { name: 'Code Gym', timezone: h.middayZone() });
  otherGym = await h.createGym('desk-code-other', { name: 'Other Gym' });

  User = h.src('models/user');
  DesktopToken = h.src('attendance/models/desktopTokenModel');
  Attendance = h.src('attendance/models/attendanceModel');
  AttendanceLog = h.src('attendance/models/attendanceLogModel');
  deskCode = h.src('attendance/services/deskCode');

  await h.inGym(gym, async () => {
    await h.ensureIndexes(Attendance, User, DesktopToken);
    operator = await User.create({
      firstName: 'Front',
      lastName: 'Desk',
      email: 'front@code.test',
      role: 'receptionist',
      employment: { isStaff: true },
      allowAttendanceApp: true,
      attendanceLocation: 'Main'
    });
    deskToken = (await DesktopToken.issue(operator._id, { deviceLabel: 'FRONT-PC', clientApp: 'GymPilotAttendanceDesktop/1.4.0', osUser: 'frontdesk', ip: '10.0.0.5' })).token;
    kioskToken = (await DesktopToken.issue(operator._id, { deviceLabel: 'Kiosk', clientApp: 'GymPilotKiosk/1.0', ip: '10.0.0.6' })).token;
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

async function send(method, url, { headers = {}, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, headers: res.headers };
}

const atGym = (target = gym) => ({ 'X-Tenant-Host': `${target.slug}.test` });
const asDesk = (token = deskToken) => ({ ...atGym(), Authorization: `Bearer ${token}` });
const sessionFor = (user, target = gym) =>
  jwt.sign({ id: String(user._id), email: user.email, role: user.role || 'user', tid: String(target._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
const asPhone = (user) => ({ ...atGym(), Authorization: `Bearer ${sessionFor(user)}` });

const screenCode = async (token = deskToken) => {
  const res = await send('POST', '/api/desktop/checkin-code', { headers: asDesk(token), body: { device_label: 'ignored' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.code;
};
const checkIn = (user, body) => send('POST', '/api/attendance/me/checkin', { headers: asPhone(user), body });
const checkinUrl = (code) => `https://${gym.slug}.test/checkin?c=${encodeURIComponent(code)}`;

let seq = 0;
function person(fields = {}) {
  seq += 1;
  return h.inGym(gym, () => User.create({ firstName: 'Phone', lastName: `Member${seq}`, email: `phone${seq}@code.test`, ...fields }));
}

const visitsOf = (user) => h.inGym(gym, () => Attendance.find({ personId: user._id }).sort({ checkInAt: 1 }).lean());
const backdate = (user, minutes) =>
  h.inGym(gym, () => Attendance.collection.updateOne({ personId: user._id, checkOutAt: null }, { $set: { checkInAt: h.minutesAgo(minutes) } }));

// Written after the response; give it a moment to land.
async function logsOf(user, count) {
  let rows = [];
  for (let i = 0; i < 50 && rows.length < count; i += 1) {
    rows = await h.inGym(gym, () => AttendanceLog.find({ personId: user._id }).sort({ createdAt: 1 }).lean());
    if (rows.length < count) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return rows;
}

test('the desk and the kiosk are handed a fresh code, with no staff unlock', async () => {
  for (const token of [deskToken, kioskToken]) {
    const before = Date.now();
    const res = await send('POST', '/api/desktop/checkin-code', { headers: asDesk(token) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    const { code, expires_at: expiresAt, valid_seconds: valid, refresh_after_seconds: refresh, checkin_path: checkinPath } = res.body.data;
    assert.match(code, /^GPD1\.[0-9a-f]{24}\.\d+\.[A-Za-z0-9_-]{24}$/);
    assert.deepEqual([valid, refresh, checkinPath], [60, 20, '/checkin']);
    const left = new Date(expiresAt).getTime() - before;
    assert.ok(left > 58000 && left <= 61000, `${left}ms left`);
    assert.equal(expiresAt, new Date(expiresAt).toISOString());
  }

  assert.equal((await send('POST', '/api/desktop/checkin-code', { headers: atGym() })).status, 401);
});

test('a member scans the screen: checked in at that desk, told "already" on a second scan, then checked out', async () => {
  const mia = await person();

  const first = await checkIn(mia, { code: checkinUrl(await screenCode()) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.success, true);
  assert.equal(first.body.message, 'Check-in recorded.');
  assert.equal(first.body.detail.action, 'check_in');
  assert.equal(first.body.detail.person_name, `Phone Member${seq}`);
  assert.deepEqual(Object.keys(first.body).sort(), ['detail', 'message', 'success']);

  let [visit] = await visitsOf(mia);
  assert.equal(visit.personType, 'member');
  assert.equal(visit.checkIn.method, 'desk_code');
  // The desk's, not the phone's.
  assert.equal(visit.checkIn.device, 'FRONT-PC');
  assert.equal(visit.checkIn.clientApp, 'GymPilotAttendanceDesktop/1.4.0');
  assert.equal(visit.checkIn.osUser, 'frontdesk');
  assert.equal(visit.checkIn.ip, '10.0.0.5');
  assert.equal(visit.checkIn.byName, 'Front Desk');
  assert.equal(String(visit.checkIn.by), String(operator._id));
  assert.equal(visit.checkIn.location, 'Main');

  // Straight away again, the bare code this time: neutral, nothing recorded.
  const again = await checkIn(mia, { code: await screenCode() });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.success, false);
  assert.equal(again.body.ignored, true);
  assert.equal(again.body.message, 'Already checked in a moment ago.');
  assert.equal(again.body.detail.action, 'ignore');
  assert.equal((await visitsOf(mia)).length, 1);

  // An hour later, from the kiosk's screen: the way out, at the kiosk.
  await backdate(mia, 60);
  const out = await checkIn(mia, { code: checkinUrl(await screenCode(kioskToken)) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.success, true);
  assert.equal(out.body.detail.action, 'check_out');
  [visit] = await visitsOf(mia);
  assert.equal(visit.checkOut.method, 'desk_code');
  assert.equal(visit.checkOut.device, 'Kiosk');
  assert.ok(Math.abs(visit.workedMinutes - 60) <= 1);

  // The audit trail: the desk account took each one, about the member.
  const logs = await logsOf(mia, 3);
  assert.deepEqual(logs.map((row) => [row.event, row.action, row.method]), [
    ['punch', 'check_in', 'desk_code'],
    ['punch_denied', 'ignore', 'desk_code'],
    ['punch', 'check_out', 'desk_code']
  ]);
  assert.ok(logs.every((row) => String(row.userId) === String(operator._id)));
  assert.equal(logs[0].device, 'FRONT-PC');
  assert.ok(logs[0].meta.phoneIp, 'where the phone was is kept beside the desk');
});

test('staff check themselves in as staff', async () => {
  const sid = await person({ role: 'receptionist', employment: { isStaff: true, jobTitle: 'Reception' } });
  const res = await checkIn(sid, { code: await screenCode() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.detail.person_type, 'staff');
  const [visit] = await visitsOf(sid);
  assert.equal(visit.personType, 'staff');
  assert.equal(visit.checkIn.method, 'desk_code');
});

test('a member the gym turns away is told so, and nothing is recorded', async () => {
  const corrections = h.src('attendance/controller/attendanceCorrectionController');
  const putRules = (refuseEntry) => h.inGym(gym, () => h.call(corrections.updateSettings, { body: { refuseEntry }, user: { id: String(operator._id), role: 'admin' } }));
  assert.equal((await putRules({ noPackage: true })).statusCode, 200);
  try {
    const nobody = await person();
    const res = await checkIn(nobody, { code: await screenCode() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    assert.equal(res.body.refused, true);
    assert.equal(res.body.code, 'ENTRY_REFUSED');
    assert.equal(res.body.reason, 'no_package');
    assert.match(res.body.message, /^Entry refused/);
    assert.equal(res.body.detail.refused, true);
    assert.deepEqual(await visitsOf(nobody), []);
  } finally {
    await putRules({ noPackage: false });
  }
});

test('the same request sent twice is answered twice and recorded once', async () => {
  const rae = await person();
  const code = await screenCode();
  const first = await checkIn(rae, { code, request_id: 'phone-checkin-0001' });
  assert.equal(first.body.success, true, JSON.stringify(first.body));
  await backdate(rae, 5);
  const again = await checkIn(rae, { code: await screenCode(), request_id: 'phone-checkin-0001' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.repeated, true);
  assert.equal(again.body.success, true);
  assert.equal(again.body.detail.action, 'check_in');
  assert.equal(again.body.message, first.body.message);
  const visits = await visitsOf(rae);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].checkIn.requestId, 'phone-checkin-0001');
  assert.equal(visits[0].checkOutAt, null, 'still inside');

  const bad = await checkIn(rae, { code: await screenCode(), request_id: 'no' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /request_id must be 8 to 100/);
});

test('a code past its minute is "changed"; one a few seconds over is still taken', async () => {
  const stored = await h.inGym(gym, () => DesktopToken.findOne({ tokenHash: DesktopToken.hashToken(deskToken) }).lean());
  const issued = (ago) => h.inGym(gym, () => deskCode.issueDeskCode(stored._id, Date.now() - ago).code);

  const late = await person();
  const stale = await checkIn(late, { code: await issued(70 * 1000) });
  assert.equal(stale.status, 410, JSON.stringify(stale.body));
  assert.deepEqual(stale.body, { success: false, code: 'CODE_EXPIRED', message: 'That code has changed. Scan the screen again.' });
  assert.deepEqual(await visitsOf(late), []);

  const justInTime = await checkIn(late, { code: await issued(62 * 1000) });
  assert.equal(justInTime.status, 200, JSON.stringify(justInTime.body));
  assert.equal(justInTime.body.success, true);
});

test("a forged code, another gym's, or nothing at all is not this gym's code", async () => {
  const kim = await person();
  const good = await screenCode();
  const [version, id, exp, sig] = good.split('.');
  const theirs = await h.inGym(otherGym, () => deskCode.issueDeskCode(id).code);
  const invalid = {
    success: false,
    code: 'CODE_INVALID',
    message: "That isn't your gym's check-in code. Scan the code on the screen at the front desk."
  };

  for (const code of [
    [version, id, String(Number(exp) + 600), sig].join('.'),
    theirs,
    'https://example.test/some-other-qr',
    'GP-0001',
    '',
    undefined
  ]) {
    const res = await checkIn(kim, code === undefined ? {} : { code });
    assert.equal(res.status, 400, `${code}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, invalid);
  }
  assert.deepEqual(await visitsOf(kim), []);
});

test('a screen signed out since, or run by an account that lost the desk grant, is "signed out"', async () => {
  const signedOut = { success: false, code: 'DESK_SIGNED_OUT', message: 'The check-in screen is signed out. Ask at the front desk.' };
  const lou = await person();

  // Signed out from the desk itself.
  const { token: spare } = await h.inGym(gym, () => DesktopToken.issue(operator._id, { deviceLabel: 'SPARE-PC' }));
  const spareCode = await screenCode(spare);
  assert.equal((await send('POST', '/api/desktop/logout', { headers: asDesk(spare) })).status, 200);
  let res = await checkIn(lou, { code: spareCode });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.deepEqual(res.body, signedOut);

  // Its token run out.
  const { token: lapsed } = await h.inGym(gym, () => DesktopToken.issue(operator._id, { deviceLabel: 'OLD-PC' }));
  const lapsedCode = await screenCode(lapsed);
  await h.inGym(gym, () => DesktopToken.updateOne({ tokenHash: DesktopToken.hashToken(lapsed) }, { $set: { expiresAt: new Date(Date.now() - 1000) } }));
  res = await checkIn(lou, { code: lapsedCode });
  assert.deepEqual([res.status, res.body], [409, signedOut]);

  // Its account no longer allowed to run a desk.
  const temp = await person({ role: 'receptionist', employment: { isStaff: true }, allowAttendanceApp: true });
  const { token: tempDesk } = await h.inGym(gym, () => DesktopToken.issue(temp._id, { deviceLabel: 'TEMP-PC' }));
  const tempCode = await screenCode(tempDesk);
  await h.inGym(gym, () => User.updateOne({ _id: temp._id }, { $set: { allowAttendanceApp: false } }));
  res = await checkIn(lou, { code: tempCode });
  assert.deepEqual([res.status, res.body], [409, signedOut]);

  assert.deepEqual(await visitsOf(lou), []);
});

test('no session is a 401 as usual', async () => {
  const res = await send('POST', '/api/attendance/me/checkin', { headers: atGym(), body: { code: await screenCode() } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'TOKEN_MISSING');
});

test('one account is paused after ten tries in a minute; another is not', async () => {
  const eager = await person();
  const other = await person();
  for (let i = 0; i < 10; i += 1) {
    const res = await checkIn(eager, { code: 'not-a-code' });
    assert.equal(res.status, 400, `try ${i + 1}: ${JSON.stringify(res.body)}`);
  }
  const paused = await checkIn(eager, { code: await screenCode() });
  assert.equal(paused.status, 429, JSON.stringify(paused.body));
  assert.equal(paused.body.success, false);
  assert.equal(paused.body.code, 'CHECKIN_PAUSED');
  assert.ok(paused.body.retry_after >= 1 && paused.body.retry_after <= 60, String(paused.body.retry_after));
  assert.equal(paused.headers.get('retry-after'), String(paused.body.retry_after));
  assert.deepEqual(await visitsOf(eager), []);

  const fine = await checkIn(other, { code: await screenCode() });
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.equal(fine.body.success, true);
});

test('the desk punch says "ignored" for a repeat scan too, and cannot claim a desk code', async () => {
  const fay = await person();
  const punch = (body) => send('POST', '/api/desktop/punch', { headers: asDesk(), body: { person_type: 'member', person_id: String(fay._id), ...body } });

  const first = await punch({ method: 'fingerprint' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.success, true);
  assert.equal(first.body.ignored, undefined);

  const repeat = await punch({ method: 'fingerprint' });
  assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
  assert.equal(repeat.body.success, false);
  assert.equal(repeat.body.ignored, true);
  assert.equal(repeat.body.message, 'Already checked in a moment ago.');

  const claimed = await punch({ method: 'desk_code' });
  assert.equal(claimed.status, 400, JSON.stringify(claimed.body));
  assert.equal((await visitsOf(fay)).length, 1);
});
