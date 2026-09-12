// The front-desk verdict for every membership status membershipFor can
// answer. Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const { membershipVerdict } = require('../../src/attendance/services/punchService');
const Attendance = require('../../src/attendance/models/attendanceModel');
const ClassBooking = require('../../src/gymfolio/models/classBookingModel');

const STATUSES = ['active', 'expiring', 'expired', 'none', 'frozen', 'past_due', 'pending', 'suspended', 'cancelled'];

function verdict(status, extra = {}) {
  return membershipVerdict({ status, orderId: null, packageName: 'Monthly', endDate: null, daysLeft: null, sessionsLeft: null, ...extra });
}

test('every membership status gets its own verdict key and a label', () => {
  const keys = new Map();
  for (const status of STATUSES) {
    const v = verdict(status, { daysLeft: 20 });
    assert.equal(typeof v.status, 'string', status);
    assert.match(v.status, /^membership_/, status);
    assert.ok(v.label && v.label.length > 0, `${status} has a label`);
    assert.ok('warning' in v, `${status} carries a warning field`);
    keys.set(status, v.status);
  }
  // Only the statuses that genuinely mean the same thing at the desk share a key.
  assert.equal(keys.get('active'), 'membership_active');
  assert.equal(keys.get('expiring'), 'membership_expiring');
  assert.equal(keys.get('expired'), 'membership_expired');
  assert.equal(keys.get('none'), 'membership_none');
  assert.equal(keys.get('frozen'), 'membership_frozen');
  assert.equal(keys.get('past_due'), 'membership_past_due');
  assert.equal(keys.get('pending'), 'membership_pending');
  assert.equal(keys.get('suspended'), 'membership_suspended');
  assert.equal(keys.get('cancelled'), 'membership_cancelled');
});

test('the attendance and booking snapshots can store every status the verdict handles', async () => {
  const gym = { _id: '000000000000000000000001', slug: 'unit-gym', database: { name: 'gympilot_unit_gym' }, domains: [], locale: { timezone: 'UTC' } };
  await runWithTenant(gym, async () => {
    const stored = Attendance.schema.path('membership.status').enumValues;
    const booked = ClassBooking.schema.path('membershipStatus').enumValues;
    for (const status of STATUSES) {
      assert.ok(stored.includes(status), `attendance enum has ${status}`);
      assert.ok(booked.includes(status), `booking enum has ${status}`);
    }
  });
});

test('active memberships turn amber inside the warning window and stay green outside it', () => {
  assert.equal(verdict('active', { daysLeft: 30 }).status, 'membership_active');
  assert.equal(verdict('active', { daysLeft: 30 }).warning, null);
  assert.equal(verdict('active', { daysLeft: 30 }).label, 'Active · 30 days left');
  assert.equal(verdict('active', { daysLeft: 3 }).status, 'membership_expiring');
  assert.match(verdict('active', { daysLeft: 3 }).warning, /EXPIRES IN 3 DAYS/);
  assert.equal(verdict('active', { daysLeft: 1 }).label, '1 day left');
  assert.equal(verdict('active').label, 'Active');
});

test('session packs report sessions, not days, and warn when nearly used up', () => {
  assert.equal(verdict('active', { daysLeft: 60, sessionsLeft: 8 }).label, '8 sessions left');
  assert.equal(verdict('active', { daysLeft: 60, sessionsLeft: 8 }).status, 'membership_active');
  const low = verdict('active', { daysLeft: 60, sessionsLeft: 1 });
  assert.equal(low.status, 'membership_expiring');
  assert.match(low.warning, /1 SESSION LEFT/);
});

test('an explicit expiring status is amber even without a day count', () => {
  assert.equal(verdict('expiring').status, 'membership_expiring');
  assert.equal(verdict('expiring', { daysLeft: 5 }).label, '5 days left');
});

test('expired says how long ago, and none says no package', () => {
  assert.equal(verdict('expired', { daysLeft: -4 }).label, 'Expired 4 days ago');
  assert.match(verdict('expired', { daysLeft: -4 }).warning, /EXPIRED/);
  assert.equal(verdict('expired').label, 'Expired');
  assert.equal(verdict('none').label, 'No package on file');
  assert.match(verdict('none').warning, /NO ACTIVE MEMBERSHIP/);
  // An unknown or missing status is never mistaken for an active one.
  assert.equal(membershipVerdict({}).status, 'membership_none');
  assert.equal(membershipVerdict(undefined).status, 'membership_none');
});

test('frozen, past due, pending and suspended each carry an actionable warning', () => {
  assert.equal(verdict('frozen').label, 'Frozen');
  assert.match(verdict('frozen').warning, /FROZEN/);
  assert.equal(verdict('past_due').label, 'Payment overdue');
  assert.match(verdict('past_due').warning, /PAYMENT FAILED/);
  assert.equal(verdict('pending').label, 'Awaiting payment confirmation');
  assert.match(verdict('pending').warning, /NOT CONFIRMED/);
  assert.equal(verdict('suspended').label, 'Suspended');
  assert.match(verdict('suspended').warning, /SUSPENDED/);
});

test('a cancelled membership with days left is never reported as expired', () => {
  const running = verdict('cancelled', { daysLeft: 12 });
  assert.equal(running.status, 'membership_cancelled');
  assert.equal(running.label, 'Cancelled · 12 days left');
  assert.match(running.warning, /ENDS IN 12 DAYS/);
  assert.doesNotMatch(running.label, /Expired/);

  const over = verdict('cancelled', { daysLeft: -2 });
  assert.equal(over.status, 'membership_cancelled');
  assert.equal(over.label, 'Cancelled');
  assert.match(over.warning, /CANCELLED/);
});
