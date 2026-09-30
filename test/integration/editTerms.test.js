// Changing a membership's terms after the sale: its dates, and its
// discount -- which moves the total and the balance, never the money
// already received -- each change kept on the order with who made it.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let PackageOrder;
let Package;
let User;
let orders;
let lifecycle;
let service;
let L;
let T;
let monthly;
let staffAccount;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  lifecycle = h.src('gymfolio/controller/membershipController');
  service = h.src('gymfolio/services/membershipService');
  L = h.src('accounts/services/ledger');
  T = h.src('attendance/services/timeUtils');
  gym = await h.createGym('terms-gym', { timezone: 'Asia/Karachi', currency: 'PKR', settings: { taxRate: 16 } });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'], joiningFee: 2000 });
    staffAccount = await User.create({ firstName: 'Terms', lastName: 'Desk', email: 'desk@terms.test', role: 'admin' });
  });
});

let seq = 0;
const staff = () => ({ id: String(staffAccount._id), email: staffAccount.email });
async function sold(body = {}) {
  seq += 1;
  const who = await User.create({ firstName: 'Terms', lastName: `Member${seq}`, email: `terms${seq}@terms.test`, role: 'user' });
  const res = await h.call(orders.assignPackageToUser, { body: { userId: String(who._id), packageId: String(monthly._id), ...body }, user: staff() });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body.data;
}
const edit = (order, body) => h.call(lifecycle.editTerms, { params: { id: String(order._id) }, body, user: staff() });

test('moving the dates: a bare end date is the end of that day, and the change is kept', async () => {
  await h.inGym(gym, async () => {
    const o = await sold();
    const endKey = T.shiftDateKey(T.dateKey(new Date()), 45);
    const res = await edit(o, { endDate: endKey, note: 'Two weeks off for surgery' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const u = res.body.data;
    assert.equal(new Date(u.subscription.endDate).getTime(), T.lastMomentOfLocalDay(endKey).getTime());
    assert.equal(new Date(u.subscription.renewalDate).getTime(), T.lastMomentOfLocalDay(endKey).getTime());
    assert.equal(u.termsHistory.length, 1);
    const [entry] = u.termsHistory;
    assert.equal(String(entry.by), String(staffAccount._id));
    assert.equal(entry.note, 'Two weeks off for surgery');
    assert.equal(new Date(entry.from.endDate).getTime(), new Date(o.subscription.endDate).getTime());
    assert.equal(new Date(entry.to.endDate).getTime(), T.lastMomentOfLocalDay(endKey).getTime());
    // Money untouched.
    assert.equal(u.payment.amount, 7000);
    assert.equal(u.payment.balanceDue, 0);
  });
});

test('dates that cannot be right are refused', async () => {
  await h.inGym(gym, async () => {
    const o = await sold();
    const start = T.dateKey(new Date(o.subscription.startDate));
    for (const [body, pattern] of [
      [{ endDate: T.shiftDateKey(start, -1) }, /end date must come after the start/],
      [{ startDate: 'soon' }, /startDate is not a date/],
      [{}, /Nothing to change/]
    ]) {
      const res = await edit(o, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.match(res.body.message, pattern);
    }
  });
});

test('extending a lapsed membership makes it live again; ending a live one ends it', async () => {
  await h.inGym(gym, async () => {
    const o = await sold();
    await PackageOrder.updateOne(
      { _id: o._id },
      { $set: { status: 'expired', 'subscription.isActive': false, 'subscription.startDate': new Date(Date.now() - 40 * DAY), 'subscription.endDate': new Date(Date.now() - 10 * DAY) } }
    );
    let res = await edit(await PackageOrder.findById(o._id), { endDate: T.shiftDateKey(T.dateKey(new Date()), 5) });
    assert.equal(res.body.data.status, 'active');
    assert.equal(res.body.data.subscription.isActive, true);

    res = await edit(res.body.data, { endDate: T.shiftDateKey(T.dateKey(new Date()), -2) });
    assert.equal(res.body.data.status, 'expired');
    assert.equal(res.body.data.subscription.isActive, false);
  });
});

test('a bigger discount on an order paid in part lowers the balance; money received stays put', async () => {
  await h.inGym(gym, async () => {
    const o = await sold({ amountPaid: 3000 });
    const res = await edit(o, { discountAmount: 1000, discountNote: 'Staff family' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const p = res.body.data.payment;
    assert.equal(p.amount, 6000);
    assert.equal(p.discountAmount, 1000);
    assert.equal(p.discountNote, 'Staff family');
    assert.equal(p.amountPaid, 3000);
    assert.equal(p.balanceDue, 3000);
    // The invoice keeps its number and takes the new total, tax included.
    assert.equal(res.body.data.invoice.number, o.invoice.number);
    assert.equal(res.body.data.invoice.total, 6000);
    assert.equal(res.body.data.invoice.taxAmount, Math.round((6000 - 6000 / 1.16) * 100) / 100);
    assert.deepEqual([res.body.data.termsHistory[0].from.amount, res.body.data.termsHistory[0].to.amount], [7000, 6000]);
  });
});

test('a smaller discount on an order paid in full leaves a balance, and the accounts still count what came in', async () => {
  await h.inGym(gym, async () => {
    const o = await sold({ discountAmount: 1500 });
    assert.equal(o.payment.amount, 5500);
    // As an order from before part payments: no amountPaid on record.
    await PackageOrder.updateOne({ _id: o._id }, { $unset: { 'payment.amountPaid': 1, 'payment.balanceDue': 1 } });

    const res = await edit(await PackageOrder.findById(o._id), { discountAmount: 500 });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const p = res.body.data.payment;
    assert.equal(p.amount, 6500);
    assert.equal(p.amountPaid, 5500);
    assert.equal(p.balanceDue, 1000);
    assert.match(res.body.message, /PKR 1000.00 is due/);

    const today = T.dateKey(new Date());
    const rows = await PackageOrder.aggregate(L.membershipPaymentStages(L.readRange({ from: today, to: today }), { orderNumber: o.orderNumber }));
    assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), 5500, 'what came in, not the new total');

    // The balance is then paid like any other.
    const paid = await service.recordPayment(await PackageOrder.findById(o._id), { amount: 1000 });
    assert.equal(paid.payment.balanceDue, 0);
    assert.deepEqual(paid.payment.installments.map((i) => i.amount), [5500, 1000]);
  });
});

test('a discount that would need a refund, or eat into the fees, is refused', async () => {
  await h.inGym(gym, async () => {
    const full = await sold();
    let res = await edit(full, { discountAmount: 1000 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'REFUND_NEEDED');
    assert.match(res.body.message, /Refund the difference/);

    res = await edit(full, { discountAmount: 6000 });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /cannot be more than it/);

    const overridden = await sold({ amountOverride: 3000, amountPaid: 0 });
    res = await edit(overridden, { discountAmount: 1500 });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /below the 2000 of fees/);

    const unchanged = await PackageOrder.findById(full._id).lean();
    assert.equal(unchanged.termsHistory.length, 0);
  });
});

test('card subscriptions and closed orders are refused', async () => {
  await h.inGym(gym, async () => {
    const card = await PackageOrder.create({
      orderNumber: 'TERMS-CARD',
      userId: staffAccount._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', billing: { mode: 'recurring' } },
      customerInfo: { fullName: 'Card Payer' },
      payment: { method: 'stripe', amount: 5000, currency: 'pkr', status: 'paid', stripeSubscriptionId: 'sub_terms' },
      subscription: { startDate: new Date(), endDate: new Date(Date.now() + 30 * DAY), autoRenew: true },
      status: 'active'
    });
    let res = await edit(card, { endDate: T.shiftDateKey(T.dateKey(new Date()), 60) });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'STRIPE_BILLED');

    const oneOff = await PackageOrder.create({
      orderNumber: 'TERMS-CARD-ONCE',
      userId: staffAccount._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'Card Once' },
      payment: { method: 'stripe', amount: 5000, currency: 'pkr', status: 'paid', stripePaymentIntentId: 'pi_terms' },
      subscription: { startDate: new Date(), endDate: new Date(Date.now() + 30 * DAY) },
      status: 'active'
    });
    // Its dates may move; its price is what the card was charged.
    assert.equal((await edit(oneOff, { endDate: T.shiftDateKey(T.dateKey(new Date()), 40) })).statusCode, 200);
    res = await edit(await PackageOrder.findById(oneOff._id), { discountAmount: 500 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'STRIPE_BILLED');

    const refunded = await PackageOrder.findById((await sold())._id);
    await service.refund(refunded, { reason: 'moved' });
    res = await edit(await PackageOrder.findById(refunded._id), { endDate: T.shiftDateKey(T.dateKey(new Date()), 40) });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'ORDER_CLOSED');
  });
});

test('an edit made from a stale copy is refused, not written over the newer one', async () => {
  await h.inGym(gym, async () => {
    const o = await sold({ amountPaid: 2000 });
    const stale = await PackageOrder.findById(o._id);
    await service.recordPayment(await PackageOrder.findById(o._id), { amount: 1000 });
    await assert.rejects(service.editTerms(stale, { discountAmount: 500 }), (error) => error.code === 'TERMS_CHANGED');
    const fresh = await PackageOrder.findById(o._id).lean();
    assert.equal(fresh.payment.balanceDue, 4000);
    assert.equal(fresh.payment.discountAmount, 0);
  });
});
