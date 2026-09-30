// The fee desk's reads: finding a member by name, phone or member ID (exact
// IDs first, a phone by its digits), and one member's desk view -- the
// membership a renewal follows (a term paid in advance included), the
// package's price today, what they owe, and card subscriptions flagged.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let PackageOrder;
let Package;
let User;
let desk;
let membership;
let service;
let feeDesk;
let monthly;
const people = {};
const orders = {};

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  desk = h.src('gymfolio/controller/feeDeskController');
  membership = h.src('gymfolio/controller/membershipController');
  service = h.src('gymfolio/services/membershipService');
  feeDesk = h.src('gymfolio/services/feeDesk');
  gym = await h.createGym('fee-desk-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder, User);
    monthly = await Package.create({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', joiningFee: 15, features: ['Gym floor'] });
    await seed();
  });
});

const at = (days) => new Date(Date.now() + days * DAY);

async function person(key, extra = {}) {
  people[key] = await User.create({ firstName: key, lastName: 'Desk', email: `${key.toLowerCase()}@desk.test`, role: 'user', ...extra });
  return people[key];
}

async function term(who, { start, end, paid = true, amountPaid } = {}) {
  const order = await service.createManualOrder({ user: who, pkg: monthly, startDate: start, endDate: end, markPaid: paid, chargeJoiningFee: false, amountPaid });
  if (paid && end < new Date()) await PackageOrder.updateOne({ _id: order._id }, { $set: { status: 'expired' } });
  return order;
}

async function seed() {
  // Runs out in 5 days, and the next term is already paid for.
  const ava = await person('Ava', { memberCode: 'GP-0184', phone: '0300-1234567', avatarUrl: 'https://img.test/ava.jpg' });
  orders.avaNow = await term(ava, { start: at(-25), end: at(5) });
  orders.avaNext = await term(ava, { start: at(5), end: at(35) });
  // Lapsed ten days ago; a member ID that merely contains 184.
  orders.bo = await term(await person('Bo', { memberCode: 'GP-1840', phone: '07111 222333' }), { start: at(-40), end: at(-10) });
  // Owes 30 of 40 on the membership running now.
  orders.cy = await term(await person('Cy', { memberCode: 'GP-0002' }), { start: at(-3), end: at(27), amountPaid: 10 });
  // A card subscription Stripe renews.
  const di = await person('Di', { memberCode: 'GP-0003' });
  orders.di = await term(di, { start: at(-20), end: at(10) });
  await PackageOrder.updateOne(
    { _id: orders.di._id },
    { $set: { 'payment.method': 'stripe', 'payment.stripeSubscriptionId': 'sub_di', 'subscription.autoRenew': true, 'subscription.stripeStatus': 'active' } }
  );
  // Never had a membership.
  await person('Ed', { memberCode: 'GP-0004' });
  // A disabled account, still found.
  await person('Fay', { memberCode: 'GP-0005', isActive: false });
  // Staff are not members.
  await person('Avery', { role: 'manager' });
}

const found = (res) => res.body.data.map((row) => row.name.split(' ')[0]);

test('search: every word must match; staff are left out; an empty search finds nobody', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(desk.search, { query: { q: 'ava desk' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(found(res), ['Ava']);
    const ava = res.body.data[0];
    assert.equal(ava.id, String(people.Ava._id));
    assert.equal(ava.memberCode, 'GP-0184');
    assert.equal(ava.avatarUrl, 'https://img.test/ava.jpg');
    assert.equal(ava.isActive, true);
    // What they hold, so two people of one name can be told apart.
    assert.equal(ava.membership.packageName, 'Monthly');
    assert.equal(ava.membership.current, true);

    assert.deepEqual(found(await h.call(desk.search, { query: { q: 'av' } })), ['Ava']);
    const empty = await h.call(desk.search, { query: { q: '  ' } });
    assert.deepEqual(empty.body.data, []);
    assert.equal(empty.body.hasMore, false);
  });
});

test('search: a member ID -- typed in full or as its number -- comes first', async () => {
  await h.inGym(gym, async () => {
    const byNumber = await h.call(desk.search, { query: { q: '184' } });
    assert.deepEqual(found(byNumber), ['Ava', 'Bo'], 'GP-0184 exactly, then GP-1840 as a partial match');
    const byCode = await h.call(desk.search, { query: { q: 'gp-1840' } });
    assert.deepEqual(found(byCode), ['Bo']);
  });
});

test('search: a phone matches by its digits however it is typed', async () => {
  await h.inGym(gym, async () => {
    assert.deepEqual(found(await h.call(desk.search, { query: { q: '0300 1234567' } })), ['Ava']);
    assert.deepEqual(found(await h.call(desk.search, { query: { q: '07111222333' } })), ['Bo']);
  });
});

test('search: disabled accounts are found and flagged; the limit says when there are more', async () => {
  await h.inGym(gym, async () => {
    const fay = await h.call(desk.search, { query: { q: 'fay' } });
    assert.equal(fay.body.data[0].isActive, false);
    assert.equal(fay.body.data[0].membership, null);

    const page = await h.call(desk.search, { query: { q: 'desk', limit: '2' } });
    assert.equal(page.body.data.length, 2);
    assert.equal(page.body.hasMore, true);
  });
});

test('member: a term paid in advance is the one a renewal follows; the running one is shown beside it', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(desk.member, { params: { userId: String(people.Ava._id) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const view = res.body.data;
    assert.equal(view.member.name, 'Ava Desk');
    assert.equal(view.member.phone, '0300-1234567');
    assert.equal(view.membership.orderId, String(orders.avaNext._id));
    assert.equal(view.membership.live, true);
    assert.equal(view.membership.startsLater, true);
    assert.equal(view.membership.daysLeft, 35);
    assert.equal(view.running.orderId, String(orders.avaNow._id));
    assert.equal(view.running.daysLeft, 5);
    assert.deepEqual(view.package, { id: String(monthly._id), name: 'Monthly', price: 40, currency: 'GBP', period: 'month', kind: 'membership', isActive: true });
    assert.deepEqual(view.dues, []);
    assert.equal(view.joiningFeeDue, false);
    assert.equal(view.currency, 'GBP');

    // Renewing from it starts after the term already paid for, not over it.
    const renewed = await h.call(membership.renew, { params: { id: view.membership.orderId }, body: { paymentMethod: 'cash' }, user: { _id: people.Avery._id } });
    assert.equal(renewed.statusCode, 201, JSON.stringify(renewed.body));
    assert.equal(new Date(renewed.body.data.subscription.startDate).getTime(), new Date(orders.avaNext.subscription.endDate).getTime());
    await PackageOrder.deleteOne({ _id: renewed.body.data._id });
  });
});

test('member: lapsed, owing, and billed by card', async () => {
  await h.inGym(gym, async () => {
    const bo = (await h.call(desk.member, { params: { userId: String(people.Bo._id) } })).body.data;
    assert.equal(bo.membership.orderId, String(orders.bo._id));
    assert.equal(bo.membership.live, false);
    assert.equal(bo.membership.status, 'expired');
    assert.equal(bo.membership.daysLeft, -10);
    assert.equal(bo.running, null);

    const cy = (await h.call(desk.member, { params: { userId: String(people.Cy._id) } })).body.data;
    assert.equal(cy.membership.balanceDue, 30);
    assert.equal(cy.membership.amountPaid, 10);
    assert.equal(cy.dues.length, 1);
    assert.deepEqual(
      { orderId: cy.dues[0].orderId, balanceDue: cy.dues[0].balanceDue, amountPaid: cy.dues[0].amountPaid, currency: cy.dues[0].currency, stripeBilled: cy.dues[0].stripeBilled },
      { orderId: String(orders.cy._id), balanceDue: 30, amountPaid: 10, currency: 'GBP', stripeBilled: false }
    );

    const di = (await h.call(desk.member, { params: { userId: String(people.Di._id) } })).body.data;
    assert.equal(di.membership.autoRenews, true);
    assert.equal(di.membership.stripeBilled, true);
    assert.equal(di.membership.cardPaymentFailed, false);
  });
});

test('member: never a member, and not found', async () => {
  await h.inGym(gym, async () => {
    const ed = (await h.call(desk.member, { params: { userId: String(people.Ed._id) } })).body.data;
    assert.equal(ed.membership, null);
    assert.equal(ed.running, null);
    assert.equal(ed.package, null);
    assert.deepEqual(ed.dues, []);
    assert.equal(ed.joiningFeeDue, true);

    const { Types } = h.state.mongoose;
    for (const userId of [String(new Types.ObjectId()), 'not-an-id']) {
      const res = await h.call(desk.member, { params: { userId } });
      assert.equal(res.statusCode, 404, userId);
      assert.equal(res.body.code, 'MEMBER_NOT_FOUND');
    }
  });
});

test('the patterns: a phone needs four digits; a bare number is one member ID', () => {
  assert.equal(feeDesk.phonePattern('ava'), null);
  assert.equal(feeDesk.phonePattern('123'), null);
  assert.ok(feeDesk.phonePattern('+92 300').test('+92-300-1112223'));
  const code = feeDesk.exactCodePattern('7');
  assert.ok(code.test('GP-0007'));
  assert.ok(!code.test('GP-0070'));
  assert.equal(feeDesk.readLimit('500'), 25);
  assert.equal(feeDesk.readLimit('x'), 8);
});
