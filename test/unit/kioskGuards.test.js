// The web kiosk's guards: which tokens are kiosk tokens, the signed staff
// unlock that opens the people search and every punch there, the biometric
// endpoints no kiosk may call at all, the audit events for unlock attempts,
// the refusal of the retired member QR and member number, and the cap on a
// phone checking in with the desk's code. Pure logic and middleware, no
// database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const {
  isKioskToken,
  issueStaffUnlock,
  verifyStaffUnlock,
  kioskStaffOnly,
  notOnKiosk,
  refuseRemovedMethods,
  createPunchLimiter
} = require('../../src/attendance/middleware/desktopAuth');
const { limitCheckins } = require('../../src/attendance/controller/deskCodeController');
const desktopRoutes = require('../../src/attendance/routes/desktopRoutes');
const AttendanceLog = require('../../src/attendance/models/attendanceLogModel');

const gymA = { _id: '000000000000000000000001', slug: 'a', database: { name: 'gympilot_unit_a' } };
const gymB = { _id: '000000000000000000000002', slug: 'b', database: { name: 'gympilot_unit_b' } };

const kioskToken = { _id: '6a9e47dadf00918e9825a701', clientApp: 'GymPilotKiosk/1.0' };
const otherKiosk = { _id: '6a9e47dadf00918e9825a702', clientApp: 'GymPilotKiosk/1.0' };
const deskToken = { _id: '6a9e47dadf00918e9825a703', clientApp: 'GymPilotAttendanceDesktop/1.0' };

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    }
  };
}

// Runs one middleware; true when it passed the request on.
function run(middleware, req) {
  const res = fakeRes();
  let passed = false;
  middleware(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test('kiosk tokens are the ones the kiosk signed in with, and only those', () => {
  assert.equal(isKioskToken(kioskToken), true);
  assert.equal(isKioskToken({ clientApp: 'gympilotkiosk/2.0' }), true);
  assert.equal(isKioskToken(deskToken), false);
  assert.equal(isKioskToken({ clientApp: '' }), false);
  assert.equal(isKioskToken({ clientApp: 'Mozilla/5.0 GymPilotKiosk/1.0' }), false, 'a user agent merely mentioning it');
  assert.equal(isKioskToken(null), false);
});

test('a staff unlock verifies for the desk and gym it was issued to, until it expires', async () => {
  const issued = await runWithTenant(gymA, () => issueStaffUnlock(kioskToken._id));
  assert.match(issued.unlock, /^GPU1\.\d+\./);
  assert.ok(issued.expiresAt.getTime() > Date.now());
  assert.equal(issued.ttlSeconds, 600);

  await runWithTenant(gymA, () => {
    assert.equal(verifyStaffUnlock(issued.unlock, kioskToken._id), true);
    assert.equal(verifyStaffUnlock(issued.unlock, otherKiosk._id), false, 'another desk cannot use it');
    assert.equal(verifyStaffUnlock(issued.unlock.slice(0, -2) + 'xx', kioskToken._id), false, 'tampered');
    const [version, exp, sig] = issued.unlock.split('.');
    assert.equal(verifyStaffUnlock([version, String(Number(exp) + 3600), sig].join('.'), kioskToken._id), false, 'expiry pushed out');
    assert.equal(verifyStaffUnlock(issued.unlock, kioskToken._id, issued.expiresAt.getTime()), false, 'expired');
    assert.equal(verifyStaffUnlock('', kioskToken._id), false);
    assert.equal(verifyStaffUnlock('GPU1.abc.def', kioskToken._id), false);
    assert.equal(verifyStaffUnlock(undefined, kioskToken._id), false);
  });

  await runWithTenant(gymB, () => {
    assert.equal(verifyStaffUnlock(issued.unlock, kioskToken._id), false, 'another gym cannot honour it');
  });
});

test('on a kiosk, the people list and every punch need the unlock', async () => {
  const people = kioskStaffOnly();
  const punch = kioskStaffOnly();

  await runWithTenant(gymA, () => {
    const grant = issueStaffUnlock(kioskToken._id).unlock;

    // The Windows desk is behind the counter and never asked.
    assert.equal(run(people, { desktopToken: deskToken, body: {} }).passed, true);
    assert.equal(run(punch, { desktopToken: deskToken, body: { person_type: 'member', person_id: 'x' } }).passed, true);

    const locked = run(people, { desktopToken: kioskToken, body: { q: 'smith' } });
    assert.equal(locked.passed, false);
    assert.equal(locked.res.statusCode, 423, 'not 401/403, which a kiosk reads as "sign in again"');
    assert.equal(locked.res.body.code, 'STAFF_UNLOCK_REQUIRED');
    assert.equal(locked.res.body.success, false);

    assert.equal(run(people, { desktopToken: kioskToken, body: { q: 'smith', staff_unlock: grant } }).passed, true);
    assert.equal(run(people, { desktopToken: otherKiosk, body: { q: 'smith', staff_unlock: grant } }).passed, false);

    // Nothing a member does at a kiosk goes through /punch any more: their
    // phone checks them in. Whatever a punch carries, it is staff only.
    for (const body of [{ qr: 'GPQ1.member.x.1.sig' }, { code: 'GP-0001' }, {}]) {
      assert.equal(run(punch, { desktopToken: kioskToken, body }).res.statusCode, 423, JSON.stringify(body));
    }
    for (const method of ['manual', 'fingerprint', 'face', undefined]) {
      const body = { person_type: 'member', person_id: '6a9e47dadf00918e9825a7ff', method };
      assert.equal(run(punch, { desktopToken: kioskToken, body }).res.statusCode, 423, String(method));
      assert.equal(run(punch, { desktopToken: kioskToken, body: { ...body, staff_unlock: grant } }).passed, true);
    }
  });
});

test('a punch with the retired member QR or member number is told it was replaced, on any desk, before any unlock is asked', () => {
  for (const body of [{ qr: 'GPQ1.member.6a9e47dadf00918e9825a7ff.1.sig' }, { code: 'GP-0001' }, { code: 'TR-0003', person_type: 'staff' }]) {
    for (const token of [kioskToken, deskToken]) {
      const refused = run(refuseRemovedMethods, { desktopToken: token, body });
      assert.equal(refused.passed, false, JSON.stringify(body));
      assert.equal(refused.res.statusCode, 400);
      assert.deepEqual(refused.res.body, {
        success: false,
        code: 'METHOD_REMOVED',
        message: 'Member QR and member-number check-in have been replaced. Scan the code on the desk screen instead.'
      });
    }
  }
  // A person picked or matched passes on to the kiosk gate and the punch.
  for (const body of [{ person_type: 'member', person_id: '6a9e47dadf00918e9825a7ff', method: 'face' }, { qr: '', code: '' }, {}]) {
    assert.equal(run(refuseRemovedMethods, { desktopToken: kioskToken, body }).passed, true, JSON.stringify(body));
  }
});

test('a kiosk is refused the fingerprint endpoints outright, unlock or not; the Windows desk is not', async () => {
  await runWithTenant(gymA, () => {
    const grant = issueStaffUnlock(kioskToken._id).unlock;

    assert.equal(run(notOnKiosk, { desktopToken: deskToken, body: {} }).passed, true);

    for (const body of [{}, { staff_unlock: grant }]) {
      const refused = run(notOnKiosk, { desktopToken: kioskToken, body });
      assert.equal(refused.passed, false);
      assert.equal(refused.res.statusCode, 403);
      assert.equal(refused.res.body.success, false);
      assert.equal(refused.res.body.code, 'KIOSK_NOT_ALLOWED');
      assert.match(refused.res.body.message, /kiosk/i);
    }
  });
});

test('the routes: templates, faces and enrolment carry the kiosk refusal, and nothing else does', () => {
  const chains = new Map(
    desktopRoutes.stack
      .filter((layer) => layer.route)
      .map((layer) => [layer.route.path, layer.route.stack.map((step) => step.name)])
  );

  assert.deepEqual(chains.get('/templates'), ['desktopAuth', 'notOnKiosk', 'templates']);
  // Refused before the enrolment grant is even asked about.
  assert.deepEqual(chains.get('/enroll'), ['desktopAuth', 'notOnKiosk', 'requireEnrollPermission', 'enroll']);
  // Faces on the same terms as fingers.
  assert.deepEqual(chains.get('/face-templates'), ['desktopAuth', 'notOnKiosk', 'faceTemplates']);
  assert.deepEqual(chains.get('/face-enroll'), ['desktopAuth', 'notOnKiosk', 'requireEnrollPermission', 'faceEnroll']);
  assert.deepEqual(chains.get('/face-remove'), ['desktopAuth', 'notOnKiosk', 'requireEnrollPermission', 'faceRemove']);

  for (const path of ['/session', '/logout', '/recent', '/unlock', '/people', '/punch', '/checkin-code']) {
    assert.ok(chains.has(path), path);
    assert.ok(!chains.get(path).includes('notOnKiosk'), `${path} stays open to a kiosk`);
  }

  // A retired method is refused before the kiosk's unlock is asked for.
  assert.deepEqual(chains.get('/punch'), ['desktopAuth', 'refuseRemovedMethods', 'kioskStaffGate', 'punch']);

  // The screen's check-in code needs a desk token and nothing else: no unlock.
  assert.deepEqual(chains.get('/checkin-code'), ['desktopAuth', 'checkinCode']);
});

test('the audit trail can record staff unlock attempts, granted and refused', async () => {
  await runWithTenant(gymA, () => {
    const events = AttendanceLog.schema.path('event').enumValues;
    assert.ok(events.includes('staff_unlock'));
    assert.ok(events.includes('staff_unlock_denied'));
    // Nothing that was there before has gone.
    for (const event of ['login', 'login_denied', 'logout', 'template_download', 'enroll', 'punch', 'punch_denied']) {
      assert.ok(events.includes(event), event);
    }
  });
});

// Twelve a minute and sixty in ten: the limiter itself, whatever it caps.
const LIMITS = [
  { max: 12, windowMs: 60 * 1000 },
  { max: 60, windowMs: 10 * 60 * 1000 }
];

test('the punch limiter allows a queue at the door and refuses a run of guesses', () => {
  let clock = 0;
  const limiter = createPunchLimiter(LIMITS, () => clock);

  for (let i = 0; i < 12; i++) {
    assert.equal(limiter.take('desk-1').allowed, true, `code ${i + 1}`);
    clock += 1000;
  }
  const refused = limiter.take('desk-1');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 60 * 1000);

  // Another desk has its own count.
  assert.equal(limiter.take('desk-2').allowed, true);

  // Refused attempts are not counted, so waiting out the minute is enough.
  for (let i = 0; i < 5; i++) limiter.take('desk-1');
  clock += refused.retryAfterMs;
  assert.equal(limiter.take('desk-1').allowed, true);

  // Sustained: one every six seconds is inside the minute cap but not the
  // ten-minute one.
  let clock2 = 0;
  const sustained = createPunchLimiter(LIMITS, () => clock2);
  let allowed = 0;
  for (let i = 0; i < 100; i++) {
    if (sustained.take('desk').allowed) allowed++;
    clock2 += 6000;
  }
  assert.equal(allowed, 60, 'sixty in the first ten minutes, then refused until the window moves');

  // The sweep forgets desks that have gone quiet.
  clock2 += 11 * 60 * 1000;
  sustained.sweep();
  assert.equal(sustained.size(), 0);
});

test('a phone checking in with the desk code is paused after ten tries a minute, per account and per gym', async () => {
  const tries = (gym, userId) => runWithTenant(gym, () => run(limitCheckins, { user: { id: userId } }));
  const eager = '6a9e47dadf00918e9825c001';
  for (let i = 0; i < 10; i++) assert.equal((await tries(gymA, eager)).passed, true, `try ${i + 1}`);

  const paused = await tries(gymA, eager);
  assert.equal(paused.passed, false);
  assert.equal(paused.res.statusCode, 429);
  assert.equal(paused.res.body.code, 'CHECKIN_PAUSED');
  assert.equal(paused.res.body.success, false);
  assert.ok(paused.res.body.retry_after >= 1 && paused.res.body.retry_after <= 60);
  assert.equal(paused.res.headers['Retry-After'], String(paused.res.body.retry_after));

  // Somebody else, and the same id at another gym, are counted apart.
  assert.equal((await tries(gymA, '6a9e47dadf00918e9825c002')).passed, true);
  assert.equal((await tries(gymB, eager)).passed, true);
});

test("wrong unlock passwords count against the desk account they were typed for, not every kiosk in the gym", async () => {
  const bcrypt = require('bcryptjs');
  const controller = require('../../src/attendance/controller/desktopAppController');
  const User = require('../../src/models/user');

  const hash = await bcrypt.hash('the desk password', 4);
  const frontDesk = { _id: '6a9e47dadf00918e9825b001', email: 'front@gym-a.test', firstName: 'Front', lastName: 'Desk' };
  const backDesk = { _id: '6a9e47dadf00918e9825b002', email: 'back@gym-a.test', firstName: 'Back', lastName: 'Desk' };
  const unlock = async (desktopUser, password) => {
    const res = fakeRes();
    await controller.unlock({ body: { password }, desktopUser, desktopToken: kioskToken, deviceContext: { ip: '203.0.113.9', deviceLabel: 'kiosk', osUser: '', clientApp: 'GymPilotKiosk/1.0' } }, res);
    return res;
  };

  await runWithTenant(gymA, async () => {
    User.findById = () => ({ select: async () => ({ password: hash }) });
    AttendanceLog.record = async () => null;

    // Eight wrong guesses at the front desk's password lock the front desk...
    for (let i = 0; i < 8; i++) assert.equal((await unlock(frontDesk, 'a guess')).statusCode, 400, `guess ${i + 1}`);
    assert.equal((await unlock(frontDesk, 'the desk password')).statusCode, 429);

    // ...and only the front desk: the kiosk at the back still opens,
    const back = await unlock(backDesk, 'the desk password');
    assert.equal(back.statusCode, 200, JSON.stringify(back.body));
    // and its success does not wipe the front desk's count.
    assert.equal((await unlock(frontDesk, 'the desk password')).statusCode, 429);
  });
});
