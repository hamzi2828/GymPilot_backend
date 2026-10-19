// The website's checkout through the gateway the gym chose, against a real
// MongoDB and a stand-in Safepay over HTTP, through the payment controller:
// a new purchase at a Safepay gym opens Safepay's hosted checkout for the
// package's own price (joining fee and coupon as with Stripe; nothing the
// browser sends sets an amount) and returns to the gym site's success page,
// whose verify call answers by order id; a member pays a balance or a due
// renewal online; a gym on Stripe still sells through Stripe exactly as
// before, and a bank-transfer-only gym is told to use the bank transfer.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');
const { createFakeSafepay } = require('./helpers/fakeSafepay');

const SECRET = 'sec_checkout_secret';
const PUBLIC = 'pub_checkout_key';
const SAFEPAY_READY = {
  safepay: { enabled: true, environment: 'sandbox', publicKey: PUBLIC, secretKey: SECRET, webhookSecret: 'whsec_checkout' },
  onlinePayments: { provider: 'safepay' },
  billing: { autoCharge: { enabled: true } }
};

let fake;
let gym;
let stripeGym;
let bankGym;
let controller;
let Package;
let PackageOrder;
let User;
let Coupon;
let pkg;
let member;
let other;

const test = h.suite(async () => {
  fake = await createFakeSafepay({ secretKey: SECRET, publicKey: PUBLIC }).start();
  process.env.SAFEPAY_API_BASE_URL = fake.base;
  controller = h.src('gymfolio/controller/gymfolioPaymentController');
  Package = h.src('gymfolio/models/packageModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  User = h.src('models/user');
  Coupon = h.src('gymfolio/models/couponModel');
  gym = await h.createGym('safepay-checkout-gym', { currency: 'PKR', settings: SAFEPAY_READY });
  stripeGym = await h.createGym('still-stripe-gym', {
    currency: 'GBP',
    settings: { stripe: { enabled: true, publishableKey: 'pk_test_x', secretKey: 'sk_test_x', webhookSecret: 'whsec_x' }, safepay: SAFEPAY_READY.safepay }
  });
  bankGym = await h.createGym('bank-only-gym', { currency: 'PKR', settings: { onlinePayments: { provider: 'generic' } } });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    pkg = await Package.create({ name: 'Monthly', price: '5,000', currency: 'PKR', period: 'month', joiningFee: 1000, features: ['Gym floor'] });
    await Coupon.create({ code: 'SAVE500', type: 'amount', value: 500, currency: 'PKR' });
    member = await User.create({ firstName: 'Bilal', lastName: 'Ahmed', email: 'bilal@checkout.test', emailVerified: true, phone: '03001234567', role: 'user' });
    other = await User.create({ firstName: 'Other', lastName: 'Member', email: 'other@checkout.test', role: 'user' });
  });
});

require('node:test').after(async () => {
  delete process.env.SAFEPAY_API_BASE_URL;
  if (fake) await fake.stop();
});

const customerInfo = { fullName: 'Bilal Ahmed', email: 'bilal@checkout.test', phone: '03001234567', country: 'PK' };
const checkout = (body, user = member) =>
  h.call(controller.createPackageCheckoutSession, { body: { packageId: String(pkg._id), customerInfo, ...body }, user: user ? { id: String(user._id) } : undefined });
const verify = (id, query = {}) => h.call(controller.verifyPackagePayment, { params: { sessionId: id }, query });
const payOnline = (order, body = {}, user = member) => h.call(controller.payOrderOnline, { params: { id: String(order._id) }, body, user: { id: String(user._id) } });

function lastTracker() {
  return fake.callsTo('POST', '/order/payments/v3/').filter((call) => call.path === '/order/payments/v3/').slice(-1)[0];
}

test('a new purchase opens Safepay for the package price, joining fee and coupon included, whatever the browser says it costs', async () => {
  await h.inGym(gym, async () => {
    const res = await checkout({ couponCode: 'save500', amount: 1, price: 1 });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.provider, 'safepay');
    assert.equal(res.body.sessionId, undefined);
    assert.match(res.body.orderNumber, /^PKG/);

    const order = await PackageOrder.findById(res.body.orderId).lean();
    assert.equal(order.payment.method, 'online');
    assert.equal(order.payment.provider, 'safepay');
    assert.equal(order.payment.status, 'pending');
    assert.deepEqual([order.payment.amount, order.payment.joiningFee, order.payment.discountAmount, order.payment.subtotal], [5500, 1000, 500, 6000]);
    assert.equal(String(order.userId), String(member._id));
    assert.equal(lastTracker().body.amount, 550000, 'paisa');

    const url = new URL(res.body.url);
    assert.equal(url.pathname, '/embedded/');
    assert.equal(url.searchParams.get('redirect_url'), `http://safepay-checkout-gym.test/checkout/success?provider=safepay&order=${res.body.orderId}`);
    assert.equal(url.searchParams.get('cancel_url'), `http://safepay-checkout-gym.test/checkout/cancel?order=${res.body.orderId}`);
  });
});

test('the success page is answered by order id: not yet, then paid once Safepay says so, with the membership running', async () => {
  await h.inGym(gym, async () => {
    const res = await checkout({});
    const id = res.body.orderId;
    let answer = await verify(id);
    assert.equal(answer.statusCode, 200);
    assert.deepEqual([answer.body.success, answer.body.paid], [false, false]);

    fake.pay(new URL(res.body.url).searchParams.get('tracker'));
    answer = await verify(id);
    assert.deepEqual([answer.body.success, answer.body.paid], [true, true]);
    assert.equal(answer.body.order.status, 'active');
    assert.equal(answer.body.order.provider, 'safepay');
    assert.equal(answer.body.order.packageName, 'Monthly');
    // Only what the page shows: no payer details.
    assert.equal(answer.body.order.customerInfo, undefined);
    // As the success page asks: ?provider=safepay with the order id.
    const asked = await verify(id, { provider: 'safepay' });
    assert.deepEqual([asked.statusCode, asked.body.success, asked.body.paid, asked.body.order.orderNumber], [200, true, true, res.body.orderNumber]);
    // An id with no order is not found, with or without the provider; so is a session id sent as a Safepay order.
    for (const [missing, query] of [['64b7f0c2a1b2c3d4e5f60718', {}], ['64b7f0c2a1b2c3d4e5f60718', { provider: 'safepay' }], ['cs_test_abc', { provider: 'safepay' }]]) {
      const answer = await verify(missing, query);
      assert.deepEqual([answer.statusCode, answer.body.code], [404, 'ORDER_NOT_FOUND'], `${missing} ${JSON.stringify(query)}`);
    }
  });
});

test('a card is saved only when the member asks and agrees, signed in, at a gym with auto-charge on', async () => {
  await h.inGym(gym, async () => {
    const asked = await checkout({ saveCard: true, autoPayConsent: true });
    assert.equal(asked.body.saveCard, true);
    assert.match(new URL(asked.body.url).searchParams.get('user_id'), /^cus_/);

    for (const body of [{ saveCard: true }, { saveCard: 'true', autoPayConsent: 'true' }, { autoPayConsent: true }]) {
      const res = await checkout(body);
      assert.equal(res.body.saveCard, false, JSON.stringify(body));
      assert.equal(new URL(res.body.url).searchParams.get('user_id'), null);
    }
    const guest = await checkout({ saveCard: true, autoPayConsent: true }, null);
    assert.equal(guest.statusCode, 200, JSON.stringify(guest.body));
    assert.equal(guest.body.saveCard, false, 'a guest has no account to keep a card on');
  });
});

test('Safepay unreachable: the member is told, and the order is closed rather than left pending', async () => {
  await h.inGym(gym, async () => {
    const before = await PackageOrder.countDocuments({});
    fake.state.unreachable = true;
    let res;
    try {
      res = await checkout({});
    } finally {
      fake.state.unreachable = false;
    }
    assert.equal(res.statusCode, 502, JSON.stringify(res.body));
    assert.equal(res.body.code, 'SAFEPAY_UNREACHABLE');
    const order = await PackageOrder.findOne({}).sort({ createdAt: -1 }).lean();
    assert.equal(await PackageOrder.countDocuments({}), before + 1);
    assert.deepEqual([order.payment.status, order.status], ['failed', 'cancelled']);
  });
});

test('a member pays the balance of their own part-paid order online, once, and the page asks about that payment', async () => {
  await h.inGym(gym, async () => {
    const membership = h.src('gymfolio/services/membershipService');
    const order = await PackageOrder.create({
      orderNumber: await PackageOrder.generateOrderNumber(),
      userId: member._id,
      packageId: pkg._id,
      packageDetails: membership.packageSnapshot(pkg, 'PKR'),
      customerInfo: { fullName: 'Bilal Ahmed', email: member.email },
      payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date(), amountPaid: 3500, balanceDue: 1500 },
      subscription: { startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000), isActive: true },
      status: 'active'
    });

    assert.equal((await payOnline(order, {}, other)).statusCode, 404, 'not their order');
    const res = await payOnline(order, { amount: 1 });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.purpose, res.body.amount, res.body.provider], ['balance', 1500, 'safepay']);
    assert.equal(lastTracker().body.amount, 150000);
    const back = new URL(new URL(res.body.url).searchParams.get('redirect_url'));
    assert.equal(back.searchParams.get('order'), String(order._id));
    assert.equal(back.searchParams.get('tracker'), res.body.reference);

    // Already paid as an order, so the page asks about this payment.
    assert.equal((await verify(String(order._id), { tracker: res.body.reference })).body.paid, false);
    assert.equal((await verify(String(order._id), { tracker: 'track_not_ours' })).body.paid, false);
    fake.pay(res.body.reference);
    assert.equal((await verify(String(order._id), { tracker: res.body.reference })).body.paid, true);
    assert.equal((await verify(String(order._id), { tracker: res.body.reference })).body.paid, true);
    const after = await PackageOrder.findById(order._id).lean();
    assert.deepEqual([after.payment.balanceDue, after.payment.amountPaid, after.payment.installments.length], [0, 5000, 2]);

    const nothing = await payOnline(order);
    assert.equal(nothing.statusCode, 409);
    assert.equal(nothing.body.code, 'ORDER_NOT_PAYABLE');
  });
});

test('an unpaid renewal raised for online payment can be paid; a bank transfer waiting for review cannot be turned into one', async () => {
  await h.inGym(gym, async () => {
    const membership = h.src('gymfolio/services/membershipService');
    const base = {
      userId: member._id,
      packageId: pkg._id,
      packageDetails: membership.packageSnapshot(pkg, 'PKR'),
      customerInfo: { fullName: 'Bilal Ahmed', email: member.email },
      status: 'pending'
    };
    const due = await PackageOrder.create({ ...base, orderNumber: await PackageOrder.generateOrderNumber(), payment: { method: 'online', amount: 5000, currency: 'pkr', status: 'pending' }, metadata: { dueFor: 'x' } });
    const res = await payOnline(due, { saveCard: true, autoPayConsent: true });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.purpose, res.body.amount, res.body.saveCard], ['order', 5000, true]);

    const transfer = await PackageOrder.create({ ...base, orderNumber: await PackageOrder.generateOrderNumber(), payment: { method: 'bank_transfer', amount: 5000, currency: 'pkr', status: 'processing' } });
    const refused = await payOnline(transfer);
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.code, 'ORDER_NOT_PAYABLE');
  });
});

test('a gym on Stripe sells through Stripe exactly as before, and Safepay is never asked', async () => {
  const sessions = [];
  h.setStripe({
    checkout: {
      sessions: {
        create: async (params) => {
          sessions.push(params);
          return { id: `cs_still_${sessions.length}`, url: 'https://stripe.test/pay' };
        }
      }
    }
  });
  try {
    await h.inGym(stripeGym, async () => {
      const yearly = await Package.create({ name: 'Yearly', price: '300', currency: 'GBP', period: 'year', features: ['All'] });
      const before = fake.calls.length;
      const res = await h.call(controller.createPackageCheckoutSession, { body: { packageId: String(yearly._id), customerInfo: { fullName: 'Sam Stone', email: 'sam@stripe.test' }, saveCard: true, autoPayConsent: true } });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.provider, res.body.sessionId, res.body.url], ['stripe', 'cs_still_1', 'https://stripe.test/pay']);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].success_url.includes('{CHECKOUT_SESSION_ID}'), true);
      assert.equal(fake.calls.length, before, 'Safepay is not called for a Stripe gym');
      const order = await PackageOrder.findOne({ 'payment.stripeSessionId': 'cs_still_1' }).lean();
      assert.equal(order.payment.method, 'stripe');
      assert.equal(order.payment.provider, undefined);

      const methods = (await h.call(controller.paymentMethods, {})).body.data;
      assert.deepEqual([methods.card, methods.online], [true, { provider: 'stripe', label: 'Card', checkout: true, auto_pay_available: false }]);
      // A Stripe order is not answered as a Safepay one.
      const asSafepay = await h.call(controller.verifyPackagePayment, { params: { sessionId: String(order._id) }, query: { provider: 'safepay' } });
      assert.deepEqual([asSafepay.statusCode, asSafepay.body.code], [404, 'ORDER_NOT_FOUND']);
    });
  } finally {
    h.setStripe(null);
  }
});

test('a bank-transfer-only gym is told to pay by bank transfer', async () => {
  await h.inGym(bankGym, async () => {
    const Bank = h.src('models/bank');
    await Bank.create({ name: 'HBL', accountTitle: 'Bank Only Gym', accountNumber: '1234' });
    const local = await Package.create({ name: 'Monthly', price: '4000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
    const res = await h.call(controller.createPackageCheckoutSession, { body: { packageId: String(local._id), customerInfo: { fullName: 'A B', email: 'a@b.test' } } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'BANK_TRANSFER_ONLY');
    assert.match(res.body.message, /bank transfer/);
    assert.equal(await PackageOrder.countDocuments({}), 0, 'no order is made');
  });
});

test("the member is sent back to the gym's primary domain: not the address the request came in on, not a stale Settings site address", async () => {
  const { runWithTenant } = h.src('platform/tenantContext');
  const Settings = h.src('models/settings');
  const moved = { ...gym, domains: [{ host: 'old-alias.test' }, { host: 'www.primary-gym.com', isPrimary: true }] };
  await runWithTenant({ gym: moved, origin: 'http://old-alias.test' }, async () => {
    await Settings.updateOne({ isActive: true }, { $set: { siteUrl: 'https://stale.example' } });
    const res = await checkout({});
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const url = new URL(res.body.url);
    assert.equal(url.searchParams.get('redirect_url'), `https://www.primary-gym.com/checkout/success?provider=safepay&order=${res.body.orderId}`);
    assert.equal(url.searchParams.get('cancel_url'), `https://www.primary-gym.com/checkout/cancel?order=${res.body.orderId}`);
  });
});
