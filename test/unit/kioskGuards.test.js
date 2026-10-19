// The web kiosk's guards: which tokens are kiosk tokens, the signed staff
// unlock that opens the people search and hand-picked punches there, the
// fingerprint endpoints no kiosk may call at all, the audit events for unlock
// attempts, and the cap on typed member numbers. Pure logic and middleware,
// no database.
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
  isSelfServicePunch,
  createPunchLimiter,
  limitCodePunches,
  CODE_PUNCH_LIMITS
} = require('../../src/attendance/middleware/desktopAuth');
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

test('on a kiosk, the people list and hand-picked punches need the unlock; QR and codes do not', async () => {
  const people = kioskStaffOnly();
  const punch = kioskStaffOnly(isSelfServicePunch);

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

    // A member checking themselves in.
    assert.equal(run(punch, { desktopToken: kioskToken, body: { qr: 'GPQ1.member.x.1.sig' } }).passed, true);
    assert.equal(run(punch, { desktopToken: kioskToken, body: { code: 'GP-0001' } }).passed, true);

    // Picking somebody -- whatever method it claims -- is staff only.
    for (const method of ['manual', 'fingerprint', undefined]) {
      const body = { person_type: 'member', person_id: '6a9e47dadf00918e9825a7ff', method };
      assert.equal(run(punch, { desktopToken: kioskToken, body }).res.statusCode, 423, String(method));
      assert.equal(run(punch, { desktopToken: kioskToken, body: { ...body, staff_unlock: grant } }).passed, true);
    }
  });
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

test('the routes: templates and enrolment carry the kiosk refusal, and nothing else does', () => {
  const chains = new Map(
    desktopRoutes.stack
      .filter((layer) => layer.route)
      .map((layer) => [layer.route.path, layer.route.stack.map((step) => step.name)])
  );

  assert.deepEqual(chains.get('/templates'), ['desktopAuth', 'notOnKiosk', 'templates']);
  // Refused before the enrolment grant is even asked about.
  assert.deepEqual(chains.get('/enroll'), ['desktopAuth', 'notOnKiosk', 'requireEnrollPermission', 'enroll']);

  for (const path of ['/session', '/logout', '/recent', '/unlock', '/people', '/punch', '/checkin-code']) {
    assert.ok(chains.has(path), path);
    assert.ok(!chains.get(path).includes('notOnKiosk'), `${path} stays open to a kiosk`);
  }

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

test('the punch limiter allows a queue at the door and refuses a run of guesses', () => {
  let clock = 0;
  const limiter = createPunchLimiter(CODE_PUNCH_LIMITS, () => clock);

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
  const sustained = createPunchLimiter(CODE_PUNCH_LIMITS, () => clock2);
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

test('typed codes are capped per desk token with a clear 429; QR codes and picks are not', async () => {
  await runWithTenant(gymA, () => {
    const token = { _id: '6a9e47dadf00918e9825a7aa', clientApp: 'GymPilotKiosk/1.0' };
    for (let i = 0; i < 12; i++) {
      assert.equal(run(limitCodePunches, { desktopToken: token, body: { code: 'GP-' + i } }).passed, true);
    }

    const blocked = run(limitCodePunches, { desktopToken: token, body: { code: 'GP-0099' } });
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.equal(blocked.res.body.code, 'CODE_ENTRY_PAUSED');
    assert.match(blocked.res.body.message, /Too many member numbers/);
    assert.match(blocked.res.body.message, /QR code/);
    assert.ok(Number(blocked.res.headers['Retry-After']) >= 1);

    // Not typed numbers: never counted, never refused.
    assert.equal(run(limitCodePunches, { desktopToken: token, body: { qr: 'GPQ1.x', code: 'GP-1' } }).passed, true);
    assert.equal(run(limitCodePunches, { desktopToken: token, body: { person_type: 'member', person_id: 'x' } }).passed, true);

    // Another desk token is unaffected.
    const other = { _id: '6a9e47dadf00918e9825a7ab', clientApp: 'GymPilotKiosk/1.0' };
    assert.equal(run(limitCodePunches, { desktopToken: other, body: { code: 'GP-0001' } }).passed, true);
  });
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
