// A member's saved cards for automatic payments, over HTTP through index.js
// as it runs (tenant gate and all), against a real MongoDB:
//
//   * GET /api/billing/me/saved-methods lists the member's own cards --
//     brand, last four, expiry, auto-pay, consent -- and never a token;
//   * DELETE /api/billing/me/saved-methods/:id takes the card off the member,
//     so automatic payment stops at once (with the gateway work merged its
//     connector also deletes it from the gateway's wallet); another
//     member's card, or none, is 404;
//   * both need a signed-in member; /api/billing's own (the gym's
//     GymsPilotPro subscription) routes are untouched, and the payment link
//     routes are reached past the tenant gate.
//
// The cards are written straight to the collection, as the gateway's
// webhook leaves them (tokens sealed), so this runs whether or not the user
// schema in this tree declares `billing` yet.

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

const SLUG = 'saved-cards-gym';
const INDEX = path.resolve(__dirname, '..', '..', 'index.js');

let gym;
let User;
let provider;
let secretBox;
let ana;
let ben;
let server;
let base;

const test = h.suite(async () => {
  User = h.src('models/user');
  provider = h.src('services/billing/provider');
  secretBox = h.src('services/secretBox');
  gym = await h.createGym(SLUG, { timezone: 'Asia/Karachi', currency: 'PKR' });
  await h.inGym(gym, async () => {
    ana = await User.create({ firstName: 'Ana', lastName: 'Card', email: 'ana@saved-cards.test', role: 'user' });
    ben = await User.create({ firstName: 'Ben', lastName: 'Card', email: 'ben@saved-cards.test', role: 'user' });
    const card = (id, extra = {}) => ({
      id,
      provider: 'safepay',
      token: secretBox.seal(`pm_secret_${id}`),
      customerToken: `cus_${id}`,
      brand: 'Visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      autoPay: true,
      consentAt: new Date('2026-10-01T10:00:00Z'),
      consentText: 'I allow Iron Gym to charge my saved card Visa •••• 4242 for my membership (5,000 PKR every month) on each due date. I can turn this off anytime in my account.',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      ...extra
    });
    await User.collection.updateOne({ _id: ana._id }, { $set: { billing: { savedMethods: [card('card_a1'), card('card_a2', { brand: 'Mastercard', last4: '5100', autoPay: false })] } } });
    await User.collection.updateOne({ _id: ben._id }, { $set: { billing: { savedMethods: [card('card_b1')] } } });
  });

  provider.setProviderForTests(null);

  // index.js as it runs: its app captured at listen(), .env never read.
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
  if (server) await new Promise((resolve) => server.close(resolve));
});

function bearer(user) {
  return `Bearer ${jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;
}

async function call(method, url, user) {
  const res = await fetch(base + url, { method, headers: { 'x-tenant-slug': SLUG, ...(user ? { Authorization: bearer(user) } : {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

test('a member lists their own saved cards: what may be shown, never a token', async () => {
  const res = await call('GET', '/api/billing/me/saved-methods', ana);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(
    res.body.data.map(({ id, brand, last4, exp_month, exp_year, auto_pay, consent_at }) => ({ id, brand, last4, exp_month, exp_year, auto_pay, consent_at })),
    [
      { id: 'card_a1', brand: 'Visa', last4: '4242', exp_month: 12, exp_year: 2030, auto_pay: true, consent_at: '2026-10-01T10:00:00.000Z' },
      { id: 'card_a2', brand: 'Mastercard', last4: '5100', exp_month: 12, exp_year: 2030, auto_pay: false, consent_at: '2026-10-01T10:00:00.000Z' }
    ]
  );
  assert.equal(res.body.data[0].provider, 'safepay');
  assert.match(res.body.data[0].consent_text, /^I allow Iron Gym to charge my saved card Visa •••• 4242/);
  assert.doesNotMatch(res.text, /pm_secret|enc:v1|cus_card/, 'no token, sealed or open, and no gateway customer');

  const none = await call('GET', '/api/billing/me/saved-methods', await h.inGym(gym, () => User.create({ firstName: 'No', lastName: 'Cards', email: 'no@saved-cards.test' })));
  assert.deepEqual(none.body, { success: true, data: [] });
});

test('removing a card takes it off the member: auto-pay stops at once', async () => {
  const res = await call('DELETE', '/api/billing/me/saved-methods/card_a1', ana);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);

  const left = await call('GET', '/api/billing/me/saved-methods', ana);
  assert.deepEqual(left.body.data.map((m) => m.id), ['card_a2']);

  const raw = await h.inGym(gym, () => User.collection.findOne({ _id: ana._id }));
  assert.deepEqual(raw.billing.savedMethods.map((m) => m.id), ['card_a2'], 'the token reference is gone from the member');
});

test('another member\'s card, or one that does not exist, is not found; signed out is refused', async () => {
  const theirs = await call('DELETE', '/api/billing/me/saved-methods/card_b1', ana);
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.code, 'SAVED_METHOD_NOT_FOUND');
  assert.equal((await call('GET', '/api/billing/me/saved-methods', ben)).body.data.length, 1, "Ben's card is untouched");
  assert.equal((await call('DELETE', '/api/billing/me/saved-methods/nope', ana)).status, 404);
  assert.equal((await call('GET', '/api/billing/me/saved-methods')).status, 401);
  assert.equal((await call('DELETE', '/api/billing/me/saved-methods/card_a2')).status, 401);
});

test('through index.js: the payment link routes are past the tenant gate, and /api/billing keeps its own routes', async () => {
  const bad = await call('GET', '/api/pay/not-a-token');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'LINK_INVALID');
  const badCheckout = await fetch(`${base}/api/pay/not-a-token/checkout`, { method: 'POST', headers: { 'x-tenant-slug': SLUG, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(badCheckout.status, 400);
  // The gym's own GymsPilotPro subscription: still answered by its router (a
  // member is not allowed to see it).
  const subscription = await call('GET', '/api/billing/subscription', ana);
  assert.equal(subscription.status, 403);
});
