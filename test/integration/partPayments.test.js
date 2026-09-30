// Paying for a membership in parts: the desk grants it on part of the money
// (or none), the rest is a balance due, each later payment is recorded
// against it, and the dues list says who still owes what. The money
// received -- never the money owed -- is what the accounts count.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let PackageOrder;
let Package;
let User;
let orders;
let lifecycle;
let lists;
let service;
let L;
let invoices;
let monthly;
let gold;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  lifecycle = h.src('gymfolio/controller/membershipController');
  lists = h.src('gymfolio/controller/membershipListsController');
  service = h.src('gymfolio/services/membershipService');
  L = h.src('accounts/services/ledger');
  invoices = h.src('services/invoiceService');
  gym = await h.createGym('dues-gym', { timezone: 'UTC', currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'], joiningFee: 2000 });
    gold = await Package.create({ name: 'Gold', price: '8000', currency: 'PKR', period: 'month', features: ['Everything'] });
  });
});

let staffAccount;
let seq = 0;
async function member(extra = {}) {
  seq += 1;
  return User.create({ firstName: 'Owes', lastName: `Member${seq}`, email: `owes${seq}@dues.test`, phone: `0300000000${seq}`, role: 'user', ...extra });
}
async function staff() {
  if (!staffAccount) staffAccount = await User.create({ firstName: 'Front', lastName: 'Desk', email: 'desk@dues.test', role: 'admin' });
  return { id: String(staffAccount._id), email: staffAccount.email };
}
const assign = async (who, body = {}) =>
  h.call(orders.assignPackageToUser, { body: { userId: String(who._id), packageId: String(monthly._id), ...body }, user: await staff() });
const pay = async (order, body) => h.call(lifecycle.recordPayment, { params: { id: String(order._id) }, body, user: await staff() });

test('granted on part of the money: paid and active, the rest a balance, the part its first installment', async () => {
  await h.inGym(gym, async () => {
    const res = await assign(await member(), { amountPaid: 3000, paymentMethod: 'jazzcash' });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const o = res.body.data;
    assert.equal(o.payment.status, 'paid');
    assert.equal(o.status, 'active');
    assert.equal(o.payment.amount, 7000);
    assert.equal(o.payment.amountPaid, 3000);
    assert.equal(o.payment.balanceDue, 4000);
    assert.equal(o.payment.installments.length, 1);
    const [first] = o.payment.installments;
    // Admission first: the 2000 fee is settled before the membership.
    assert.deepEqual([first.amount, first.joiningFee, first.trainerFee, first.method], [3000, 2000, 0, 'jazzcash']);
    assert.equal(String(first.by), String(staffAccount._id));
  });
});

test('paid in full at once, or nothing yet', async () => {
  await h.inGym(gym, async () => {
    const full = (await assign(await member(), {})).body.data;
    assert.equal(full.payment.amountPaid, 7000);
    assert.equal(full.payment.balanceDue, 0);
    assert.equal(full.payment.installments.length, 0);

    const nothing = (await assign(await member(), { amountPaid: 0 })).body.data;
    assert.equal(nothing.payment.status, 'paid');
    assert.equal(nothing.payment.amountPaid, 0);
    assert.equal(nothing.payment.balanceDue, 7000);
    assert.equal(nothing.payment.installments.length, 0);
  });
});

test('amountPaid that cannot be right is refused', async () => {
  await h.inGym(gym, async () => {
    const who = await member();
    const over = await assign(who, { amountPaid: 9000 });
    assert.equal(over.statusCode, 400);
    assert.match(over.body.message, /cannot be more than the 7000 charged/);
    const pending = await assign(who, { amountPaid: 1000, markPaid: false });
    assert.equal(pending.statusCode, 400);
    assert.match(pending.body.message, /left pending has nothing paid/);
    assert.equal((await assign(who, { amountPaid: -1 })).statusCode, 400);
    assert.equal(await PackageOrder.countDocuments({ userId: who._id }), 0);
  });
});

test('payments against the balance: fees owed first, down to paid in full, then nothing more', async () => {
  await h.inGym(gym, async () => {
    const o = (await assign(await member(), { amountPaid: 1500 })).body.data;

    let res = await pay(o, { amount: 1000, method: 'easypaisa', note: 'Second week' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /PKR 4500.00 still due/);
    let p = res.body.data.payment;
    assert.equal(p.amountPaid, 2500);
    assert.equal(p.balanceDue, 4500);
    // 500 of the fee was still owed after the first 1500: it comes first.
    assert.deepEqual(p.installments.map((i) => [i.amount, i.joiningFee, i.method, i.note]), [
      [1500, 1500, 'cash', ''],
      [1000, 500, 'easypaisa', 'Second week']
    ]);

    // Method left out: the order's own.
    res = await pay(o, { amount: '4,500' });
    p = res.body.data.payment;
    assert.match(res.body.message, /Paid in full/);
    assert.equal(p.balanceDue, 0);
    assert.equal(p.amountPaid, 7000);
    assert.equal(p.installments[2].method, 'cash');
    assert.equal(p.installments[2].joiningFee, 0);

    res = await pay(o, { amount: 1 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'NO_BALANCE');
  });
});

test('a payment that cannot be taken is refused', async () => {
  await h.inGym(gym, async () => {
    const o = (await assign(await member(), { amountPaid: 1000 })).body.data;
    for (const [body, status, code] of [
      [{ amount: 0 }, 400, 'INVALID_PAYMENT'],
      [{ amount: -50 }, 400, 'INVALID_PAYMENT'],
      [{ amount: 'lots' }, 400, 'INVALID_PAYMENT'],
      [{ amount: 6001 }, 400, 'OVERPAYMENT'],
      [{ amount: 100, method: 'paypal' }, 422, 'PAYMENT_METHOD_INVALID']
    ]) {
      const res = await pay(o, body);
      assert.equal(res.statusCode, status, JSON.stringify(body));
      assert.equal(res.body.code, code);
    }
    const fresh = await PackageOrder.findById(o._id).lean();
    assert.equal(fresh.payment.balanceDue, 6000);
    assert.equal(fresh.payment.installments.length, 1);

    // A card subscription is Stripe's to collect.
    const card = await PackageOrder.create({
      orderNumber: 'DUES-CARD',
      userId: staffAccount._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'Card Payer', email: 'card@dues.test' },
      payment: { method: 'stripe', amount: 5000, currency: 'pkr', status: 'paid', stripeSubscriptionId: 'sub_dues', balanceDue: 100 },
      status: 'active'
    });
    const res = await pay(card, { amount: 100 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'STRIPE_BILLED');
  });
});

test('two people recording the same payment take it off once', async () => {
  await h.inGym(gym, async () => {
    const o = (await assign(await member(), { amountPaid: 1000 })).body.data;
    const stale = await PackageOrder.findById(o._id);
    const again = await PackageOrder.findById(o._id);
    await service.recordPayment(stale, { amount: 2000 });
    await assert.rejects(service.recordPayment(again, { amount: 2000 }), (error) => error.code === 'BALANCE_CHANGED' && error.status === 409);
    const fresh = await PackageOrder.findById(o._id).lean();
    assert.equal(fresh.payment.balanceDue, 4000);
    assert.equal(fresh.payment.installments.length, 2);
  });
});

test('an order paid in part at once gets that payment as its first installment when the next arrives', async () => {
  await h.inGym(gym, async () => {
    // As another writer (an import, say) might leave it: amountPaid, no parts.
    const paidAt = new Date(Date.now() - 3 * 86400000);
    const order = await PackageOrder.create({
      orderNumber: 'DUES-AT-ONCE',
      userId: (await member())._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'At Once' },
      payment: { method: 'bank_transfer', amount: 7000, joiningFee: 2000, currency: 'pkr', status: 'paid', paidAt, amountPaid: 3000, balanceDue: 4000 },
      status: 'active'
    });
    const updated = await service.recordPayment(order, { amount: 4000 });
    const parts = updated.payment.installments.map((i) => [i.amount, i.joiningFee, i.method, new Date(i.at).getTime() === paidAt.getTime()]);
    assert.deepEqual(parts, [
      [3000, 2000, 'bank_transfer', true],
      [4000, 0, 'bank_transfer', false]
    ]);
  });
});

test('the accounts count the money received, in the period each part arrived', async () => {
  await h.inGym(gym, async () => {
    const o = (await assign(await member(), { amountPaid: 2500, paymentMethod: 'cash' })).body.data;
    await pay(o, { amount: 1500, method: 'wallet' });
    const today = new Date().toISOString().slice(0, 10);
    const rows = await PackageOrder.aggregate(L.membershipPaymentStages(L.readRange({ from: today, to: today }), { orderNumber: o.orderNumber }));
    assert.deepEqual(
      rows.map((r) => [r.kind, r.amount, r.admission, r.membership, r.method]).sort(),
      [
        ['initial', 2500, 2000, 500, 'cash'],
        ['installment', 1500, 0, 1500, 'wallet']
      ]
    );
  });
});

test('the dues list: one row per member, largest first, with the orders behind it', async () => {
  await h.inGym(gym, async () => {
    const owes = await member({ gender: 'female', memberCode: 'GP-0042' });
    const a = (await assign(owes, { amountPaid: 6000 })).body.data; // 1000 due
    await h.call(lifecycle.renew, { params: { id: String(a._id) }, body: { amountPaid: 1000 }, user: await staff() }); // 4000 due
    const res = await h.call(lists.dues, { query: { search: owes.lastName } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 1);
    const row = res.body.data[0];
    assert.equal(row.memberId, String(owes._id));
    assert.equal(row.name, `Owes ${owes.lastName}`);
    assert.equal(row.phone, owes.phone);
    assert.equal(row.email, owes.email);
    assert.equal(row.gender, 'female');
    assert.equal(row.memberCode, 'GP-0042');
    assert.equal(row.currency, 'PKR');
    assert.equal(row.balanceDue, 5000);
    assert.equal(row.orders.length, 2);
    assert.deepEqual(row.orders.map((order) => order.balanceDue).sort(), [1000, 4000]);
    assert.deepEqual(res.body.totals, [{ currency: 'PKR', balanceDue: 5000, members: 1, orders: 2 }]);

    const all = await h.call(lists.dues, { query: {} });
    const balances = all.body.data.map((r) => r.balanceDue);
    assert.deepEqual(balances, [...balances].sort((x, y) => y - x), 'largest balance first');
    assert.ok(all.body.data.every((r) => r.balanceDue > 0));
  });
});

test('the orders list filters to those with a balance due', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(orders.getAllOrders, { query: { hasDues: '1', limit: '200' } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data.length > 0);
    assert.ok(res.body.data.every((o) => o.payment.balanceDue > 0));
  });
});

test('refunding an order paid in part gives back what came in, and clears the balance', async () => {
  await h.inGym(gym, async () => {
    const o = await PackageOrder.findById((await assign(await member(), { amountPaid: 2000 })).body.data._id);
    await assert.rejects(service.refund(o, { amount: 2500 }), /cannot exceed the 2000 that was paid/);
    await service.refund(o, { reason: 'moved away' });
    const fresh = await PackageOrder.findById(o._id).lean();
    assert.equal(fresh.payment.status, 'refunded');
    assert.equal(fresh.refund.amount, 2000);
    assert.equal(fresh.payment.balanceDue, 0);

    const none = await PackageOrder.findById((await assign(await member(), { amountPaid: 0 })).body.data._id);
    await assert.rejects(service.refund(none, {}), /Nothing has been paid on this order yet/);
  });
});

test('no payment is taken while the order is being refunded: it would be neither refunded nor owed', async () => {
  await h.inGym(gym, async () => {
    const o = (await assign(await member(), { amountPaid: 2000 })).body.data;
    // A refund under way holds its claim on the order (membershipService.refund).
    await PackageOrder.collection.updateOne({ _id: new h.state.mongoose.Types.ObjectId(String(o._id)) }, { $set: { 'refund.claimedAt': new Date() } });
    const res = await pay(o, { amount: 1000 });
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'REFUND_IN_PROGRESS');
    const fresh = await PackageOrder.findById(o._id).lean();
    assert.equal(fresh.payment.amountPaid, 2000);
    assert.equal(fresh.payment.balanceDue, 5000);

    // Claimed after the desk loaded the order: the write itself refuses.
    const loaded = await PackageOrder.findById(o._id);
    loaded.refund = undefined;
    await assert.rejects(service.recordPayment(loaded, { amount: 1000 }), (error) => error.code === 'REFUND_IN_PROGRESS' && error.status === 409);

    // A claim left by a refund that died long ago holds nothing up.
    await PackageOrder.collection.updateOne(
      { _id: new h.state.mongoose.Types.ObjectId(String(o._id)) },
      { $set: { 'refund.claimedAt': new Date(Date.now() - 60 * 60 * 1000) } }
    );
    assert.equal((await pay(o, { amount: 1000 })).statusCode, 200);
  });
});

test('a package cannot be changed while money is owed on it', async () => {
  await h.inGym(gym, async () => {
    const o = (await assign(await member(), { amountPaid: 2000 })).body.data;
    const res = await h.call(lifecycle.changePackage, { params: { id: String(o._id) }, body: { packageId: String(gold._id) }, user: await staff() });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'BALANCE_DUE');
  });
});

test('the invoice of an order paid in part renders', async () => {
  await h.inGym(gym, async () => {
    const o = await PackageOrder.findById((await assign(await member(), { amountPaid: 2000 })).body.data._id);
    await service.recordPayment(o, { amount: 1000, method: 'jazzcash' });
    const fresh = await PackageOrder.findById(o._id);
    const pdf = await invoices.renderInvoicePdf(fresh);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  });
});
