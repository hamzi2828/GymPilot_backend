// The membership status the admin attendance roster shows is the one the
// front desk shows: membershipsFor (the roster's batched lookup) answers
// each member from exactly the orders membershipFor would have used, with the
// same rules. Pure logic, no database.
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

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-21T12:00:00Z');
const inDays = (days) => new Date(now.getTime() + days * DAY);

let nextId = 1;
const oid = () => (nextId++).toString(16).padStart(24, '0');

function user(email) {
  return { _id: oid(), email };
}

function order(owner, { status = 'active', endIn = 20, createdAgo = 10, sessions, email, byEmailOnly = false } = {}) {
  return {
    _id: oid(),
    userId: byEmailOnly ? null : owner._id,
    customerInfo: { email: email === undefined ? owner.email : email },
    packageDetails: { name: 'Monthly' },
    subscription: { endDate: endIn === null ? null : inDays(endIn) },
    sessions,
    status,
    createdAt: inDays(-createdAgo)
  };
}

function answer(owner, paid, unpaid = []) {
  return membershipsFromOrders([owner], paid, unpaid, now).get(String(owner._id));
}

test('a cancelled plan that is still running reads "cancelled, N days left", never "expired"', () => {
  const mia = user('mia@example.test');
  const m = answer(mia, [order(mia, { status: 'cancelled', endIn: 5 })]);
  assert.equal(m.status, 'cancelled');
  assert.equal(m.daysLeft, 5);

  const v = membershipVerdict(m);
  assert.equal(v.status, 'membership_cancelled');
  assert.equal(v.label, 'Cancelled · 5 days left');

  // Once it has run out, it is expired like any other.
  const ended = answer(mia, [order(mia, { status: 'cancelled', endIn: -3 })]);
  assert.equal(ended.status, 'expired');
  assert.equal(membershipVerdict(ended).label, 'Expired 3 days ago');
});

test('a suspended plan is suspended whatever its dates say, never "active"', () => {
  const sam = user('sam@example.test');
  const m = answer(sam, [order(sam, { status: 'suspended', endIn: 40 })]);
  assert.equal(m.status, 'suspended');
  assert.equal(membershipVerdict(m).label, 'Suspended');
  assert.equal(membershipVerdict(m).status, 'membership_suspended');
});

test('frozen, past due, a used-up pack and an unconfirmed transfer read as the desk reads them', () => {
  const ann = user('ann@example.test');
  assert.equal(answer(ann, [order(ann, { status: 'frozen' })]).status, 'frozen');
  assert.equal(answer(ann, [order(ann, { status: 'past_due' })]).status, 'past_due');

  // Ten sessions bought, ten used: in date, but not a live membership.
  const spent = answer(ann, [order(ann, { sessions: { total: 10, used: 10 }, endIn: 30 })]);
  assert.equal(spent.status, 'expired');

  // Nothing live, and the newest thing is a transfer awaiting confirmation.
  const waiting = order(ann, { status: 'pending', createdAgo: 1 });
  const pending = answer(ann, [order(ann, { endIn: -10, createdAgo: 40 })], [waiting]);
  assert.equal(pending.status, 'pending');

  // ...but a term that is running wins over a renewal in the queue.
  assert.equal(answer(ann, [order(ann, { endIn: 10 })], [waiting]).status, 'active');

  assert.equal(answer(ann, []).status, 'none');
  assert.equal(membershipVerdict(answer(ann, [])).label, 'No package on file');
});

test('guest checkouts are matched on the exact email, and each order is counted once', () => {
  const gus = user('gus@example.test');
  const other = user('other@example.test');

  // Bought before the account existed: no userId, only the address.
  const guest = order(gus, { byEmailOnly: true, endIn: 12 });
  assert.equal(answer(gus, [guest]).status, 'active');

  // The database is asked for the lower-cased address exactly, so an order
  // stored under different casing is not theirs here either.
  const shouty = order(other, { byEmailOnly: true, email: 'GUS@example.test', endIn: 12 });
  assert.equal(answer(gus, [shouty]).status, 'none');

  // Matching on both id and email must not make one order two.
  const both = order(gus, { endIn: 12 });
  const index = membershipsFromOrders([gus], [both, both], [], now);
  assert.equal(index.get(String(gus._id)).orderId, both._id);
});

test('a page of members is answered one by one exactly as membershipFor would', () => {
  const a = user('a@example.test');
  const b = user('b@example.test');
  const c = user(null);

  const paid = [
    order(a, { status: 'cancelled', endIn: 7, createdAgo: 3 }),
    order(a, { endIn: -30, createdAgo: 60 }),
    order(b, { status: 'suspended', endIn: 25, createdAgo: 2 }),
    order(b, { endIn: 90, createdAgo: 1, status: 'cancelled' }),
    order(c, { endIn: 3, createdAgo: 20, email: null })
  ];
  const unpaid = [order(a, { status: 'pending', createdAgo: 30 })];

  const index = membershipsFromOrders([a, b, c], paid, unpaid, now);
  assert.equal(index.size, 3);

  // membershipFor's own sort -- newest end date first -- then its rules.
  const sortLikeMongo = (list) =>
    list.slice().sort((x, y) => y.subscription.endDate - x.subscription.endDate || y.createdAt - x.createdAt);
  const own = (person, list) => list.filter((o) => String(o.userId) === String(person._id));

  for (const person of [a, b, c]) {
    const expected = membershipFromOrders(sortLikeMongo(own(person, paid)), own(person, unpaid)[0] || null, now);
    assert.deepEqual(index.get(String(person._id)), expected, String(person.email));
  }

  assert.equal(index.get(String(a._id)).status, 'cancelled');
  assert.equal(index.get(String(b._id)).status, 'cancelled', 'the newest-ending order leads, as at the desk');
  assert.equal(index.get(String(c._id)).status, 'active');
});
