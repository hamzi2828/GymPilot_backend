// Safepay's answers, read without a network: amounts in paisa, what each
// tracker state means for an order, the webhook signature, what an event
// says, the saved card a wallet entry describes, and the hosted checkout
// address. Pure functions (services/safepay/shapes.js, api.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const shapes = require('../../src/services/safepay/shapes');
const api = require('../../src/services/safepay/api');

const sign = (secret, data) => crypto.createHmac('sha512', secret).update(data).digest('hex');

test('amounts go to Safepay in paisa (minor units) and come back in rupees', () => {
  assert.equal(shapes.toSafepayAmount(5000, 'PKR'), 500000);
  assert.equal(shapes.toSafepayAmount(1299.99, 'pkr'), 129999);
  assert.equal(shapes.toSafepayAmount(450, 'Rs'), 45000);
  assert.equal(shapes.toSafepayAmount(19.5, 'USD'), 1950);
  assert.equal(shapes.fromSafepayAmount(45000, 'PKR'), 450);
  assert.equal(shapes.fromSafepayAmount(1475, 'PKR'), 14.75);
  assert.equal(shapes.fromSafepayAmount(undefined, 'PKR'), null);
  assert.equal(shapes.fromSafepayAmount('x', 'PKR'), null);
});

test('nothing to pay, or a currency Safepay does not take, is refused before Safepay is asked', () => {
  for (const amount of [0, -5, NaN, undefined, 'abc']) {
    assert.throws(() => shapes.toSafepayAmount(amount, 'PKR'), (error) => error.code === 'NOTHING_TO_PAY' && error.status === 400, String(amount));
  }
  for (const currency of ['JPY', 'INR', '', null]) {
    assert.throws(() => shapes.toSafepayAmount(100, currency), (error) => error.code === 'SAFEPAY_CURRENCY_UNSUPPORTED' && error.status === 409, String(currency));
  }
  assert.deepEqual(shapes.SUPPORTED_CURRENCIES, ['PKR', 'USD', 'GBP', 'EUR', 'CAD', 'AED', 'SAR']);
});

test('tracker states map to paid, failed or pending, and an unknown one is never paid', () => {
  for (const state of ['TRACKER_ENDED', 'tracker_ended', 'TRACKER_PARTIAL_REFUND', 'TRACKER_DISPUTED', 'PAID']) {
    assert.equal(shapes.mapTrackerState(state), 'paid', state);
  }
  for (const state of ['TRACKER_CANCELLED', 'TRACKER_EXPIRED', 'TRACKER_REFUNDED', 'TRACKER_VOIDED', 'TRACKER_REVERSED']) {
    assert.equal(shapes.mapTrackerState(state), 'failed', state);
  }
  for (const state of ['TRACKER_STARTED', 'TRACKER_ENROLLED', 'TRACKER_AUTHORIZED', 'TRACKER_SOMETHING_NEW', '', null, undefined]) {
    assert.equal(shapes.mapTrackerState(state), 'pending', String(state));
  }
});

test('the tracker is found in either shape Safepay answers with, with its money and card', () => {
  const express = { data: { tracker: { token: 'track_1', state: 'TRACKER_ENDED', purchase_totals: { quote_amount: { currency: 'PKR', amount: 600000 } } }, action: { payment_method: { card_type: 'Visa', last_four: '1096', expiration_month: '12', expiration_year: '2028' } } } };
  assert.equal(shapes.trackerOf(express).state, 'TRACKER_ENDED');
  assert.deepEqual(shapes.trackerMoney(express), { amountMinor: 600000, currency: 'PKR', feeMinor: null, netMinor: null });
  assert.deepEqual(shapes.trackerCard(express), { brand: 'Visa', last4: '1096', expMonth: 12, expYear: 2028 });

  const reporter = {
    ok: true,
    data: {
      token: 'track_2',
      state: 'TRACKER_ENDED',
      charge: { amount: { currency: 'PKR', amount: 290000 }, fees: { currency: 'PKR', amount: 9503 }, net: { currency: 'PKR', amount: 280497 } },
      attempts: [{ payment_method: { last_four: '1096', scheme: 'Mastercard', bin: '520000', expiration_month: '02', expiration_year: '2029' } }]
    }
  };
  assert.equal(shapes.trackerOf(reporter).state, 'TRACKER_ENDED');
  assert.deepEqual(shapes.trackerMoney(reporter), { amountMinor: 290000, currency: 'PKR', feeMinor: 9503, netMinor: 280497 });
  assert.deepEqual(shapes.trackerCard(reporter), { brand: 'Mastercard', last4: '1096', expMonth: 2, expYear: 2029 });
});

test('a wallet entry gives the card token and what may be shown, never more', () => {
  const wallet = {
    data: {
      wallet: [
        { token: 'pm_1', is_deleted: false, cybersource: { scheme: 2, bin: '520000', last_four: '1096', expiry_month: '12', expiry_year: '2030' }, created_at: { seconds: 1697697321 } },
        { token: 'pm_gone', is_deleted: true, cybersource: { last_four: '0000' } }
      ],
      count: 2
    }
  };
  const cards = shapes.walletEntries(wallet);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], { token: 'pm_1', brand: 'Mastercard', last4: '1096', expMonth: 12, expYear: 2030, createdAt: new Date(1697697321 * 1000) });
  assert.equal(shapes.brandOf({ bin: '445653' }), 'Visa');
  assert.equal(shapes.brandOf({ scheme: 'PAYPAK' }), 'PayPak');
  assert.equal(shapes.brandOf({}), 'Card');
});

test('a webhook signed over the raw body with the gym’s secret is accepted and parsed', () => {
  const event = { token: 'evt_1', version: '2.0.0', type: 'payment.succeeded', data: { tracker: 'track_1', state: 'TRACKER_ENDED', amount: 45000, currency: 'PKR', fee: 1475, net: 43525, metadata: { order_id: 'PKG261000001' } } };
  const raw = Buffer.from(JSON.stringify(event));
  const parsed = shapes.verifyWebhook(raw, { 'X-SFPY-SIGNATURE': sign('gym-secret', raw) }, 'gym-secret');
  assert.equal(parsed.token, 'evt_1');
  // Header names are case-insensitive; a string body works as well as a Buffer.
  assert.equal(shapes.verifyWebhook(raw.toString(), { 'x-sfpy-signature': sign('gym-secret', raw).toUpperCase() }, 'gym-secret').type, 'payment.succeeded');
});

test("Safepay's own SDK fixture verifies: the signature over the event's data", () => {
  // getsafepay/safepay-node test/fixtures/verify.ts, secret 'foo'.
  const body = {
    data: {
      client_id: 'sec_55ca6960-e2ea-4643-b0cf-7cd65a4d3112',
      created_at: '2021-09-29T12:00:40Z',
      endpoint: 'http://127.0.0.1:9000',
      notification: {
        amount: '150',
        currency: 'PKR',
        fee: '4.92',
        intent: 'PAYFAST',
        metadata: { order_id: 'XG102312', source: 'shopify' },
        net: '145.08',
        state: 'PAID',
        tracker: 'tracker_c5a5apsbcv41om3fg0u0',
        user: 'johndoe@gmail.com'
      },
      token: 'C5A5APSBCV41R2QF2MHG',
      type: 'payment:created',
      updated_at: '2021-09-29T12:00:40Z'
    }
  };
  const signature = 'ba4c442df5067b679f55919ebc282cb113e376d5a5e5d9c6655647d734823da75a4371759f921bce40963cb90505ed1f8c0405cb78257fd605d259d452a1a7c7';
  const event = shapes.verifyWebhook(JSON.stringify(body), { 'x-sfpy-signature': signature }, 'foo');
  // The old shape is read, but its money is not trusted: it is confirmed with Safepay.
  const info = shapes.readEvent(event);
  assert.equal(info.tracker, 'tracker_c5a5apsbcv41om3fg0u0');
  assert.equal(info.outcome, 'other');
  assert.equal(info.amountMinor, null);
  assert.equal(info.legacy, true);
});

test('a wrong secret, a changed body, no signature, no secret or a body that is not JSON is refused', () => {
  const raw = Buffer.from(JSON.stringify({ type: 'payment.succeeded', data: { tracker: 'track_1', amount: 100 } }));
  const good = sign('gym-secret', raw);
  const refused = (fn, code) => assert.throws(fn, (error) => error.name === 'SafepayError' && error.code === code);

  refused(() => shapes.verifyWebhook(raw, { 'x-sfpy-signature': sign('another-gym', raw) }, 'gym-secret'), 'SAFEPAY_SIGNATURE_INVALID');
  const tampered = Buffer.from(raw.toString().replace('"amount":100', '"amount":1'));
  refused(() => shapes.verifyWebhook(tampered, { 'x-sfpy-signature': good }, 'gym-secret'), 'SAFEPAY_SIGNATURE_INVALID');
  refused(() => shapes.verifyWebhook(raw, {}, 'gym-secret'), 'SAFEPAY_SIGNATURE_INVALID');
  refused(() => shapes.verifyWebhook(raw, { 'x-sfpy-signature': 'abc' }, 'gym-secret'), 'SAFEPAY_SIGNATURE_INVALID');
  refused(() => shapes.verifyWebhook(raw, { 'x-sfpy-signature': good }, ''), 'SAFEPAY_WEBHOOK_NOT_CONFIGURED');
  refused(() => shapes.verifyWebhook('not json', { 'x-sfpy-signature': sign('gym-secret', 'not json') }, 'gym-secret'), 'SAFEPAY_PAYLOAD_INVALID');
});

test('what an event says: paid, failed, refunded, or something to confirm with Safepay', () => {
  const paid = shapes.readEvent({ token: 'evt_1', type: 'payment.succeeded', data: { tracker: 'track_1', state: 'TRACKER_ENDED', amount: 45000, currency: 'pkr', fee: 1475, net: 43525, metadata: { order_id: 'PKG1' } } });
  assert.deepEqual(
    { id: paid.id, tracker: paid.tracker, outcome: paid.outcome, amountMinor: paid.amountMinor, currency: paid.currency, feeMinor: paid.feeMinor, netMinor: paid.netMinor, orderRef: paid.orderRef },
    { id: 'evt_1', tracker: 'track_1', outcome: 'paid', amountMinor: 45000, currency: 'PKR', feeMinor: 1475, netMinor: 43525, orderRef: 'PKG1' }
  );
  assert.equal(shapes.readEvent({ type: 'payment.failed', data: { tracker: 't', state: 'TRACKER_ENROLLED', message: 'Card flagged' } }).outcome, 'failed');
  assert.equal(shapes.readEvent({ type: 'payment.failed', data: { tracker: 't', message: 'Card flagged' } }).message, 'Card flagged');
  for (const type of ['payment.refunded', 'void.succeeded', 'authorization.reversed']) {
    assert.equal(shapes.readEvent({ type, data: { tracker: 't' } }).outcome, 'refunded', type);
  }
  // A "success" whose state is not paid, and kinds not known here, are confirmed with Safepay.
  assert.equal(shapes.readEvent({ type: 'payment.succeeded', data: { tracker: 't', state: 'TRACKER_AUTHORIZED' } }).outcome, 'other');
  assert.equal(shapes.readEvent({ type: 'authorization.succeeded', data: { tracker: 't' } }).outcome, 'other');
  assert.equal(shapes.readEvent({ type: 'payment.succeeded', data: {} }).tracker, null);
});

test('the hosted checkout address carries the session, the return addresses and, when saving, the customer', () => {
  const config = { environment: 'sandbox' };
  const plain = new URL(api.checkoutUrl(config, { tracker: 'track_1', tbt: 'tbt==', redirectUrl: 'https://gym.test/checkout/success?provider=safepay&order=abc', cancelUrl: 'https://gym.test/checkout/cancel?order=abc', orderRef: 'PKG1' }));
  assert.equal(plain.origin + plain.pathname, 'https://sandbox.api.getsafepay.com/embedded/');
  assert.equal(plain.searchParams.get('environment'), 'sandbox');
  assert.equal(plain.searchParams.get('tracker'), 'track_1');
  assert.equal(plain.searchParams.get('tbt'), 'tbt==');
  assert.equal(plain.searchParams.get('source'), 'hosted');
  assert.equal(plain.searchParams.get('redirect_url'), 'https://gym.test/checkout/success?provider=safepay&order=abc');
  assert.equal(plain.searchParams.get('cancel_url'), 'https://gym.test/checkout/cancel?order=abc');
  assert.equal(plain.searchParams.get('user_id'), null);
  assert.equal(plain.searchParams.get('is_implicit'), null);

  const saving = new URL(api.checkoutUrl({ environment: 'production' }, { tracker: 't', tbt: 'x', redirectUrl: 'https://a.test', cancelUrl: 'https://a.test', customer: 'cus_1', saveCard: true }));
  assert.equal(saving.origin, 'https://getsafepay.com');
  assert.equal(saving.searchParams.get('environment'), 'production');
  assert.equal(saving.searchParams.get('user_id'), 'cus_1');
  assert.equal(saving.searchParams.get('is_implicit'), 'true');
});

test("Safepay's hosts per environment; a stand-in only outside production", () => {
  assert.deepEqual(api.hostsFor('sandbox', {}), { api: 'https://sandbox.api.getsafepay.com', checkout: 'https://sandbox.api.getsafepay.com' });
  assert.deepEqual(api.hostsFor('production', {}), { api: 'https://api.getsafepay.com', checkout: 'https://getsafepay.com' });
  assert.deepEqual(api.hostsFor('anything', {}), api.hostsFor('sandbox', {}));
  const local = { SAFEPAY_API_BASE_URL: 'http://127.0.0.1:5555/', NODE_ENV: 'test' };
  assert.deepEqual(api.hostsFor('production', local), { api: 'http://127.0.0.1:5555', checkout: 'http://127.0.0.1:5555' });
  // In production the keys only ever go to Safepay.
  assert.deepEqual(api.hostsFor('production', { ...local, NODE_ENV: 'production' }), { api: 'https://api.getsafepay.com', checkout: 'https://getsafepay.com' });
});
