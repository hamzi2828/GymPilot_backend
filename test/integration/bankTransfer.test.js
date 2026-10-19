// Bank transfers: the receipt, and staff confirming or rejecting it, against
// a real MongoDB.
//
// Approve used to check "not paid yet" on the copy it had read, so two
// approvals sent together both activated: the second pushed the term a full
// period on, counted the coupon again and issued a second invoice number.
// And a refunded or rejected order was reopened by its member sending a
// receipt again, or re-activated by Approve. Each of the three is now one
// conditional update on the order as it is stored.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let PackageOrder;
let Package;
let Coupon;
let User;
let service;
let controller;
let monthly;
let staff;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  Coupon = h.src('gymfolio/models/couponModel');
  User = h.src('models/user');
  service = h.src('gymfolio/services/membershipService');
  controller = h.src('gymfolio/controller/membershipController');
  gym = await h.createGym('transfer-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['Gym floor'] });
    staff = await User.create({ firstName: 'Desk', lastName: 'Staff', email: 'desk@transfer.test', role: 'admin' });
  });
});

let seq = 0;

// A transfer order with its receipt sent: awaiting review.
async function awaitingReview({ couponCode } = {}) {
  seq += 1;
  const member = await User.create({ firstName: 'Tran', lastName: `Sfer${seq}`, email: `transfer${seq}@transfer.test`, role: 'user' });
  const order = await service.createBankTransferOrder({ user: member, pkg: monthly, couponCode });
  return service.submitTransferProof(order, { reference: `REF-${seq}` });
}

const asStaff = () => ({ id: String(staff._id), email: staff.email });
const approve = (order) => h.call(controller.approve, { params: { id: String(order._id) }, user: asStaff() });
const reject = (order, reason = 'No such transfer') => h.call(controller.reject, { params: { id: String(order._id) }, body: { reason }, user: asStaff() });
const sendProof = (order, body = { reference: 'AGAIN' }) =>
  h.call(controller.submitProof, { params: { id: String(order._id) }, body, user: asStaff(), roleSlug: 'admin' });

test('two approvals sent together activate the order once: one term, one coupon use, one invoice', async () => {
  await h.inGym(gym, async () => {
    await Coupon.create({ code: 'TRANSFER10', type: 'amount', value: 10, currency: 'GBP' });
    const order = await awaitingReview({ couponCode: 'TRANSFER10' });
    assert.equal(order.payment.status, 'processing');

    const [first, second] = await Promise.all([approve(order), approve(order)]);
    const refused = first.statusCode === 200 ? second : first;
    const done = first.statusCode === 200 ? first : second;
    assert.equal(done.statusCode, 200, JSON.stringify([first.body, second.body]));
    // The other is told the first is still at it, or that it has finished.
    assert.ok(
      (refused.statusCode === 409 && refused.body.code === 'REVIEW_IN_PROGRESS') || (refused.statusCode === 400 && refused.body.code === 'ALREADY_PAID'),
      JSON.stringify(refused.body)
    );
    assert.equal(done.body.message, 'Payment confirmed. Monthly is now active.');
    assert.equal(done.body.data.status, 'active');

    const row = await PackageOrder.findById(order._id).lean();
    assert.equal(row.payment.status, 'paid');
    assert.equal(row.status, 'active');
    // One month from now -- not pushed a second month on by a second activation.
    const days = (new Date(row.subscription.endDate) - new Date(row.subscription.startDate)) / DAY;
    assert.ok(days >= 28 && days <= 31, `one term, got ${days} days`);
    assert.ok(Math.abs(new Date(row.subscription.startDate) - Date.now()) < 60000, 'starts now');
    assert.equal(String(row.payment.proof.reviewedBy), String(staff._id));
    assert.equal((await Coupon.findOne({ code: 'TRANSFER10' }).lean()).redemptions, 1);
    assert.ok(row.invoice.number, 'an invoice was issued');
    assert.equal(await PackageOrder.countDocuments({ 'invoice.number': { $ne: null } }), 1);

    // Later, a third: told the same, and nothing moves.
    const late = await approve(order);
    assert.equal(late.statusCode, 400);
    assert.equal(late.body.code, 'ALREADY_PAID');
    assert.equal(late.body.message, 'This order is already paid');
    assert.equal((await PackageOrder.findById(order._id).lean()).subscription.endDate.getTime(), row.subscription.endDate.getTime());
  });
});

test('a rejected order stays closed: no receipt reopens it and Approve does not activate it', async () => {
  await h.inGym(gym, async () => {
    const order = await awaitingReview();
    const rejected = await reject(order, 'No such transfer');
    assert.equal(rejected.statusCode, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.payment.status, 'failed');
    assert.equal(rejected.body.data.payment.proof.rejectionReason, 'No such transfer');

    const again = await sendProof(order);
    assert.equal(again.statusCode, 409, JSON.stringify(again.body));
    assert.equal(again.body.code, 'ORDER_CLOSED');
    assert.match(again.body.message, /This order is closed: its payment was not accepted\. It cannot be opened again; start a new order/);

    const approved = await approve(order);
    assert.equal(approved.statusCode, 409);
    assert.equal(approved.body.code, 'ORDER_CLOSED');

    const row = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([row.payment.status, row.status, row.subscription.isActive], ['failed', 'cancelled', false]);
    assert.equal(row.payment.proof.reference, order.payment.proof.reference, 'the receipt on file is the one that was rejected');
    assert.equal(row.payment.proof.rejectionReason, 'No such transfer');
  });
});

test('a refunded order stays refunded: no receipt, approval or rejection changes it', async () => {
  await h.inGym(gym, async () => {
    const order = await awaitingReview();
    const paid = await service.approveTransfer(order, { by: staff._id });
    await service.refund(paid, { reason: 'changed mind' });

    for (const attempt of [() => sendProof(order), () => approve(order), () => reject(order)]) {
      const res = await attempt();
      assert.equal(res.statusCode, 409, JSON.stringify(res.body));
      assert.equal(res.body.code, 'ORDER_CLOSED');
      assert.match(res.body.message, /This order was refunded, so it cannot be opened again\. Start a new order/);
    }
    const row = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([row.payment.status, row.status, row.subscription.isActive], ['refunded', 'cancelled', false]);
    assert.equal(row.refund.amount, 40);
  });
});

test('a receipt can be sent again while it waits to be checked, and a paid order takes none', async () => {
  await h.inGym(gym, async () => {
    const order = await awaitingReview();
    const replaced = await sendProof(order, { reference: 'CORRECTED', note: 'wrong reference before' });
    assert.equal(replaced.statusCode, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.data.payment.proof.reference, 'CORRECTED');
    assert.equal(replaced.body.data.payment.status, 'processing');

    await approve(order);
    const late = await sendProof(order);
    assert.equal(late.statusCode, 400);
    assert.equal(late.body.message, 'This order is already paid');
    assert.equal((await PackageOrder.findById(order._id).lean()).payment.status, 'paid');
  });
});

test('an approval under way holds the order; one that died part-way is taken over after ten minutes', async () => {
  await h.inGym(gym, async () => {
    const order = await awaitingReview();
    // Another request claimed it a minute ago and has not finished.
    await PackageOrder.updateOne({ _id: order._id }, { $set: { 'payment.proof.reviewedAt': new Date(Date.now() - 60000) } });
    for (const attempt of [() => approve(order), () => reject(order), () => sendProof(order)]) {
      const held = await attempt();
      assert.equal(held.statusCode, 409, JSON.stringify(held.body));
      assert.equal(held.body.code, 'REVIEW_IN_PROGRESS');
      assert.match(held.body.message, /Somebody else is confirming this payment right now\. Reload the order in a moment/);
    }
    assert.equal((await PackageOrder.findById(order._id).lean()).payment.status, 'processing');

    // Eleven minutes on it never finished: the request behind it is gone.
    await PackageOrder.updateOne({ _id: order._id }, { $set: { 'payment.proof.reviewedAt': new Date(Date.now() - 11 * 60000) } });
    const taken = await approve(order);
    assert.equal(taken.statusCode, 200, JSON.stringify(taken.body));
    assert.equal((await PackageOrder.findById(order._id).lean()).payment.status, 'paid');
  });
});

test('an approval that fails lets go of the order, so it can be approved again', async () => {
  await h.inGym(gym, async () => {
    const order = await awaitingReview();
    const save = PackageOrder.prototype.save;
    PackageOrder.prototype.save = async function failing() {
      throw new Error('the database went away');
    };
    try {
      await assert.rejects(service.approveTransfer(order, { by: staff._id }), /the database went away/);
    } finally {
      PackageOrder.prototype.save = save;
    }
    const row = await PackageOrder.findById(order._id).lean();
    assert.equal(row.payment.status, 'processing');
    assert.equal(row.payment.proof.reviewedAt, null);

    assert.equal((await approve(order)).statusCode, 200);
  });
});

test('an order assigned at the desk and left pending is confirmed the same way', async () => {
  await h.inGym(gym, async () => {
    seq += 1;
    const member = await User.create({ firstName: 'Pend', lastName: `Ing${seq}`, email: `pending${seq}@transfer.test`, role: 'user' });
    const order = await service.createManualOrder({ user: member, pkg: monthly, markPaid: false });
    const res = await approve(order);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.payment.status, 'paid');
    assert.equal(res.body.data.status, 'active');
  });
});

test("the member's own order list carries why their receipt was not accepted", async () => {
  await h.inGym(gym, async () => {
    const order = await awaitingReview();
    const rejected = await reject(order, 'Amount does not match');
    assert.equal(rejected.statusCode, 200, JSON.stringify(rejected.body));

    const payments = h.src('gymfolio/controller/gymfolioPaymentController');
    const mine = await h.call(payments.getUserOrders, { user: { id: String(order.userId) }, query: {} });
    assert.equal(mine.statusCode, 200, JSON.stringify(mine.body));
    const row = JSON.parse(JSON.stringify(mine.body.data)).find((o) => String(o._id) === String(order._id));
    assert.ok(row, 'the rejected order is in the list');
    assert.equal(row.payment.status, 'failed');
    assert.equal(row.payment.proof.rejectionReason, 'Amount does not match');
  });
});

// ---- A transfer order cancelled before it was paid ---------------------------
//
// Cancelling set the order 'cancelled' but left its payment 'pending', and
// the receipt and approval checks looked at the payment alone: a receipt
// sent afterwards put the order back to 'pending', and Approve then handed
// the membership over. Cancelled now closes the payment too, and an order
// cancelled either way is refused.

const cancelOrder = (order) =>
  h.call(controller.cancel, { params: { id: String(order._id) }, body: { reason: 'Changed their mind' }, user: asStaff(), roleSlug: 'admin' });

async function transferOrder() {
  seq += 1;
  const member = await User.create({ firstName: 'Can', lastName: `Celled${seq}`, email: `cancelled${seq}@transfer.test`, role: 'user' });
  return service.createBankTransferOrder({ user: member, pkg: monthly });
}

function refusedAsCancelled(res) {
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'ORDER_CLOSED');
  assert.match(res.body.message, /^This order was cancelled, so no transfer can be sent or confirmed for it\./);
}

test('a transfer order cancelled before it was paid takes no receipt and no approval, and stays cancelled', async () => {
  await h.inGym(gym, async () => {
    const order = await transferOrder();
    const cancelled = await cancelOrder(order);
    assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.body));

    let row = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([row.status, row.payment.status], ['cancelled', 'cancelled'], 'the payment is closed with the order');

    refusedAsCancelled(await sendProof(order, { reference: 'LATE-RECEIPT' }));
    refusedAsCancelled(await approve(order));
    refusedAsCancelled(await reject(order));

    row = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([row.status, row.payment.status, row.subscription.isActive], ['cancelled', 'cancelled', false]);
    assert.equal(row.payment.proof.reference, '', 'the late receipt was not kept');
    assert.equal(row.invoice && row.invoice.number, null);
  });
});

test('a transfer cancelled while its receipt waited for review cannot then be approved', async () => {
  await h.inGym(gym, async () => {
    const order = await awaitingReview();
    assert.equal(order.payment.status, 'processing');
    assert.equal((await cancelOrder(order)).statusCode, 200);
    refusedAsCancelled(await approve(order));
    const row = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([row.status, row.payment.status], ['cancelled', 'cancelled']);
  });
});

test('an order cancelled before this fix, its payment still pending, is refused all the same', async () => {
  await h.inGym(gym, async () => {
    const order = await transferOrder();
    await PackageOrder.updateOne({ _id: order._id }, { $set: { status: 'cancelled', 'subscription.isActive': false } });
    refusedAsCancelled(await sendProof(order, { reference: 'REVIVE-ME' }));
    refusedAsCancelled(await approve(order));
    const row = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([row.status, row.payment.status], ['cancelled', 'pending']);
  });
});

test('a card checkout cancelled before it was paid reads failed, as an expired one does, so money Stripe still takes is honoured', async () => {
  await h.inGym(gym, async () => {
    seq += 1;
    const member = await User.create({ firstName: 'Card', lastName: `Cancel${seq}`, email: `card-cancel${seq}@transfer.test`, role: 'user' });
    const order = await PackageOrder.create({
      orderNumber: `CARD-CANCEL-${seq}`,
      userId: member._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly', price: '40', currency: 'gbp', period: 'month' },
      customerInfo: { fullName: 'Card Cancel', email: member.email },
      payment: { method: 'stripe', amount: 40, currency: 'gbp', status: 'pending', stripeSessionId: `cs_cancel_${seq}` },
      status: 'pending'
    });
    assert.equal((await cancelOrder(order)).statusCode, 200);
    const row = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([row.status, row.payment.status], ['cancelled', 'failed']);
  });
});
