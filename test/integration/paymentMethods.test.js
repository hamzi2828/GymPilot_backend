// Payment methods at the desk: the mobile wallets are recorded as
// themselves, and a method nobody knows is refused (422) instead of being
// filed as cash -- which used to make the desk's takings by method wrong
// without anyone being told.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let PackageOrder;
let Package;
let User;
let orders;
let lifecycle;
let invoices;
let pkg;
let member;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  lifecycle = h.src('gymfolio/controller/membershipController');
  invoices = h.src('services/invoiceService');
  gym = await h.createGym('methods-gym', { currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    pkg = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
    member = await User.create({ firstName: 'Wallet', lastName: 'Payer', email: 'wallet@methods.test', role: 'user' });
  });
});

const staff = { id: 'staff', email: 'desk@methods.test' };
const assign = (body) =>
  h.call(orders.assignPackageToUser, { body: { userId: String(member._id), packageId: String(pkg._id), ...body }, user: staff });

test('JazzCash, Easypaisa and other wallets are recorded as themselves', async () => {
  await h.inGym(gym, async () => {
    for (const method of ['jazzcash', 'easypaisa', 'wallet', 'card', 'bank_transfer']) {
      const res = await assign({ paymentMethod: method });
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.payment.method, method);
    }
    // Nothing sent is cash, as it always was.
    const plain = await assign({});
    assert.equal(plain.body.data.payment.method, 'cash');
  });
});

test('an unknown method is a 422 and nothing is created', async () => {
  await h.inGym(gym, async () => {
    const before = await PackageOrder.countDocuments({});
    for (const method of ['paypal', 'Cash', 'stripe']) {
      const res = await assign({ paymentMethod: method });
      assert.equal(res.statusCode, 422, `${method}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'PAYMENT_METHOD_INVALID');
    }
    assert.equal(await PackageOrder.countDocuments({}), before);
  });
});

test('renewing with an unknown method is refused too, and nothing is renewed', async () => {
  await h.inGym(gym, async () => {
    const first = await assign({ paymentMethod: 'cash' });
    const id = first.body.data._id;
    const res = await h.call(lifecycle.renew, { params: { id }, body: { paymentMethod: 'venmo' }, user: staff });
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.equal(await PackageOrder.countDocuments({ renewedFrom: id }), 0);

    const ok = await h.call(lifecycle.renew, { params: { id }, body: { paymentMethod: 'easypaisa' }, user: staff });
    assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.payment.method, 'easypaisa');
  });
});

test('the invoice of a wallet payment renders', async () => {
  await h.inGym(gym, async () => {
    const res = await assign({ paymentMethod: 'jazzcash' });
    const order = await PackageOrder.findById(res.body.data._id);
    await invoices.ensureInvoice(order);
    const pdf = await invoices.renderInvoicePdf(order);
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  });
});

test('a member at a gym without card payments is told what to do, not about Stripe keys', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(orders.createPackageCheckoutSession, {
      body: { packageId: String(pkg._id), customerInfo: { email: member.email, fullName: 'Wallet Payer' } },
      user: { id: String(member._id) }
    });
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'STRIPE_NOT_CONFIGURED');
    assert.match(res.body.message, /Card payment isn't available at this gym — please choose bank transfer/);
    assert.doesNotMatch(res.body.message, /Stripe|Settings/);
    assert.equal(await PackageOrder.countDocuments({ 'payment.method': 'stripe' }), 0);
  });
});
