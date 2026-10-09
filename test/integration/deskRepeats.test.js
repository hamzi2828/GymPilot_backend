// A desk request sent again after its answer was lost, against a real MongoDB.
//
// The buttons are disabled while a request is saving, so the repeat that
// matters is the one staff make after a timeout or a dropped connection: the
// first request did go through, and the second used to sell another term
// over it, stack another order, or record the same instalment again. A
// request carrying the `requestId` of one already made now gets that first
// result back. Requests without one behave exactly as they always did.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let PackageOrder;
let Package;
let User;
let orders;
let lifecycle;
let monthly;
let staff;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  lifecycle = h.src('gymfolio/controller/membershipController');
  gym = await h.createGym('repeat-gym', { timezone: 'UTC', currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '6000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
    staff = await User.create({ firstName: 'Desk', lastName: 'Staff', email: 'desk@repeat.test', role: 'admin' });
  });
});

let seq = 0;
const newMember = () => {
  seq += 1;
  return User.create({ firstName: 'Rae', lastName: `Peat${seq}`, email: `repeat${seq}@repeat.test`, role: 'user' });
};
const asStaff = () => ({ id: String(staff._id), email: staff.email });
const assign = (member, body = {}) =>
  h.call(orders.assignPackageToUser, { body: { userId: String(member._id), packageId: String(monthly._id), paymentMethod: 'cash', ...body }, user: asStaff() });
const renew = (order, body = {}) => h.call(lifecycle.renew, { params: { id: String(order._id) }, body: { paymentMethod: 'cash', ...body }, user: asStaff() });
const pay = (order, body) => h.call(lifecycle.recordPayment, { params: { id: String(order._id) }, body, user: asStaff() });

// Notices go out after the handler returns; give them a moment.
async function confirmations(member) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return h.calls.notifications.filter((n) => n.name === 'membershipConfirmed' && n.args[0] && String(n.args[0].userId) === String(member._id)).length;
}

test('assign sent again with the same requestId answers with the order already made, not a second one', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember();
    const requestId = 'b3f1c2d4-0000-4a1b-9c3d-assign000001';

    const first = await assign(member, { requestId });
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    assert.equal(first.body.repeated, undefined);

    const again = await assign(member, { requestId });
    assert.equal(again.statusCode, 201, JSON.stringify(again.body));
    assert.equal(again.body.repeated, true);
    assert.equal(String(again.body.data._id), String(first.body.data._id));
    assert.equal(again.body.message, first.body.message);

    assert.equal(await PackageOrder.countDocuments({ userId: member._id }), 1);
    assert.equal(await confirmations(member), 1, 'the member is told once');

    // The id belongs to that member's sale: the same id for somebody else is a new sale.
    const other = await newMember();
    const theirs = await assign(other, { requestId });
    assert.equal(theirs.body.repeated, undefined);
    assert.notEqual(String(theirs.body.data._id), String(first.body.data._id));

    // A new id is a new sale.
    const next = await assign(member, { requestId: 'b3f1c2d4-0000-4a1b-9c3d-assign000002' });
    assert.equal(next.body.repeated, undefined);
    assert.equal(await PackageOrder.countDocuments({ userId: member._id }), 2);
  });
});

test('renew sent again with the same requestId makes one renewal: no second term over the first', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember();
    const sold = (await assign(member)).body.data;
    const requestId = 'renew-0001-abcdef';

    const first = await renew(sold, { requestId });
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    const again = await renew(sold, { requestId });
    assert.equal(again.statusCode, 201);
    assert.equal(again.body.repeated, true);
    assert.equal(String(again.body.data._id), String(first.body.data._id));
    assert.equal(again.body.message, first.body.message);

    assert.equal(await PackageOrder.countDocuments({ renewedFrom: sold._id }), 1);
    assert.equal(await confirmations(member), 2, 'one for the sale, one for the renewal');
  });
});

test('a part payment sent again with the same requestId is recorded once, and answered the same', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember();
    const sold = (await assign(member, { amountPaid: 1000 })).body.data;
    assert.equal(sold.payment.balanceDue, 5000);

    const first = await pay(sold, { amount: 2000, requestId: 'payment-0001' });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.message, 'Payment recorded. PKR 3000.00 still due.');

    const again = await pay(sold, { amount: 2000, requestId: 'payment-0001' });
    assert.equal(again.statusCode, 200, JSON.stringify(again.body));
    assert.equal(again.body.repeated, true);
    assert.equal(again.body.message, first.body.message);

    let row = await PackageOrder.findById(sold._id).lean();
    assert.equal(row.payment.balanceDue, 3000);
    assert.equal(row.payment.amountPaid, 3000);
    assert.equal(row.payment.installments.length, 2, 'the opening part and this one');

    // The payment that settles the balance, sent again: still "paid in full",
    // not "nothing is owed".
    const last = await pay(sold, { amount: 3000, requestId: 'payment-0002' });
    assert.equal(last.body.message, 'Payment recorded. Paid in full.');
    const lastAgain = await pay(sold, { amount: 3000, requestId: 'payment-0002' });
    assert.equal(lastAgain.statusCode, 200, JSON.stringify(lastAgain.body));
    assert.equal(lastAgain.body.message, 'Payment recorded. Paid in full.');
    assert.equal(lastAgain.body.repeated, true);
    row = await PackageOrder.findById(sold._id).lean();
    assert.equal(row.payment.installments.length, 3);
    assert.equal(row.payment.balanceDue, 0);
  });
});

test('requests without a requestId are each new, as they always were', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember();
    const one = await assign(member, { amountPaid: 1000 });
    const two = await assign(member, { amountPaid: 1000 });
    assert.equal(one.body.repeated, undefined);
    assert.notEqual(String(one.body.data._id), String(two.body.data._id));
    assert.equal(one.body.data.metadata, undefined);

    assert.equal((await renew(one.body.data)).statusCode, 201);
    assert.equal((await renew(one.body.data)).statusCode, 201);
    assert.equal(await PackageOrder.countDocuments({ renewedFrom: one.body.data._id }), 2);

    await pay(one.body.data, { amount: 500 });
    await pay(one.body.data, { amount: 500 });
    assert.equal((await PackageOrder.findById(one.body.data._id).lean()).payment.balanceDue, 4000);
  });
});

test('a requestId that is not one is refused, naming the field', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember();
    for (const requestId of ['short', 'has spaces in it', 'x'.repeat(101), 'dots.are.not.allowed']) {
      const res = await assign(member, { requestId });
      assert.equal(res.statusCode, 400, requestId);
      assert.equal(res.body.code, 'INVALID_TERMS');
      assert.match(res.body.message, /^requestId must be 8 to 100 letters, digits, hyphens or underscores/);
    }
    assert.equal(await PackageOrder.countDocuments({ userId: member._id }), 0);

    const sold = (await assign(member, { amountPaid: 1000 })).body.data;
    const bad = await pay(sold, { amount: 500, requestId: 'no' });
    assert.equal(bad.statusCode, 400);
    assert.equal((await PackageOrder.findById(sold._id).lean()).payment.balanceDue, 5000);
  });
});
