// The office's live view of today (services/liveBoard.js), without a
// database: which visits count as paid, the one-word status each row gets,
// and the day's counts -- members counted once, by their latest visit. The
// endpoint against a real MongoDB is in test/integration/attendance.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { PAID_MEMBERSHIP, isPaidVisit, standingOf, tally } = require('../../src/attendance/services/liveBoard');

let nextId = 1;
const oid = () => (nextId++).toString(16).padStart(24, '0');
const at = (hhmm) => new Date(`2026-09-21T${hhmm}:00Z`);

// A member's visit as the punch stores it.
function visit(membershipStatus, status, { balanceDue = 0, personId = oid(), checkInAt = at('09:00'), open = false } = {}) {
  return {
    personType: 'member',
    personId,
    checkInAt,
    status,
    statusLabel: status,
    membership: { status: membershipStatus, packageName: 'Monthly', balanceDue, currency: 'GBP' },
    open
  };
}

test('paid means walked in on a paid membership still running; everything else is unpaid', () => {
  assert.deepEqual(Array.from(PAID_MEMBERSHIP).sort(), ['active', 'cancelled', 'frozen']);
  assert.equal(isPaidVisit(visit('active', 'membership_active')), true);
  assert.equal(isPaidVisit(visit('active', 'membership_expiring')), true, 'expiring is still paid');
  assert.equal(isPaidVisit(visit('frozen', 'membership_frozen')), true);
  assert.equal(isPaidVisit(visit('cancelled', 'membership_cancelled')), true, 'cancelled, still running');
  for (const status of ['expired', 'none', 'past_due', 'pending', 'suspended']) {
    assert.equal(isPaidVisit(visit(status, `membership_${status}`)), false, status);
  }
  assert.equal(isPaidVisit({ personType: 'member', status: '' }), false, 'a row with no membership snapshot');
  assert.equal(isPaidVisit({ personType: 'staff', status: 'late' }), false, 'staff are neither');
});

test('the status column: one word, a problem before money owed, money owed before "expiring"', () => {
  assert.deepEqual(standingOf(visit('active', 'membership_active')), { key: 'paid', label: 'Paid' });
  assert.deepEqual(standingOf(visit('active', 'membership_expiring')), { key: 'expiring', label: 'Expiring' });
  assert.deepEqual(standingOf(visit('active', 'membership_expiring', { balanceDue: 25 })), {
    key: 'balance_due',
    label: 'Balance due £25'
  });
  assert.deepEqual(standingOf(visit('frozen', 'membership_frozen', { balanceDue: 25 })), { key: 'frozen', label: 'Frozen' });
  assert.deepEqual(standingOf(visit('cancelled', 'membership_cancelled')), { key: 'cancelled', label: 'Cancelled' });
  assert.deepEqual(standingOf(visit('expired', 'membership_expired', { balanceDue: 25 })), { key: 'unpaid', label: 'Unpaid' });
  assert.deepEqual(standingOf(visit('none', 'membership_none')), { key: 'unpaid', label: 'Unpaid' });
  assert.deepEqual(standingOf(visit('suspended', 'membership_suspended')), { key: 'suspended', label: 'Suspended' });

  // Staff: the desk's own words for the shift -- how it ended, once it has.
  assert.deepEqual(standingOf({ personType: 'staff', status: 'late', statusLabel: 'Late by 12 m' }), {
    key: 'staff',
    label: 'Late by 12 m'
  });
  assert.deepEqual(
    standingOf({ personType: 'staff', status: 'late', statusLabel: 'Late by 12 m', checkOutAt: at('17:00'), departureStatus: 'overtime', departureLabel: 'Overtime 30 m' }),
    { key: 'staff', label: 'Overtime 30 m' }
  );
});

test("the day's counts: visits and who is in, members once each by their latest visit", () => {
  const regular = oid();
  const rows = [
    // Scanned in twice (a gym where members only scan in): first on an
    // expired package, then again after renewing at the desk. One member,
    // counted by the later visit -- paid.
    visit('expired', 'membership_expired', { personId: regular, checkInAt: at('08:00') }),
    visit('active', 'membership_active', { personId: regular, checkInAt: at('10:00'), open: true }),
    visit('active', 'membership_active', { balanceDue: 25, checkInAt: at('09:00'), open: true }),
    visit('none', 'membership_none', { checkInAt: at('09:30') }),
    { personType: 'staff', personId: oid(), checkInAt: at('07:00'), status: 'on_time', open: true }
  ];

  assert.deepEqual(tally(rows, (row) => row.open === true), {
    visits: 5,
    members: 3,
    staff: 1,
    in_now: 3,
    paid: 2,
    unpaid: 1,
    balance_due: 1
  });
  assert.deepEqual(tally([], () => false), { visits: 0, members: 0, staff: 0, in_now: 0, paid: 0, unpaid: 0, balance_due: 0 });
});

test('a membership that had not started yet: counted unpaid, but called "Not started", not "Unpaid"', () => {
  const early = visit('pending', 'membership_pending');
  early.membership.startsOn = at('00:00');
  assert.equal(isPaidVisit(early), false);
  assert.deepEqual(standingOf(early), { key: 'unpaid', label: 'Not started' });
  assert.deepEqual(standingOf(visit('pending', 'membership_pending')), { key: 'unpaid', label: 'Unpaid' }, 'a transfer awaited');
  assert.equal(tally([early], () => false).unpaid, 1);
});
