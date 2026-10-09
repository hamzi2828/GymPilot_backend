// What the desk says about three members it used to get wrong: a card
// subscriber in the gap between their term ending and Stripe's payment
// landing, a member back from a freeze the daily job has not resumed yet,
// and a member whose expired or frozen membership sat behind a PT pack.
// Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { membershipFromOrders, membershipsFromOrders } = require('../../src/attendance/services/peopleDirectory');
const { membershipVerdict } = require('../../src/attendance/services/punchService');
const { STRIPE_SETTLE_DAYS } = require('../../src/gymfolio/services/membershipExpiry');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date('2026-09-21T12:00:00Z');
const at = (ms) => new Date(now.getTime() + ms);

let nextId = 1;
const oid = () => (nextId++).toString(16).padStart(24, '0');

function order({ endIn = 20 * DAY, status = 'active', kind, card = false, subscription = {}, freeze, sessions, createdAgo = 30 * DAY } = {}) {
  return {
    _id: oid(),
    userId: 'u1',
    packageDetails: { name: kind === 'pt_pack' ? 'PT x10' : 'Monthly', ...(kind ? { kind } : {}) },
    payment: { status: 'paid', ...(card ? { stripeSubscriptionId: 'sub_1' } : {}) },
    subscription: {
      startDate: at(Math.min(endIn - 30 * DAY, -DAY)),
      endDate: at(endIn),
      ...(card ? { autoRenew: true, stripeStatus: 'active' } : {}),
      ...subscription
    },
    sessions,
    freeze,
    status,
    createdAt: at(-createdAgo)
  };
}

// As membershipFor hands them over: newest end date first.
const answer = (...orders) =>
  membershipFromOrders(orders.slice().sort((a, b) => b.subscription.endDate - a.subscription.endDate), null, now);

test('a card subscriber is not told "expired" while Stripe\'s renewal payment is on its way', () => {
  assert.equal(STRIPE_SETTLE_DAYS, 2, 'the allowance is the expiry sweep\'s own');

  // The term ended an hour ago; invoice.paid has not arrived yet.
  const justEnded = answer(order({ endIn: -HOUR, card: true }));
  assert.equal(justEnded.status, 'active');
  assert.notEqual(membershipVerdict({ ...justEnded, autoRenews: true }).status, 'membership_expired');
  assert.equal(membershipVerdict({ ...justEnded, autoRenews: true }).status, 'membership_active');

  // Still inside the two days Stripe may take over a retried card.
  assert.equal(answer(order({ endIn: -(STRIPE_SETTLE_DAYS * DAY - HOUR), card: true })).status, 'active');
  // Past them, it has lapsed like any other.
  assert.equal(answer(order({ endIn: -(STRIPE_SETTLE_DAYS * DAY + HOUR), card: true })).status, 'expired');

  // A failed charge Stripe is retrying reads as that, not as a lapse.
  assert.equal(answer(order({ endIn: -HOUR, card: true, status: 'past_due', subscription: { stripeStatus: 'past_due' } })).status, 'past_due');
});

test('the allowance is only for a subscription that is still going to renew', () => {
  // Cash, or a bank transfer: nothing is on its way.
  assert.equal(answer(order({ endIn: -HOUR })).status, 'expired');
  // A card subscription that has been told to stop ends on its end date.
  assert.equal(answer(order({ endIn: -HOUR, card: true, subscription: { cancelAtPeriodEnd: true } })).status, 'expired');
  assert.equal(answer(order({ endIn: -HOUR, card: true, subscription: { autoRenew: false } })).status, 'expired');
  for (const stripeStatus of ['canceled', 'unpaid', 'paused', 'incomplete_expired']) {
    assert.equal(answer(order({ endIn: -HOUR, card: true, subscription: { stripeStatus } })).status, 'expired', stripeStatus);
  }
  // Decisions somebody made are not undone by it either.
  assert.equal(answer(order({ endIn: -HOUR, card: true, status: 'cancelled' })).status, 'expired');
  assert.equal(answer(order({ endIn: -HOUR, card: true, status: 'suspended' })).status, 'suspended');
});

test('a freeze that has run its course no longer reads "frozen"', () => {
  const frozen = (resumeIn) => order({ status: 'frozen', freeze: { isFrozen: true, resumeAt: resumeIn === null ? null : at(resumeIn) } });

  assert.equal(answer(frozen(3 * DAY)).status, 'frozen', 'still inside the freeze');
  // Resumes at 09:00, the member walks in at noon, the daily job runs tonight.
  const back = answer(frozen(-3 * HOUR));
  assert.equal(back.status, 'active');
  assert.equal(membershipVerdict(back).status, 'membership_active');
  // A freeze with no end set is frozen until somebody resumes it.
  assert.equal(answer(frozen(null)).status, 'frozen');
  assert.equal(answer(order({ status: 'frozen' })).status, 'frozen', 'from before the freeze kept its dates');
});

test('a PT pack does not speak for an expired or frozen membership at the door', () => {
  const pack = () => order({ kind: 'pt_pack', endIn: 60 * DAY, sessions: { total: 10, used: 2 }, createdAgo: 5 * DAY });

  // The pack ends later than anything else, and used to lead.
  const lapsed = answer(order({ kind: 'membership', endIn: -5 * DAY }), pack());
  assert.equal(lapsed.status, 'expired');
  assert.equal(lapsed.packageName, 'Monthly');
  assert.equal(lapsed.sessionsLeft, null);

  assert.equal(answer(order({ status: 'frozen', freeze: { resumeAt: at(4 * DAY) } }), pack()).status, 'frozen');
  // An order from before packages had a kind is a membership.
  assert.equal(answer(order({ endIn: -5 * DAY }), pack()).status, 'expired');

  // A running membership beside the pack is described as the membership.
  const running = answer(order({ kind: 'membership', endIn: 12 * DAY }), pack());
  assert.equal(running.status, 'active');
  assert.equal(running.packageName, 'Monthly');

  // Someone whose only orders are PT packs is answered from them, as before.
  const ptOnly = answer(pack());
  assert.equal(ptOnly.status, 'active');
  assert.equal(ptOnly.sessionsLeft, 8);

  // A class pack or a day pass is a way in, and still leads when it ends last.
  const classPack = answer(order({ kind: 'membership', endIn: -5 * DAY }), order({ kind: 'session_pack', endIn: 40 * DAY, sessions: { total: 10, used: 1 } }));
  assert.equal(classPack.status, 'active');
  assert.equal(classPack.sessionsLeft, 9);
});

test('the office\'s page of members reaches the same three verdicts', () => {
  const who = { _id: 'u1', email: 'ann@gym.test' };
  const page = (...orders) => membershipsFromOrders([who], orders, [], now).get('u1').status;
  assert.equal(page(order({ endIn: -HOUR, card: true })), 'active');
  assert.equal(page(order({ status: 'frozen', freeze: { resumeAt: at(-HOUR) } })), 'active');
  assert.equal(page(order({ kind: 'pt_pack', endIn: 60 * DAY, sessions: { total: 10, used: 2 } }), order({ endIn: -5 * DAY })), 'expired');
});
