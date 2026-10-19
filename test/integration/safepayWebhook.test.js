// Safepay end to end over HTTP, through index.js as it runs (body parsing,
// the tenant gate, the routes), against a real MongoDB and a stand-in
// Safepay on a local port: the website's checkout opens Safepay's page; the
// webhook at /api/payments/safepay/webhook/<gym> gets the exact bytes
// Safepay signed, is believed only with that gym's secret, and marks the
// order paid once however often it is delivered; the success page's verify
// call answers by order id; a card is kept only when the member agreed; a
// failed attempt leaves the order payable; and Stripe's webhook is as it was.

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');
const { createFakeSafepay } = require('./helpers/fakeSafepay');

const INDEX = path.resolve(__dirname, '..', '..', 'index.js');
const SLUG = 'safepay-http-gym';
const OTHER_SLUG = 'another-safepay-gym';
const SECRET = 'sec_http_secret';
const PUBLIC = 'pub_http_key';
const WEBHOOK = 'whsec_http_gym';
const OTHER_WEBHOOK = 'whsec_another_gym';

let fake;
let server;
let base;
let gym;
let otherGym;
let Package;
let PackageOrder;
let User;
let pkg;
let member;

const ready = (webhookSecret) => ({
  safepay: { enabled: true, environment: 'sandbox', publicKey: PUBLIC, secretKey: SECRET, webhookSecret },
  onlinePayments: { provider: 'safepay' },
  billing: { autoCharge: { enabled: true } }
});

const test = h.suite(async () => {
  fake = await createFakeSafepay({ secretKey: SECRET, publicKey: PUBLIC }).start();
  process.env.SAFEPAY_API_BASE_URL = fake.base;
  gym = await h.createGym(SLUG, { currency: 'PKR', settings: ready(WEBHOOK) });
  otherGym = await h.createGym(OTHER_SLUG, { currency: 'PKR', settings: ready(OTHER_WEBHOOK) });
  Package = h.src('gymfolio/models/packageModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  User = h.src('models/user');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    pkg = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
    member = await User.create({ firstName: 'Sana', lastName: 'Iqbal', email: 'sana@http.test', emailVerified: true, phone: '03211234567', role: 'user' });
  });

  // index.js as it runs, served on a port of our own; .env never read.
  const dotenvPath = require.resolve('dotenv');
  require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config: () => ({ parsed: {} }) } };
  const express = require('express');
  const listen = express.application.listen;
  let app;
  express.application.listen = function captured() {
    app = this;
    return { close() {} };
  };
  try {
    require(INDEX);
  } finally {
    express.application.listen = listen;
  }
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

require('node:test').after(async () => {
  delete process.env.SAFEPAY_API_BASE_URL;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake) await fake.stop();
});

function tokenFor(user) {
  return jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

async function api(method, url, { body, user, headers = {}, slug = SLUG } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(slug ? { 'x-tenant-slug': slug } : {}),
      ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

// What Safepay's servers send: no website, no tenant header, the signed bytes.
function deliver(gymSlug, { body, signature }) {
  return api('POST', `/api/payments/safepay/webhook/${gymSlug}`, { body, slug: null, headers: { 'X-SFPY-SIGNATURE': signature } });
}

async function buy(body = {}, user = member) {
  const res = await api('POST', '/api/gymfolio/payment/create-package-checkout-session', {
    user,
    body: { packageId: String(pkg._id), customerInfo: { fullName: 'Sana Iqbal', email: 'sana@http.test', phone: '03211234567' }, ...body }
  });
  assert.equal(res.status, 200, res.text);
  return { ...res.body, tracker: new URL(res.body.url).searchParams.get('tracker') };
}

const orderOf = (id) => h.inGym(gym, () => PackageOrder.findById(id).lean());
const confirmationsFor = (id) => h.calls.notifications.filter((n) => n.name === 'membershipConfirmed' && String(n.args[0]._id) === String(id)).length;

test('the checkout over HTTP opens Safepay; the signed webhook marks the order paid once, however often it comes', async () => {
  const sale = await buy();
  assert.equal(sale.provider, 'safepay');
  assert.ok(fake.tracker(sale.tracker), 'the tracker exists at Safepay');

  fake.pay(sale.tracker);
  const event = fake.event(sale.tracker, 'payment.succeeded', { secret: WEBHOOK, fee: 17500 });
  const first = await deliver(SLUG, event);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body, { received: true, applied: true });

  const second = await deliver(SLUG, event);
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.body, { received: true, applied: false });
  // A second event for the same payment (Safepay sends one per attempt) changes nothing either.
  assert.equal((await deliver(SLUG, fake.event(sale.tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, false);

  const order = await orderOf(sale.orderId);
  assert.deepEqual([order.payment.status, order.status, order.payment.method, order.payment.provider], ['paid', 'active', 'online', 'safepay']);
  assert.equal(order.payment.safepay.tracker, sale.tracker);
  assert.equal(order.payment.safepay.fee, 175);
  assert.ok(order.invoice.number);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(confirmationsFor(sale.orderId), 1, 'one confirmation for one payment');

  // The success page's verify call, by order id.
  const verified = await api('GET', `/api/gymfolio/payment/verify/${sale.orderId}`);
  assert.equal(verified.status, 200, verified.text);
  assert.deepEqual([verified.body.paid, verified.body.order.status], [true, 'active']);
});

test('a bad signature is refused and changes nothing', async () => {
  const sale = await buy();
  fake.pay(sale.tracker);
  const event = fake.event(sale.tracker, 'payment.succeeded', { secret: 'not-the-gyms-secret' });
  const res = await deliver(SLUG, event);
  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.received, false);

  const tampered = fake.event(sale.tracker, 'payment.succeeded', { secret: WEBHOOK });
  const changed = await deliver(SLUG, { body: tampered.body.replace('"amount":500000', '"amount":5'), signature: tampered.signature });
  assert.equal(changed.status, 400);
  assert.equal((await deliver(SLUG, { body: tampered.body, signature: '' })).status, 400);
  assert.equal((await orderOf(sale.orderId)).payment.status, 'pending');
});

test('a webhook for the wrong gym is refused: an unknown slug, or another gym whose secret did not sign it', async () => {
  const sale = await buy();
  fake.pay(sale.tracker);
  const event = fake.event(sale.tracker, 'payment.succeeded', { secret: WEBHOOK });

  const unknown = await deliver('no-such-gym', event);
  assert.equal(unknown.status, 404, unknown.text);

  // Delivered to another gym's address: checked with THAT gym's secret, and refused.
  const elsewhere = await deliver(OTHER_SLUG, event);
  assert.equal(elsewhere.status, 400, elsewhere.text);
  // Even signed with the other gym's secret, it names no order there.
  const signedThere = fake.event(sale.tracker, 'payment.succeeded', { secret: OTHER_WEBHOOK });
  const ignored = await deliver(OTHER_SLUG, signedThere);
  assert.equal(ignored.status, 200, ignored.text);
  assert.equal(ignored.body.ignored, 'no order here for it');
  assert.equal((await orderOf(sale.orderId)).payment.status, 'pending', 'the first gym’s order is untouched');

  // Delivered right, it is applied.
  assert.equal((await deliver(SLUG, event)).body.applied, true);
});

test('a card is kept from the webhook only when the member agreed to automatic payments', async () => {
  const methods = () => h.inGym(gym, () => h.src('services/safepay').listSavedMethods(member._id));
  const before = (await methods()).length;

  const noConsent = await buy({ saveCard: true });
  fake.pay(noConsent.tracker, { saveCard: { token: 'pm_should_not_keep' } });
  assert.equal((await deliver(SLUG, fake.event(noConsent.tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, true);
  assert.equal((await methods()).length, before);

  const agreed = await buy({ saveCard: true, autoPayConsent: true });
  assert.equal(agreed.saveCard, true);
  fake.pay(agreed.tracker, { saveCard: { token: 'pm_kept_card', last4: '1111', scheme: 2 } });
  assert.equal((await deliver(SLUG, fake.event(agreed.tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, true);
  const saved = await methods();
  assert.equal(saved.length, before + 1);
  const card = saved[saved.length - 1];
  assert.deepEqual([card.brand, card.last4, card.auto_pay], ['Mastercard', '1111', true]);
  assert.match(card.consent_text, /^I allow .+ to charge my saved card Mastercard •••• 1111/);

  // Nothing about the card rides along on the member's own profile.
  const raw = await h.rawDb(gym.database.name).collection('users').findOne({ _id: member._id });
  assert.match(raw.billing.savedMethods[raw.billing.savedMethods.length - 1].token, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(raw), /pm_kept_card/);
});

test('a failed attempt leaves the order payable, with the reason', async () => {
  const sale = await buy();
  const failed = await deliver(SLUG, fake.event(sale.tracker, 'payment.failed', { secret: WEBHOOK, message: 'The card you have used has been flagged as either stolen or lost.' }));
  assert.equal(failed.status, 200, failed.text);
  let order = await orderOf(sale.orderId);
  assert.deepEqual([order.payment.status, order.status], ['pending', 'pending']);
  assert.match(order.payment.lastPaymentError, /flagged/);
  assert.equal(order.payment.safepay.trackers[0].status, 'failed');

  // The member tries another card on the same page, and it goes through.
  fake.pay(sale.tracker);
  assert.equal((await deliver(SLUG, fake.event(sale.tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, true);
  order = await orderOf(sale.orderId);
  assert.equal(order.payment.status, 'paid');
});

test('an event of a kind not known here is confirmed with Safepay before anything is recorded', async () => {
  const sale = await buy();
  const body = JSON.stringify({ token: 'evt_new_kind', version: '2.0.0', type: 'payment.captured.v3', data: { tracker: sale.tracker } });
  const signature = crypto.createHmac('sha512', WEBHOOK).update(body).digest('hex');
  // Safepay says not paid yet: nothing changes.
  assert.equal((await deliver(SLUG, { body, signature })).status, 200);
  assert.equal((await orderOf(sale.orderId)).payment.status, 'pending');
  fake.pay(sale.tracker);
  const res = await deliver(SLUG, { body, signature });
  assert.deepEqual(res.body, { received: true, applied: true });
});

test("Stripe's webhook still gets the raw body and its own signature check, untouched", async () => {
  const stripeGym = await h.createGym('webhook-stripe-gym', { currency: 'GBP', settings: { stripe: { enabled: true, publishableKey: 'pk_test_w', secretKey: 'sk_test_w', webhookSecret: 'whsec_stripe_w' } } });
  const seen = [];
  h.setStripe({
    webhooks: {
      constructEvent: (payload, signature, secret) => {
        seen.push({ raw: Buffer.isBuffer(payload), signature, secret });
        if (signature !== 'good') throw new Error('No signatures found matching the expected signature for payload');
        return JSON.parse(payload.toString());
      }
    }
  });
  try {
    const event = JSON.stringify({ id: 'evt_stripe_1', type: 'customer.created', data: { object: {} } });
    const refused = await api('POST', `/api/gymfolio/payment/webhook/${stripeGym.slug}`, { body: event, slug: null, headers: { 'stripe-signature': 'bad' } });
    assert.equal(refused.status, 400);
    const ok = await api('POST', `/api/gymfolio/payment/webhook/${stripeGym.slug}`, { body: event, slug: null, headers: { 'stripe-signature': 'good' } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body, { received: true });
    assert.ok(seen.every((call) => call.raw && call.secret === 'whsec_stripe_w'));
    // A Safepay delivery to a Stripe-only gym has no secret to be checked with.
    const safepayThere = await deliver(stripeGym.slug, fake.event('track_x', 'payment.succeeded', { secret: 'whatever' }));
    assert.equal(safepayThere.status, 500);
  } finally {
    h.setStripe(null);
  }
});
