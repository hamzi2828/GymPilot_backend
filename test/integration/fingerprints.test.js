// The admin fingerprint tool against a real MongoDB: the list groups the
// fingers on file per person, names a member, a staff account and a Trainer,
// and flags a template this gym can no longer decrypt (one written under
// another gym's key) and a finger whose owner is gone. Removing one finger or
// all of them deletes exactly those rows and leaves the person's consent
// alone. Then the same thing over HTTP, through the attendance router and
// allRoutes mounted in index.js's order: a view-only role can list but not
// remove, a manage role can, and the audit trail records which finger went.

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let otherGym;
let User;
let Trainer;
let Fingerprint;
let AdminAuditLog;
let admin;
let member;
let staffUser;
let trainer;
let coach;
let desk;
let ghostId;
const PLAIN = 'SU5URUdSQVRJT04tVEVNUExBVEU=';

const test = h.suite(async () => {
  User = h.src('models/user');
  Trainer = h.src('gymfolio/models/trainerModel');
  Fingerprint = h.src('attendance/models/fingerprintModel');
  AdminAuditLog = h.src('models/adminAuditLogModel');
  admin = h.src('attendance/controller/fingerprintAdminController');

  gym = await h.createGym('fingerprint-gym');
  otherGym = await h.createGym('fingerprint-other');

  // A template this gym cannot open: encrypted under the other gym's key,
  // which is what a changed FINGERPRINT_ENCRYPTION_KEY looks like too.
  const foreign = await h.inGym(otherGym, async () => Fingerprint.encryptTemplate(PLAIN));

  await h.inGym(gym, async () => {
    await h.ensureIndexes(Fingerprint, User, Trainer);
    await h.src('services/roleService').ensureDefaultRoles();

    const consent = { biometric: { given: true, at: new Date(), source: 'desk', version: '2026-09' } };
    member = await User.create({ firstName: 'Mia', lastName: 'Member', email: 'mia@fingerprints.test', memberCode: 'GP-0101', consents: consent });
    staffUser = await User.create({
      firstName: 'Sam',
      lastName: 'Staff',
      email: 'sam@fingerprints.test',
      role: 'receptionist',
      staffCode: 'TR-0102',
      employment: { isStaff: true, jobTitle: 'Reception' },
      consents: consent
    });
    trainer = await Trainer.create({ name: 'Tara Trainer', email: 'tara@fingerprints.co', role: 'Coach', staffCode: 'TR-0103' });
    // The two admin-panel accounts the HTTP test signs in as.
    coach = await User.create({ firstName: 'Cal', lastName: 'Coach', email: 'cal@fingerprints.test', role: 'trainer', employment: { isStaff: true } });
    desk = await User.create({ firstName: 'Dee', lastName: 'Desk', email: 'dee@fingerprints.test', role: 'receptionist', employment: { isStaff: true } });
    ghostId = new h.state.mongoose.Types.ObjectId();

    const finger = (personType, personId, fingerIndex, template = Fingerprint.encryptTemplate(PLAIN)) => ({
      personType,
      personId,
      fingerIndex,
      template,
      samplesAccepted: 4,
      samplesTotal: 4,
      enrolledByName: 'Front Desk',
      enrolledDevice: 'DESK-1'
    });
    await Fingerprint.create([
      finger('member', member._id, 1),
      finger('member', member._id, 2),
      finger('member', member._id, 7, foreign),
      finger('staff', staffUser._id, 1),
      finger('staff', trainer._id, 1),
      finger('staff', trainer._id, 6),
      // Linked to an account that has since been deleted.
      finger('member', ghostId, 3)
    ]);
  });
});

async function list(query = {}) {
  const res = await h.call(admin.list, { query });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

const byId = (body, id) => body.people.find((person) => person.person_id === String(id));

test('the list: one row per person, every owner named, and the unreadable finger found', async () => {
  await h.inGym(gym, async () => {
    const body = await list();
    assert.deepEqual(body.summary, { people: 4, fingers: 7, unreadable: 1, departed: 1 });
    assert.deepEqual(body.people.map((p) => p.name), ['Mia Member', 'Sam Staff', 'Tara Trainer', 'Deleted member']);

    const mia = byId(body, member._id);
    assert.deepEqual(
      mia.fingers.map((f) => [f.finger_index, f.finger_name, f.readable]),
      [[1, 'Right Thumb', true], [2, 'Right Index', true], [7, 'Left Index', false]]
    );
    assert.deepEqual([mia.person_type, mia.code, mia.record, mia.status, mia.unreadable], ['member', 'GP-0101', 'user', 'active', 1]);
    assert.equal(mia.fingers[0].enrolled_by, 'Front Desk');
    assert.ok(mia.fingers[0].enrolled_at);

    const sam = byId(body, staffUser._id);
    assert.deepEqual([sam.person_type, sam.code, sam.record, sam.status], ['staff', 'TR-0102', 'user', 'active']);
    const tara = byId(body, trainer._id);
    assert.deepEqual([tara.person_type, tara.code, tara.record, tara.fingers.length], ['staff', 'TR-0103', 'trainer', 2]);
    const ghost = byId(body, ghostId);
    assert.deepEqual([ghost.record, ghost.status], [null, 'missing']);

    const text = JSON.stringify(body);
    assert.ok(!text.includes('template'), 'no template field goes out');
    assert.ok(!text.includes(PLAIN), 'nothing decrypted goes out');

    assert.deepEqual((await list({ show: 'unreadable' })).people.map((p) => p.name), ['Mia Member']);
    assert.deepEqual((await list({ q: 'tr-0103' })).people.map((p) => p.name), ['Tara Trainer']);
    assert.deepEqual((await list({ person_type: 'staff' })).people.map((p) => p.name), ['Sam Staff', 'Tara Trainer']);
  });
});

test('a deactivated trainer is still listed, as one the desk no longer matches', async () => {
  await h.inGym(gym, async () => {
    await Trainer.updateOne({ _id: trainer._id }, { $set: { isActive: false } });
    try {
      const body = await list({ show: 'departed' });
      assert.deepEqual(body.people.map((p) => [p.name, p.status]), [['Tara Trainer', 'inactive'], ['Deleted member', 'missing']]);
    } finally {
      await Trainer.updateOne({ _id: trainer._id }, { $set: { isActive: true } });
    }
  });
});

test('removing one finger removes that finger only, and the member keeps their consent', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(admin.remove, { params: { personType: 'member', personId: String(member._id) }, query: { finger: '7' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.removed, 1);
    assert.equal(res.body.data.remaining, 2);
    assert.match(res.body.message, /Mia Member's left index/);

    const left = await Fingerprint.find({ personId: member._id }).lean();
    assert.deepEqual(left.map((f) => f.fingerIndex).sort(), [1, 2]);
    const after = await User.findById(member._id).lean();
    assert.equal(after.consents.biometric.given, true, 'consent is not withdrawn by removing a finger');
    assert.equal(after.isActive, true);

    const again = await h.call(admin.remove, { params: { personType: 'member', personId: String(member._id), finger: '7' }, query: {} });
    assert.equal(again.statusCode, 404);

    const body = await list();
    assert.equal(body.summary.unreadable, 0);
    assert.equal(body.summary.fingers, 6);
  });
});

test('removing every finger works for a Trainer, a staff account and an owner who is gone', async () => {
  await h.inGym(gym, async () => {
    for (const [personType, personId, count] of [
      ['staff', trainer._id, 2],
      ['staff', staffUser._id, 1],
      ['member', ghostId, 1]
    ]) {
      const res = await h.call(admin.remove, { params: { personType, personId: String(personId) }, query: {} });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.removed, count);
      assert.equal(res.body.data.remaining, 0);
      assert.equal(await Fingerprint.countDocuments({ personId }), 0);
    }
    assert.equal(await Trainer.countDocuments({ _id: trainer._id }), 1, 'the trainer stays; only the fingers go');
    assert.equal((await User.findById(staffUser._id).lean()).consents.biometric.given, true);

    // The wrong type for an id removes nothing: a member's fingers are not a staff member's.
    const wrongType = await h.call(admin.remove, { params: { personType: 'staff', personId: String(member._id) }, query: {} });
    assert.equal(wrongType.statusCode, 404);
    assert.equal(await Fingerprint.countDocuments({ personId: member._id }), 2);

    assert.deepEqual((await list()).people.map((p) => p.name), ['Mia Member']);
  });
});

test('over HTTP: a view role lists but cannot remove, a manage role removes, and the audit says which finger', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.tenant = gym;
    h.inGym(gym, async () => next()).catch(next);
  });
  // index.js's order: the read-only attendance router first, allRoutes after.
  app.use('/api/attendance', h.src('attendance/routes/adminRoutes'));
  app.use('/', h.src('routes/allRoutes'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/attendance/fingerprints`;
  const tokenFor = (user) =>
    jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const send = async (user, method, path = '') => {
    const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tokenFor(user)}` } });
    return { status: res.status, body: await res.json() };
  };

  try {
    const target = `/member/${member._id}/2`;

    const listed = await send(coach, 'GET', '?q=mia');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.people.map((p) => p.name), ['Mia Member']);

    const refused = await send(coach, 'DELETE', target);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(await h.inGym(gym, () => Fingerprint.countDocuments({ personId: member._id, fingerIndex: 2 })), 1);

    const removed = await send(desk, 'DELETE', target);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.data.finger_index, 2);
    assert.equal(await h.inGym(gym, () => Fingerprint.countDocuments({ personId: member._id })), 1);

    const bad = await send(desk, 'DELETE', `/member/${member._id}/12`);
    assert.equal(bad.status, 400);

    // Written after the response; give it a moment to land.
    let trail = [];
    for (let i = 0; i < 50 && !trail.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      trail = await h.inGym(gym, () => AdminAuditLog.find({ method: 'DELETE', status: 200 }).lean());
    }
    assert.ok(trail.length >= 1, 'the removal is in the audit trail');
    assert.ok(trail.every((row) => row.path === `/api/attendance/fingerprints${target}` && row.tab === 'attendance'));
    assert.equal(String(trail[0].actorId), String(desk._id));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
