// The desk's member lists: whose membership ends soon and has not been
// renewed, whose has ended without a renewal (unpaid ones included), and
// what a set of members currently hold -- one row per member, with who
// they are read from their own record.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let PackageOrder;
let Package;
let User;
let lists;
let service;
let monthly;
let pack;
const people = {};

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  lists = h.src('gymfolio/controller/membershipListsController');
  service = h.src('gymfolio/services/membershipService');
  gym = await h.createGym('lists-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['Gym floor'] });
    pack = await Package.create({ name: 'Ten classes', price: '60', currency: 'GBP', period: 'month', kind: 'session_pack', sessions: 10, features: ['Classes'] });
    await seed();
  });
});

const at = (days) => new Date(Date.now() + days * DAY);

async function person(key, extra = {}) {
  people[key] = await User.create({ firstName: key, lastName: 'Lister', email: `${key.toLowerCase()}@lists.test`, phone: `07${key.length}00`, role: 'user', ...extra });
  return people[key];
}

// A membership over [start, end], as the desk would sell it; lapsed ones
// are then marked expired, as the sweep would.
async function term(who, { start, end, pkg = monthly, paid = true, status } = {}) {
  const order = await service.createManualOrder({ user: who, pkg, startDate: start, endDate: end, markPaid: paid, chargeJoiningFee: false });
  const set = {};
  if (status) set.status = status;
  else if (paid && end < new Date()) set.status = 'expired';
  if (Object.keys(set).length) await PackageOrder.updateOne({ _id: order._id }, { $set: set });
  return order;
}

async function seed() {
  // Expiring within 7 days, not renewed.
  await term(await person('Ava', { gender: 'female', memberCode: 'M-001' }), { start: at(-27), end: at(3) });
  // Renewed already: the renewal is paid and runs past the window.
  const ben = await person('Ben');
  await term(ben, { start: at(-27), end: at(3) });
  await term(ben, { start: at(3), end: at(33) });
  // A renewal still unpaid is not a renewal yet.
  const cal = await person('Cal');
  await term(cal, { start: at(-28), end: at(2) });
  await term(cal, { start: at(2), end: at(32), paid: false });
  // Ends in 20 days: only in a wider window.
  await term(await person('Dee'), { start: at(-10), end: at(20) });
  // A card subscription Stripe renews by itself.
  const eve = await person('Eve');
  const card = await term(eve, { start: at(-28), end: at(2) });
  await PackageOrder.updateOne(
    { _id: card._id },
    { $set: { 'payment.method': 'stripe', 'payment.stripeSubscriptionId': 'sub_eve', 'subscription.autoRenew': true, 'subscription.stripeStatus': 'active' } }
  );
  // A session pack running out is not a membership ending.
  await term(await person('Fin'), { start: at(-5), end: at(2), pkg: pack });

  // Lapsed 5 days ago, not renewed.
  await term(await person('Gus', { gender: 'male' }), { start: at(-35), end: at(-5) });
  // Lapsed, then renewed and paid.
  const hal = await person('Hal');
  await term(hal, { start: at(-35), end: at(-5) });
  await term(hal, { start: at(-1), end: at(29) });
  // Assigned but never paid, and its term has run out.
  await term(await person('Ivy'), { start: at(-32), end: at(-2), paid: false });
  // Lapsed long ago.
  await term(await person('Jon'), { start: at(-130), end: at(-100) });
  // Lapsed, with a renewal waiting to be paid.
  const kim = await person('Kim');
  await term(kim, { start: at(-33), end: at(-3) });
  await term(kim, { start: at(0), end: at(30), paid: false });
  // Cancelled: left, not lapsed.
  await term(await person('Lou'), { start: at(-33), end: at(-3), status: 'cancelled' });
  // Owes money on a current membership.
  const max = await person('Max');
  await service.createManualOrder({ user: max, pkg: monthly, amountPaid: 10, chargeJoiningFee: false });
  // Nothing at all.
  await person('Ned');
}

const names = (res) => res.body.data.map((row) => row.name.split(' ')[0]).sort();

test('expiring: members whose membership ends within the window and who have not renewed', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(lists.expiring, { query: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.days, 7);
    assert.deepEqual(names(res), ['Ava', 'Cal']);

    const ava = res.body.data.find((row) => row.name === 'Ava Lister');
    assert.equal(ava.memberId, String(people.Ava._id));
    assert.equal(ava.phone, people.Ava.phone);
    assert.equal(ava.email, 'ava@lists.test');
    assert.equal(ava.gender, 'female');
    assert.equal(ava.memberCode, 'M-001');
    assert.equal(ava.packageName, 'Monthly');
    assert.equal(ava.daysLeft, 3);
    assert.equal(ava.amount, 40);
    assert.equal(ava.balanceDue, 0);
    assert.equal(ava.autoRenews, false);
    assert.ok(ava.orderId && ava.orderNumber && ava.endDate);
    // Soonest first.
    assert.deepEqual(res.body.data.map((row) => row.daysLeft), [2, 3]);
  });
});

test('expiring: a wider window, card subscriptions on request, and bad windows refused', async () => {
  await h.inGym(gym, async () => {
    const wide = await h.call(lists.expiring, { query: { days: '30' } });
    assert.ok(names(wide).includes('Dee'));
    assert.ok(!names(wide).includes('Eve'));
    assert.ok(!names(wide).includes('Ben'), 'renewed');

    const withCards = await h.call(lists.expiring, { query: { includeAutoRenew: '1' } });
    const eve = withCards.body.data.find((row) => row.name === 'Eve Lister');
    assert.equal(eve.autoRenews, true);

    for (const days of ['0', '366', 'week', '2.5']) {
      const res = await h.call(lists.expiring, { query: { days } });
      assert.equal(res.statusCode, 400, days);
      assert.equal(res.body.code, 'INVALID_QUERY');
    }
  });
});

test('expired: lapsed and not renewed, unpaid ones included, most recent first', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(lists.expired, { query: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(names(res), ['Gus', 'Ivy', 'Jon', 'Kim']);
    assert.deepEqual(res.body.data.map((row) => row.name.split(' ')[0]), ['Ivy', 'Kim', 'Gus', 'Jon']);

    const gus = res.body.data.find((row) => row.name === 'Gus Lister');
    assert.equal(gus.daysOverdue, 5);
    assert.equal(gus.gender, 'male');
    assert.equal(gus.status, 'expired');
    const ivy = res.body.data.find((row) => row.name === 'Ivy Lister');
    assert.equal(ivy.paymentStatus, 'pending');

    const recent = await h.call(lists.expired, { query: { withinDays: '30' } });
    assert.deepEqual(names(recent), ['Gus', 'Ivy', 'Kim']);
    assert.equal((await h.call(lists.expired, { query: { withinDays: '-1' } })).statusCode, 400);
  });
});

test('the lists page and search', async () => {
  await h.inGym(gym, async () => {
    const first = await h.call(lists.expired, { query: { limit: '2', page: '1' } });
    const second = await h.call(lists.expired, { query: { limit: '2', page: '2' } });
    assert.equal(first.body.pagination.total, 4);
    assert.equal(first.body.pagination.pages, 2);
    assert.equal(first.body.data.length + second.body.data.length, 4);
    const found = await h.call(lists.expiring, { query: { search: 'cal@lists' } });
    assert.deepEqual(names(found), ['Cal']);
  });
});

test('summary: the current membership, else the latest, else null -- in the order asked', async () => {
  await h.inGym(gym, async () => {
    const ask = ['Ben', 'Gus', 'Ned', 'Max', 'Ben'].map((key) => String(people[key]._id));
    const res = await h.call(lists.summary, { body: { userIds: ask } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.map((row) => row.userId), ask.slice(0, 4), 'each member once');

    const [ben, gus, ned, max] = res.body.data;
    // Running today, not the renewal waiting to start.
    assert.equal(ben.membership.current, true);
    assert.ok(new Date(ben.membership.endDate).getTime() < at(4).getTime());
    assert.equal(gus.membership.current, false);
    assert.equal(gus.membership.status, 'expired');
    assert.equal(ned.membership, null);
    assert.deepEqual(
      Object.keys(max.membership).sort(),
      [
        'amount', 'amountPaid', 'balanceDue', 'currency', 'current', 'daysLeft', 'discountAmount', 'endDate', 'joiningFee',
        'method', 'orderId', 'orderNumber', 'packageName', 'paymentStatus', 'startDate', 'status', 'trainerFee', 'trainerName'
      ].sort()
    );
    assert.equal(max.membership.amountPaid, 10);
    assert.equal(max.membership.balanceDue, 30);
    assert.equal(max.membership.method, 'cash');
  });
});

test('summary: a bad request is refused', async () => {
  await h.inGym(gym, async () => {
    for (const body of [{}, { userIds: [] }, { userIds: 'x' }, { userIds: ['not-an-id'] }]) {
      const res = await h.call(lists.summary, { body });
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    const { Types } = h.state.mongoose;
    const many = Array.from({ length: 501 }, () => String(new Types.ObjectId()));
    const res = await h.call(lists.summary, { body: { userIds: many } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /At most 500/);
  });
});
