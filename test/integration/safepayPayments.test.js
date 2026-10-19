// The Safepay connector's service layer (services/safepay) against a real
// MongoDB and a local stand-in for Safepay's API over HTTP: a checkout is a
// tracker for exactly what the order owes, in paisa; a paid tracker
// activates its order once through the shared path (a renewal continues
// from the end of the running term); a balance is one more installment; a
// saved card is charged without the member, and a decline leaves the order
// payable; a card is kept only with consent at a gym that charges saved
// cards, sealed, never as card data.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');
const { createFakeSafepay } = require('./helpers/fakeSafepay');

const SECRET = 'sec_gym_safepay_secret';
const PUBLIC = 'pub_gym_api_key';
const WEBHOOK = 'whsec_gym_shared';

let gym;
let fake;
let Package;
let PackageOrder;
let User;
let Settings;
let safepay;
let pkg;
let member;

const DAY = 86400000;

const test = h.suite(async () => {
  fake = await createFakeSafepay({ secretKey: SECRET, publicKey: PUBLIC }).start();
  process.env.SAFEPAY_API_BASE_URL = fake.base;
  Package = h.src('gymfolio/models/packageModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  User = h.src('models/user');
  Settings = h.src('models/settings');
  safepay = h.src('services/safepay');
  gym = await h.createGym('safepay-service-gym', {
    currency: 'PKR',
    settings: {
      safepay: { enabled: true, environment: 'sandbox', publicKey: PUBLIC, secretKey: SECRET, webhookSecret: WEBHOOK },
      onlinePayments: { provider: 'safepay' },
      billing: { autoCharge: { enabled: true } }
    }
  });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    pkg = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
    member = await User.create({ firstName: 'Ayesha', lastName: 'Khan', email: 'ayesha@safepay.test', phone: '03331234567', role: 'user' });
  });
});

require('node:test').after(async () => {
  delete process.env.SAFEPAY_API_BASE_URL;
  if (fake) await fake.stop();
});

const urls = { returnUrl: 'https://safepay-service-gym.test/checkout/success?provider=safepay&order=x', cancelUrl: 'https://safepay-service-gym.test/checkout/cancel?order=x' };

async function pendingOrder(extra = {}) {
  const membership = h.src('gymfolio/services/membershipService');
  return PackageOrder.create({
    orderNumber: await PackageOrder.generateOrderNumber(),
    userId: member._id,
    packageId: pkg._id,
    packageDetails: membership.packageSnapshot(pkg, 'PKR'),
    customerInfo: { fullName: 'Ayesha Khan', email: member.email, phone: member.phone },
    payment: { method: 'online', provider: 'safepay', amount: 5000, joiningFee: 0, subtotal: 5000, currency: 'pkr', status: 'pending' },
    status: 'pending',
    ...extra
  });
}

async function setAutoCharge(enabled) {
  await Settings.updateOne({ isActive: true }, { $set: { 'billing.autoCharge.enabled': enabled } });
}

test('a checkout is one tracker for what the order owes, in paisa, with the return addresses; a wrong amount is refused', async () => {
  await h.inGym(gym, async () => {
    const order = await pendingOrder();
    await assert.rejects(safepay.createCheckout({ order, amount: 4000, ...urls }), (error) => error.code === 'AMOUNT_MISMATCH');

    const before = fake.callsTo('POST', '/order/payments/v3/').length;
    const result = await safepay.createCheckout({ order, amount: 5000, currency: 'PKR', ...urls });
    assert.equal(result.purpose, 'order');
    assert.equal(result.saveCard, false);
    const created = fake.callsTo('POST', '/order/payments/v3/').slice(before).find((call) => call.path === '/order/payments/v3/');
    assert.equal(created.headers['x-sfpy-merchant-secret'], SECRET);
    assert.deepEqual(
      { amount: created.body.amount, currency: created.body.currency, mode: created.body.mode, key: created.body.merchant_api_key, user: created.body.user },
      { amount: 500000, currency: 'PKR', mode: 'payment', key: PUBLIC, user: undefined }
    );
    assert.equal(created.body.metadata.order_id, order.orderNumber);

    const url = new URL(result.url);
    assert.equal(url.origin, fake.base);
    assert.equal(url.pathname, '/embedded/');
    assert.equal(url.searchParams.get('tracker'), result.tracker);
    assert.equal(url.searchParams.get('redirect_url'), urls.returnUrl);
    assert.equal(url.searchParams.get('cancel_url'), urls.cancelUrl);
    assert.match(url.searchParams.get('tbt'), /^tbt_/);

    const stored = await PackageOrder.findById(order._id).lean();
    assert.equal(stored.payment.provider, 'safepay');
    assert.equal(stored.payment.safepay.tracker, result.tracker);
    assert.equal(stored.payment.safepay.trackers.length, 1);
    assert.deepEqual(
      { token: stored.payment.safepay.trackers[0].token, amount: stored.payment.safepay.trackers[0].amount, minor: stored.payment.safepay.trackers[0].amountMinor, status: stored.payment.safepay.trackers[0].status },
      { token: result.tracker, amount: 5000, minor: 500000, status: 'pending' }
    );
  });
});

test('a paid tracker activates its order once, continuing after the running term, with an invoice and one confirmation', async () => {
  await h.inGym(gym, async () => {
    const membership = h.src('gymfolio/services/membershipService');
    const runningEnd = new Date(Date.now() + 5 * DAY);
    await PackageOrder.create({
      orderNumber: await PackageOrder.generateOrderNumber(),
      userId: member._id,
      packageId: pkg._id,
      packageDetails: membership.packageSnapshot(pkg, 'PKR'),
      customerInfo: { fullName: 'Ayesha Khan', email: member.email },
      payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date(Date.now() - 25 * DAY), amountPaid: 5000, balanceDue: 0 },
      subscription: { startDate: new Date(Date.now() - 25 * DAY), endDate: runningEnd, isActive: true },
      status: 'active'
    });
    const order = await pendingOrder();
    const { tracker } = await safepay.createCheckout({ order, ...urls });
    fake.pay(tracker);
    const confirmations = () => h.calls.notifications.filter((n) => n.name === 'membershipConfirmed' && String(n.args[0]._id) === String(order._id)).length;

    const first = await safepay.applyTrackerPayment(order._id, tracker, { amountMinor: 500000, currency: 'PKR', feeMinor: 17500, netMinor: 482500 });
    assert.equal(first.applied, true);
    const second = await safepay.applyTrackerPayment(order._id, tracker, { amountMinor: 500000, currency: 'PKR' });
    assert.equal(second.applied, false);
    assert.equal(second.duplicate, true);

    const paid = await PackageOrder.findById(order._id).lean();
    assert.equal(paid.payment.status, 'paid');
    assert.equal(paid.status, 'active');
    assert.equal(paid.payment.method, 'online');
    assert.equal(paid.payment.transactionId, tracker);
    assert.equal(paid.payment.safepay.fee, 175);
    assert.equal(paid.payment.safepay.net, 4825);
    assert.equal(paid.payment.safepay.trackers[0].status, 'paid');
    assert.equal(new Date(paid.subscription.startDate).getTime(), runningEnd.getTime(), 'the new term starts when the running one ends');
    assert.ok(paid.invoice && paid.invoice.number, 'an invoice number');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(confirmations(), 1);
  });
});

test('Safepay reporting less than was asked is not applied', async () => {
  await h.inGym(gym, async () => {
    const order = await pendingOrder();
    const { tracker } = await safepay.createCheckout({ order, ...urls });
    const result = await safepay.applyTrackerPayment(order._id, tracker, { amountMinor: 100, currency: 'PKR' });
    assert.equal(result.applied, false);
    assert.equal(result.mismatch, true);
    assert.equal((await PackageOrder.findById(order._id).lean()).payment.status, 'pending');
  });
});

test('a balance paid online is one more installment, recorded once', async () => {
  await h.inGym(gym, async () => {
    const order = await pendingOrder();
    await PackageOrder.updateOne(
      { _id: order._id },
      { $set: { 'payment.status': 'paid', 'payment.method': 'cash', 'payment.amountPaid': 3000, 'payment.balanceDue': 2000, 'payment.paidAt': new Date(), status: 'active' } }
    );
    await assert.rejects(safepay.createCheckout({ order: order._id, amount: 5000, ...urls }), (error) => error.code === 'AMOUNT_MISMATCH');
    const result = await safepay.createCheckout({ order: order._id, amount: 2000, ...urls });
    assert.equal(result.purpose, 'balance');
    assert.equal(fake.tracker(result.tracker).amount, 200000);
    fake.pay(result.tracker);

    assert.equal((await safepay.applyTrackerPayment(order._id, result.tracker, { amountMinor: 200000, currency: 'PKR' })).applied, true);
    assert.equal((await safepay.applyTrackerPayment(order._id, result.tracker, { amountMinor: 200000, currency: 'PKR' })).applied, false);

    const after = await PackageOrder.findById(order._id).lean();
    assert.equal(after.payment.balanceDue, 0);
    assert.equal(after.payment.amountPaid, 5000);
    assert.equal(after.payment.method, 'cash', 'the order keeps how it was sold');
    assert.equal(after.payment.installments.length, 2);
    assert.deepEqual(after.payment.installments.map((part) => [part.amount, part.method]), [[3000, 'cash'], [2000, 'online']]);
    // Nothing left to pay.
    await assert.rejects(safepay.createCheckout({ order: order._id, ...urls }), (error) => error.code === 'ORDER_NOT_PAYABLE');
  });
});

test('the card is saved only with consent, at a gym that charges saved cards, sealed and never as card data', async () => {
  await h.inGym(gym, async () => {
    // No consent: no customer at Safepay, nothing saved.
    const noConsent = await pendingOrder();
    const customersBefore = fake.callsTo('POST', '/user/customers/v1/').length;
    const plain = await safepay.createCheckout({ order: noConsent, saveCard: true, ...urls });
    assert.equal(plain.saveCard, false);
    assert.equal(fake.callsTo('POST', '/user/customers/v1/').length, customersBefore);
    assert.equal(new URL(plain.url).searchParams.get('user_id'), null);

    // Auto-charge off at the gym: not saved either, consent or not.
    await setAutoCharge(false);
    const off = await safepay.createCheckout({ order: await pendingOrder(), saveCard: true, autoPayConsent: true, ...urls });
    assert.equal(off.saveCard, false);
    await setAutoCharge(true);

    // Consent at a gym with auto-charge on: Safepay saves it, and so do we.
    const order = await pendingOrder();
    const saving = await safepay.createCheckout({ order, saveCard: true, autoPayConsent: true, ...urls });
    assert.equal(saving.saveCard, true);
    const customer = fake.callsTo('POST', '/user/customers/v1/').slice(-1)[0];
    assert.deepEqual({ first: customer.body.first_name, last: customer.body.last_name, email: customer.body.email, phone: customer.body.phone_number, guest: customer.body.is_guest }, { first: 'Ayesha', last: 'Khan', email: member.email, phone: '+923331234567', guest: false });
    const url = new URL(saving.url);
    assert.match(url.searchParams.get('user_id'), /^cus_/);
    assert.equal(url.searchParams.get('is_implicit'), 'true');
    assert.equal(fake.tracker(saving.tracker).user, url.searchParams.get('user_id'));

    fake.pay(saving.tracker, { saveCard: { token: 'pm_saved_card_1', last4: '4242', scheme: 1 } });
    assert.equal((await safepay.applyTrackerPayment(order._id, saving.tracker, { amountMinor: 500000, currency: 'PKR' })).applied, true);

    const methods = await safepay.listSavedMethods(member._id);
    assert.equal(methods.length, 1);
    assert.deepEqual(
      { brand: methods[0].brand, last4: methods[0].last4, exp: [methods[0].exp_month, methods[0].exp_year], autoPay: methods[0].auto_pay },
      { brand: 'Visa', last4: '4242', exp: [12, 2030], autoPay: true }
    );
    assert.match(methods[0].consent_text, /^I allow safepay-service-gym|^I allow Gym safepay-service-gym/);
    assert.match(methods[0].consent_text, /Visa •••• 4242 for my membership \(5,000 PKR every month\) on each due date\. I can turn this off anytime in my account\.$/);
    assert.ok(methods[0].consent_at);
    assert.equal(methods[0].token, undefined, 'the list never carries the token');

    // At rest the token is sealed, and nothing like a card number is stored.
    const raw = await h.rawDb(gym.database.name).collection('users').findOne({ _id: member._id });
    const stored = raw.billing.savedMethods[0];
    assert.match(stored.token, /^enc:v1:/);
    assert.match(stored.customerToken, /^cus_/);
    assert.doesNotMatch(JSON.stringify(raw.billing), /520000|4242424242|card_number/);
    // ...and it opens to Safepay's token for the charge.
    const ready = await safepay.autoPayMethodFor(member._id);
    assert.equal(ready.token, 'pm_saved_card_1');

    // The account's ordinary reads never carry it.
    assert.equal((await User.findById(member._id).lean()).billing, undefined);
  });
});

test('a saved card is charged without the member: paid activates the order; a decline leaves it payable with the reason', async () => {
  await h.inGym(gym, async () => {
    const method = await safepay.autoPayMethodFor(member._id);
    assert.ok(method, 'the card saved by the test above');

    const order = await pendingOrder();
    const paid = await safepay.chargeSavedMethod({ order, amount: 5000, currency: 'PKR', savedMethod: method });
    assert.equal(paid.status, 'paid', paid.reason);
    const charge = fake.callsTo('POST', `/order/payments/v3/${paid.tracker}`).find((call) => call.path === `/order/payments/v3/${paid.tracker}`);
    assert.deepEqual(charge.body, { payload: { payment_method: { tokenized_card: { token: 'pm_saved_card_1' } } } });
    assert.equal(fake.tracker(paid.tracker).mode, 'unscheduled_cof');
    assert.equal(fake.tracker(paid.tracker).user, method.customerToken);
    const after = await PackageOrder.findById(order._id).lean();
    assert.equal(after.payment.status, 'paid');
    assert.equal(after.payment.safepay.trackers[0].kind, 'auto');
    assert.equal(after.payment.safepay.trackers[0].savedMethodId, method.id);

    fake.state.declined.add('pm_saved_card_1');
    try {
      const unpaid = await pendingOrder();
      const declined = await safepay.chargeSavedMethod({ order: unpaid, amount: 5000, savedMethod: method });
      assert.equal(declined.status, 'failed');
      assert.match(declined.reason, /declined/);
      const still = await PackageOrder.findById(unpaid._id).lean();
      assert.equal(still.payment.status, 'pending', 'still payable by link');
      assert.equal(still.status, 'pending');
      assert.match(still.payment.lastPaymentError, /declined/);
      assert.equal(still.payment.safepay.trackers[0].status, 'failed');
      // The link still opens a checkout for it.
      assert.ok((await safepay.createCheckout({ order: unpaid, ...urls })).url);
    } finally {
      fake.state.declined.delete('pm_saved_card_1');
    }

    // Auto-charge switched off at the gym: nothing is charged.
    await setAutoCharge(false);
    try {
      const before = fake.callsTo('POST', '/order/payments/v3/').length;
      const off = await safepay.chargeSavedMethod({ order: await pendingOrder(), amount: 5000, savedMethod: method });
      assert.deepEqual([off.status, off.code], ['failed', 'AUTO_CHARGE_OFF']);
      assert.equal(fake.callsTo('POST', '/order/payments/v3/').length, before);
    } finally {
      await setAutoCharge(true);
    }
  });
});

test('the return page is answered from Safepay when the webhook has not arrived, and a closed session closes a new purchase', async () => {
  await h.inGym(gym, async () => {
    const order = await pendingOrder();
    const { tracker } = await safepay.createCheckout({ order, ...urls });
    assert.equal((await safepay.verifyOrderPayment(order._id)).paid, false);
    fake.pay(tracker);
    const answer = await safepay.verifyOrderPayment(order._id);
    assert.equal(answer.paid, true);
    assert.equal(answer.order.payment.status, 'paid');
    assert.equal(answer.order.payment.safepay.fee, Math.round(500000 * 0.029 + 3000) / 100);
    assert.equal(await safepay.fetchTrackerStatus(tracker), 'paid');

    const abandoned = await pendingOrder();
    const second = await safepay.createCheckout({ order: abandoned, ...urls });
    fake.setState(second.tracker, 'TRACKER_EXPIRED');
    assert.equal((await safepay.verifyOrderPayment(abandoned._id)).paid, false);
    const closed = await PackageOrder.findById(abandoned._id).lean();
    assert.deepEqual([closed.payment.status, closed.status], ['failed', 'cancelled']);

    // An order a payment link is for stays payable.
    const due = await pendingOrder({ metadata: { dueFor: String(order._id) } });
    const third = await safepay.createCheckout({ order: due, ...urls });
    fake.setState(third.tracker, 'TRACKER_CANCELLED');
    await safepay.verifyOrderPayment(due._id);
    const kept = await PackageOrder.findById(due._id).lean();
    assert.deepEqual([kept.payment.status, kept.status], ['pending', 'pending']);
  });
});

test('a gym without Safepay keys, or with Safepay switched off, cannot open a checkout', async () => {
  await h.inGym(gym, async () => {
    const order = await pendingOrder();
    await Settings.updateOne({ isActive: true }, { $set: { 'safepay.enabled': false } });
    try {
      assert.equal(await safepay.getSafepayConfig(), null);
      await assert.rejects(safepay.createCheckout({ order, ...urls }), (error) => error.code === 'SAFEPAY_NOT_CONFIGURED' && error.status === 409);
      // Payments already made can still be checked with the stored keys.
      assert.ok(await safepay.getSafepayConfig({ includeDisabled: true }));
    } finally {
      await Settings.updateOne({ isActive: true }, { $set: { 'safepay.enabled': true } });
    }
  });
});
