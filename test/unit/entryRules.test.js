// The gym's entry rules (punchService entryRefusal) against an order still
// waiting for its money, without a database. Such an order leads the desk's
// verdict ("Awaiting payment confirmation"), but it is not money the gym has:
// with `unpaid` on it counts as unpaid, and `expired` and `noPackage` are
// judged on the paid orders beneath it (peopleDirectory's `paidTerm`), so
// ordering a renewal and not paying for it is no way past either. A paid
// membership that only starts later is none of these. The same through a
// desk punch is in test/integration/deskEntryRules.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { entryRefusal, membershipVerdict } = require('../../src/attendance/services/punchService');
const { membershipFromOrders } = require('../../src/attendance/services/peopleDirectory');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-19T12:00:00Z');
const ALL = { expired: true, unpaid: true, noPackage: true };

let seq = 0;
function order({ startIn = -30, endIn = 30, paid = true, status = 'active', createdIn = -30 } = {}) {
  seq += 1;
  return {
    _id: `0000000000000000000000${String(seq).padStart(2, '0')}`,
    userId: '0000000000000000000000aa',
    packageDetails: { name: 'Monthly' },
    subscription: { startDate: new Date(now.getTime() + startIn * DAY), endDate: new Date(now.getTime() + endIn * DAY) },
    status: paid ? status : 'pending',
    createdAt: new Date(now.getTime() + createdIn * DAY),
    payment: paid ? { status: 'paid', method: 'cash' } : { status: 'pending', method: 'bank_transfer' }
  };
}

// What memberStanding hands entryRefusal, from the same orders.
function standing(paidOrders, unpaid = null) {
  const membership = membershipFromOrders(paidOrders, unpaid, now);
  return {
    verdict: membershipVerdict(membership),
    membership: { startsOn: membership.startsOn || null, balanceDue: membership.balanceDue || 0, currency: membership.currency || '' },
    daysLeft: membership.daysLeft ?? null,
    paidTerm: membership.paidTerm || null
  };
}

test('a renewal awaiting payment does not hide that the paid term has run out', () => {
  const lapsed = order({ startIn: -90, endIn: -60, createdIn: -90 });
  const renewal = order({ paid: false, createdIn: -1 });
  const member = standing([lapsed], renewal);

  assert.equal(member.verdict.status, 'membership_pending', 'the desk still says it is awaiting payment');
  assert.equal(member.verdict.label, 'Awaiting payment confirmation');
  assert.equal(member.paidTerm.status, 'expired');

  assert.deepEqual(entryRefusal(member, { expired: true }), { reason: 'expired', text: 'Membership expired — renewal not paid yet' });
  assert.deepEqual(entryRefusal(member, { unpaid: true }), { reason: 'unpaid', text: 'Payment not confirmed' });
  assert.deepEqual(entryRefusal(member, ALL), { reason: 'expired', text: 'Membership expired — renewal not paid yet' });
  assert.equal(entryRefusal(member, { noPackage: true }), null, 'they have had a package');
  assert.equal(entryRefusal(member, {}), null, 'rules off: let in with the warning, as before');
});

test('an order awaiting payment with nothing ever paid is unpaid, and no paid package', () => {
  const member = standing([], order({ paid: false, createdIn: -1 }));
  assert.equal(member.verdict.status, 'membership_pending');
  assert.equal(member.paidTerm.status, 'none');

  assert.deepEqual(entryRefusal(member, { unpaid: true }), { reason: 'unpaid', text: 'Payment not confirmed' });
  assert.deepEqual(entryRefusal(member, { noPackage: true }), { reason: 'no_package', text: 'No paid membership — payment not confirmed' });
  assert.equal(entryRefusal(member, { expired: true }), null, 'nothing has expired');
});

test('a paid membership that starts later is not unpaid, expired or missing', () => {
  const lapsed = order({ startIn: -90, endIn: -60, createdIn: -90 });
  const next = order({ startIn: 3, endIn: 33, createdIn: -1 });
  for (const member of [standing([next]), standing([next, lapsed])]) {
    assert.equal(member.verdict.status, 'membership_pending');
    assert.match(member.verdict.label, /^Starts on /);
    assert.equal(member.paidTerm, null);
    assert.equal(entryRefusal(member, ALL), null);
  }
});

test('a paid term still running beneath the order awaiting payment covers today', () => {
  // Cancelled, so not "live" -- but paid, and with days left on it.
  const cancelled = order({ startIn: -20, endIn: 10, status: 'cancelled', createdIn: -20 });
  const member = standing([cancelled], order({ paid: false, createdIn: -1 }));
  assert.equal(member.verdict.status, 'membership_pending');
  assert.equal(member.paidTerm.status, 'cancelled');
  assert.equal(entryRefusal(member, ALL), null);
});

test('an order awaiting payment OLDER than the paid term is not what the desk describes', () => {
  const pending = order({ paid: false, createdIn: -120 });
  const lapsed = order({ startIn: -90, endIn: -60, createdIn: -90 });
  const member = standing([lapsed], pending);
  assert.equal(member.verdict.status, 'membership_expired');
  assert.deepEqual(entryRefusal(member, { expired: true }), { reason: 'expired', text: 'Membership expired' });
  assert.equal(entryRefusal(member, { unpaid: true }), null, 'the old pending order was never what it was judged on');
});

test('a paid, running membership is let in whatever order waits behind it', () => {
  const running = order({ startIn: -10, endIn: 20, createdIn: -10 });
  const member = standing([running], order({ paid: false, createdIn: -1 }));
  assert.equal(member.verdict.status, 'membership_active');
  assert.equal(member.paidTerm, null);
  assert.equal(entryRefusal(member, ALL), null);
});
