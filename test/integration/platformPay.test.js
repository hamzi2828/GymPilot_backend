// How gyms pay GymsPilotPro, end to end over HTTP through index.js as it
// runs (body parsing, the tenant gate, the routes), against a real MongoDB
// and a stand-in Safepay on a local port. The super admin chooses the way
// (bank transfer + receipt, Safepay, Stripe, none) and fills in its keys and
// bank accounts; the secrets are masked and sealed; choosing never switches
// Stripe off.

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');
const { createFakeSafepay } = require('./helpers/fakeSafepay');

const INDEX = path.resolve(__dirname, '..', '..', 'index.js');
const SECRET = 'sec_platform_secret_4321';
const PUBLIC = 'pub_platform_key';
const WEBHOOK = 'whsec_platform_shared_8765';

// The smallest real PNG (1x1), and a "PNG" that is not one.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const NOT_PNG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let fake;
let server;
let base;
let superAdmin;
let PlatformSettings;
let PlatformAuditLog;
let Gym;
let User;
let plan;
let gym;        // billed by hand, on a plan, PKR
let stripeGym;  // billed by Stripe already
let admin;
let stripeAdmin;
const stored = []; // local files the tests upload, removed at the end

const test = h.suite(async () => {
  fake = await createFakeSafepay({ secretKey: SECRET, publicKey: PUBLIC }).start();
  process.env.SAFEPAY_API_BASE_URL = fake.base;
  PlatformSettings = h.src('platform/models/platformSettingsModel');
  PlatformAuditLog = h.src('platform/models/platformAuditLogModel');
  const SuperAdmin = h.src('platform/models/superAdminModel');
  superAdmin = (await SuperAdmin.create({ name: 'Owner', email: 'owner@gymspilotpro.test', password: 'x'.repeat(60) })).toObject();
  Gym = h.src('platform/models/gymModel');
  User = h.src('models/user');
  const PlatformPlan = h.src('platform/models/platformPlanModel');
  plan = (await PlatformPlan.create({ slug: 'growth', name: 'Growth', price: { monthly: 8000, yearly: 80000, currency: 'PKR' }, trialDays: 14 })).toObject();
  gym = await h.createGym('pay-gym', { currency: 'PKR' });
  stripeGym = await h.createGym('card-gym', { currency: 'PKR' });
  const due = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 5));
  await Gym.updateOne(
    { _id: gym._id },
    { $set: { plan: plan._id, owner: { firstName: 'Ayesha', lastName: 'Khan', email: 'ayesha@pay-gym.test' }, subscription: { status: 'active', billingCycle: 'monthly', amount: 8000, planAmount: 8000, currency: 'PKR', currentPeriodEnd: due, startedAt: new Date() } } }
  );
  await Gym.updateOne(
    { _id: stripeGym._id },
    { $set: { plan: plan._id, owner: { firstName: 'Bilal', email: 'bilal@card-gym.test' }, subscription: { status: 'active', billingCycle: 'monthly', amount: 8000, planAmount: 8000, currency: 'PKR', currentPeriodEnd: due, stripeCustomerId: 'cus_card', stripeSubscriptionId: 'sub_card' } } }
  );
  admin = await h.inGym(gym, async () => (await User.create({ firstName: 'Ayesha', lastName: 'Khan', email: 'ayesha@pay-gym.test', emailVerified: true, role: 'admin' })).toObject());
  stripeAdmin = await h.inGym(stripeGym, async () => (await User.create({ firstName: 'Bilal', lastName: 'Ahmed', email: 'bilal@card-gym.test', emailVerified: true, role: 'admin' })).toObject());

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
  const { localUploadPath } = require('../../src/helper/upload');
  for (const url of stored) {
    const file = localUploadPath(url);
    if (file) await fs.promises.unlink(file).catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake) await fake.stop();
});

function platformToken() {
  return h.src('platform/middleware/platformAuth').signPlatformToken(superAdmin);
}

async function send(method, url, { body, token, headers = {}, form } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: form || (body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
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

/** The super admin's own calls. */
const panel = (method, url, options = {}) => send(method, `/api/platform${url}`, { token: platformToken(), ...options });

function gymToken(user, forGym) {
  return jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(forGym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

/** A gym admin's own calls, from the gym's site. */
const billing = (method, url, { user = admin, forGym = gym, ...options } = {}) =>
  send(method, `/api/billing${url}`, { token: gymToken(user, forGym), headers: { 'x-tenant-slug': forGym.slug }, ...options });

function fileForm(field, buffer, name, type) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), name);
  return form;
}

const rawSettings = () => h.rawDb(h.PLATFORM_DB).collection('platform_settings').findOne({ singleton: 'platform' });

test('a platform that never chose reads as none, with the Safepay webhook address and the default reminders', async () => {
  const res = await panel('GET', '/settings');
  assert.equal(res.status, 200, res.text);
  const data = res.body.data;
  assert.deepEqual(data.onlinePayments, { provider: 'none', providerChosen: false });
  assert.equal(data.safepay.webhook_url, `${base}/api/platform/safepay/webhook`);
  assert.equal(data.safepay.enabled, false);
  assert.equal(data.safepay.environment, 'sandbox');
  assert.equal(data.safepay.secretKeySet, false);
  assert.deepEqual(data.bankAccounts, []);
  assert.deepEqual(data.billingReminders, { daysBefore: [3], onDueDay: true, lastDayAfterDue: 3 });
  // No SMTP_* here: the reminders card says email is off.
  assert.equal(data.platform_email_configured, false);
  // The Stripe block and its webhook address are as they were.
  assert.equal(data.stripe.enabled, false);
  assert.equal(data.webhookUrl, `${base}/api/platform/stripe/webhook`);

  const gateways = await panel('GET', '/settings/payment-gateways');
  assert.equal(gateways.status, 200, gateways.text);
  assert.equal(gateways.body.selected, 'none');
  assert.deepEqual(gateways.body.data.map((g) => g.id), ['stripe', 'safepay', 'generic']);
  for (const row of gateways.body.data) {
    for (const key of ['id', 'label', 'description', 'configured', 'selected', 'config_fields']) assert.ok(key in row, `${row.id}.${key}`);
    assert.equal(row.selected, false);
    assert.equal(row.configured, false);
    // The gateways' own switches are set by choosing, never shown.
    assert.ok(!row.config_fields.some((f) => f.name === 'enabled'), `${row.id} shows no enabled switch`);
    for (const field of row.config_fields) assert.ok(['text', 'secret', 'select', 'boolean'].includes(field.type));
  }
  const safepay = gateways.body.data.find((g) => g.id === 'safepay');
  assert.deepEqual(safepay.config_fields.map((f) => [f.name, f.type]), [['environment', 'select'], ['publicKey', 'text'], ['secretKey', 'secret'], ['webhookSecret', 'secret']]);
  assert.deepEqual(safepay.config_fields[0].options.map((o) => o.value), ['sandbox', 'production']);
  assert.equal(safepay.webhook_url, `${base}/api/platform/safepay/webhook`);
  assert.deepEqual(gateways.body.data.find((g) => g.id === 'generic').config_fields, []);
});

test('only a super admin reaches the payment settings', async () => {
  assert.equal((await send('GET', '/api/platform/settings')).status, 401);
  assert.equal((await send('GET', '/api/platform/settings/payment-gateways')).status, 401);
  assert.equal((await send('POST', '/api/platform/settings/bank-accounts', { body: { bankName: 'X' } })).status, 401);
  // A gym's own session does not verify here.
  const gymToken = jwt.sign({ id: 'x', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  assert.equal((await send('GET', '/api/platform/settings', { token: gymToken })).status, 401);
});

test("choosing Safepay needs its keys; they are masked on the way out, kept when sent back masked, and sealed at rest", async () => {
  const refused = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'safepay' } } });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.body.code, 'SECRET_REQUIRED');
  assert.equal(refused.body.field, 'safepay.publicKey');
  assert.equal((await PlatformSettings.getSettings()).onlinePayments.provider, undefined, 'nothing was saved');

  const half = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'safepay' }, safepay: { publicKey: PUBLIC, secretKey: SECRET } } });
  assert.equal(half.status, 400);
  assert.equal(half.body.field, 'safepay.webhookSecret');

  const ok = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'safepay' }, safepay: { environment: 'sandbox', publicKey: PUBLIC, secretKey: SECRET, webhookSecret: WEBHOOK } } });
  assert.equal(ok.status, 200, ok.text);
  const data = ok.body.data;
  assert.deepEqual(data.onlinePayments, { provider: 'safepay', providerChosen: true });
  assert.equal(data.safepay.enabled, true);
  assert.equal(data.safepay.secretKey, '••••••••4321');
  assert.equal(data.safepay.webhookSecret, '••••••••8765');
  assert.equal(data.safepay.secretKeySet, true);
  assert.equal(data.safepay.webhookSecretSet, true);
  assert.equal(data.safepay.publicKey, PUBLIC);
  assert.doesNotMatch(ok.text, new RegExp(`${SECRET}|${WEBHOOK}`));

  // The page sends the masked values back on every save: the keys stay.
  const again = await panel('PUT', '/settings', { body: { onlinePayments: data.onlinePayments, safepay: { ...data.safepay, environment: 'production' } } });
  assert.equal(again.status, 200, again.text);
  const settings = await PlatformSettings.getSettings();
  assert.equal(settings.safepay.secretKey, SECRET);
  assert.equal(settings.safepay.webhookSecret, WEBHOOK);
  assert.equal(settings.safepay.environment, 'production');
  const row = await rawSettings();
  assert.match(row.safepay.secretKey, /^enc:v1:/);
  assert.match(row.safepay.webhookSecret, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(row.safepay), new RegExp(SECRET));

  // An edited mask is not saved as dots.
  const edited = await panel('PUT', '/settings', { body: { safepay: { secretKey: '••••••••4321x', environment: 'sandbox' } } });
  assert.equal(edited.status, 200);
  assert.match(edited.body.warnings[0], /secret key was not changed/);
  assert.equal((await PlatformSettings.getSettings()).safepay.secretKey, SECRET);

  const bad = await panel('PUT', '/settings', { body: { safepay: { environment: 'live' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /sandbox or production/);
  const unknown = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'paypal' } } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.message, /none, stripe, safepay, generic/);

  const gateways = await panel('GET', '/settings/payment-gateways');
  assert.equal(gateways.body.selected, 'safepay');
  const row2 = gateways.body.data.find((g) => g.id === 'safepay');
  assert.deepEqual([row2.selected, row2.configured], [true, true]);

  const logged = await PlatformAuditLog.find({ action: 'platform_payments_updated' }).lean();
  assert.ok(logged.length >= 2);
  assert.equal(logged[logged.length - 1].actorEmail, superAdmin.email);
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(SECRET));
});

test('choosing a way switches it on, and choosing another never switches Stripe off', async () => {
  const stripe = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'stripe' } } });
  assert.equal(stripe.status, 200, stripe.text);
  assert.deepEqual([stripe.body.data.onlinePayments.provider, stripe.body.data.stripe.enabled, stripe.body.data.safepay.enabled], ['stripe', true, false]);

  const generic = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'generic' } } });
  assert.deepEqual([generic.body.data.onlinePayments.provider, generic.body.data.stripe.enabled, generic.body.data.safepay.enabled], ['generic', true, false]);
  const none = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'none' } } });
  assert.deepEqual([none.body.data.onlinePayments.provider, none.body.data.stripe.enabled], ['none', true]);
  // The Safepay keys are still there for when it is chosen again.
  assert.equal(none.body.data.safepay.secretKeySet, true);

  const back = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'safepay' } } });
  assert.deepEqual([back.body.data.onlinePayments.provider, back.body.data.safepay.enabled, back.body.data.stripe.enabled], ['safepay', true, true]);
  await panel('PUT', '/settings', { body: { stripe: { enabled: false } } });
});

test('the reminders to gym owners are read strictly and stored as days, largest first', async () => {
  const ok = await panel('PUT', '/settings', { body: { billingReminders: { daysBefore: [3, 7, 3, 0], onDueDay: false, lastDayAfterDue: 5 } } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body.data.billingReminders, { daysBefore: [7, 3, 0], onDueDay: false, lastDayAfterDue: 5 });
  const partial = await panel('PUT', '/settings', { body: { billingReminders: { lastDayAfterDue: 0 } } });
  assert.deepEqual(partial.body.data.billingReminders, { daysBefore: [7, 3, 0], onDueDay: false, lastDayAfterDue: 0 });
  for (const [billingReminders, field] of [
    [{ daysBefore: [31] }, /daysBefore/],
    [{ daysBefore: [-1] }, /daysBefore/],
    [{ daysBefore: [2.5] }, /daysBefore/],
    [{ daysBefore: 3 }, /list of days/],
    [{ lastDayAfterDue: 'soon' }, /lastDayAfterDue/],
    [{ lastDayAfterDue: 40 }, /lastDayAfterDue/]
  ]) {
    const res = await panel('PUT', '/settings', { body: { billingReminders } });
    assert.equal(res.status, 400, JSON.stringify(billingReminders));
    assert.match(res.body.message, field);
  }
  await panel('PUT', '/settings', { body: { billingReminders: { daysBefore: [3], onDueDay: true, lastDayAfterDue: 3 } } });
});

test('"Test connection" checks Safepay keys against Safepay, typed or saved, and says what is missing elsewhere', async () => {
  const saved = await panel('POST', '/settings/safepay/test', { body: {} });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.success, true);
  assert.match(saved.body.message, /Connected to Safepay \(test\)/);
  assert.ok(fake.callsTo('POST', '/client/passport/v1/token').length >= 1);

  const wrong = await panel('POST', '/settings/safepay/test', { body: { safepay: { secretKey: 'sec_wrong', publicKey: PUBLIC } } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.success, false);
  assert.match(wrong.body.message, /refused the keys/);
  // A masked value is the saved one, not the dots.
  const masked = await panel('POST', '/settings/safepay/test', { body: { secretKey: '••••••••4321' } });
  assert.equal(masked.status, 200, masked.text);

  const generic = await panel('POST', '/settings/generic/test', { body: {} });
  assert.equal(generic.status, 400);
  assert.match(generic.body.message, /Add a bank account/);
  assert.equal((await panel('POST', '/settings/paypal/test', { body: {} })).status, 404);
  // Stripe keeps its own test, also reached by the generic address.
  const stripe = await panel('POST', '/settings/stripe/test', { body: {} });
  assert.equal(stripe.status, 409);
  assert.match(stripe.body.message, /no Stripe keys/);
});

test("GymsPilotPro's bank accounts: added, edited, given a QR code, and removed", async () => {
  const missing = await panel('POST', '/settings/bank-accounts', { body: { bankName: 'Meezan Bank' } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /account title/);
  const noNumber = await panel('POST', '/settings/bank-accounts', { body: { bankName: 'Meezan Bank', accountTitle: 'GymsPilotPro' } });
  assert.match(noNumber.body.message, /account number or the IBAN/);
  const badIban = await panel('POST', '/settings/bank-accounts', { body: { bankName: 'Meezan Bank', accountTitle: 'GymsPilotPro', iban: 'not an iban' } });
  assert.match(badIban.body.message, /IBAN/);

  const added = await panel('POST', '/settings/bank-accounts', { body: { bankName: 'Meezan Bank', accountTitle: 'GymsPilotPro', accountNumber: '0101-0123456', iban: 'pk36 mezn 0001 0101 2345 6702' } });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.body.success, true);
  const [account] = added.body.data.bankAccounts;
  assert.deepEqual(added.body.data.bankAccount, account, 'the new one, on its own');
  assert.deepEqual({ ...account, id: undefined }, { id: undefined, bankName: 'Meezan Bank', accountTitle: 'GymsPilotPro', accountNumber: '0101-0123456', iban: 'PK36MEZN0001010123456702', qrCodeUrl: '', active: true });
  const second = await panel('POST', '/settings/bank-accounts', { body: { bankName: 'HBL', accountTitle: 'GymsPilotPro', accountNumber: '1234', active: false } });
  assert.equal(second.body.data.bankAccounts.length, 2);
  const hbl = second.body.data.bankAccounts[1];

  // Bank transfer is ready once one account is active.
  let gateways = await panel('GET', '/settings/payment-gateways');
  assert.equal(gateways.body.data.find((g) => g.id === 'generic').configured, true);
  const test1 = await panel('POST', '/settings/generic/test', { body: {} });
  assert.equal(test1.status, 200);
  assert.match(test1.body.message, /1 bank account is ready/);

  const edited = await panel('PUT', `/settings/bank-accounts/${account.id}`, { body: { accountTitle: 'GymsPilotPro (Pvt) Ltd' } });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.body.data.bankAccounts[0].accountTitle, 'GymsPilotPro (Pvt) Ltd');
  assert.equal(edited.body.data.bankAccounts[0].iban, 'PK36MEZN0001010123456702', 'the rest is kept');
  assert.equal((await panel('PUT', `/settings/bank-accounts/${account.id}`, { body: { bankName: '' } })).status, 400);
  assert.equal((await panel('PUT', '/settings/bank-accounts/64b000000000000000000000', { body: { bankName: 'X' } })).status, 404);

  // The QR code: an image that really is one.
  const notImage = await panel('POST', `/settings/bank-accounts/${account.id}/qr`, { form: fileForm('qrCode', Buffer.from('%PDF-1.4'), 'qr.pdf', 'application/pdf') });
  assert.equal(notImage.status, 400, notImage.text);
  const fakePng = await panel('POST', `/settings/bank-accounts/${account.id}/qr`, { form: fileForm('qrCode', NOT_PNG, 'qr.png', 'image/png') });
  assert.equal(fakePng.status, 400, fakePng.text);
  assert.equal(fakePng.body.code, 'FILE_NOT_ALLOWED');
  const none = await panel('POST', `/settings/bank-accounts/${account.id}/qr`, { form: new FormData() });
  assert.equal(none.status, 400);

  const uploaded = await panel('POST', `/settings/bank-accounts/${account.id}/qr`, { form: fileForm('qrCode', PNG, 'meezan qr.png', 'image/png') });
  assert.equal(uploaded.status, 200, uploaded.text);
  const qr = uploaded.body.data.bankAccounts[0].qrCodeUrl;
  stored.push(qr);
  assert.match(qr, /^\/uploads\/[^/]+\.png$/, 'kept at the top of the uploads folder, never in a gym folder');
  const served = await fetch(base + qr);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  // A new image replaces the old one, which is removed.
  const replaced = await panel('POST', `/settings/bank-accounts/${account.id}/qr`, { form: fileForm('qrCode', PNG, 'new.png', 'image/png') });
  const qr2 = replaced.body.data.bankAccounts[0].qrCodeUrl;
  stored.push(qr2);
  assert.notEqual(qr2, qr);
  assert.equal((await fetch(base + qr)).status, 404);

  const cleared = await panel('DELETE', `/settings/bank-accounts/${account.id}/qr`);
  assert.equal(cleared.body.data.bankAccounts[0].qrCodeUrl, '');
  assert.equal((await fetch(base + qr2)).status, 404);

  const removed = await panel('DELETE', `/settings/bank-accounts/${hbl.id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data.bankAccounts.map((a) => a.bankName), ['Meezan Bank']);
  assert.equal((await panel('DELETE', `/settings/bank-accounts/${hbl.id}`)).status, 404);
  // The settings answer carries the list too.
  assert.equal((await panel('GET', '/settings')).body.data.bankAccounts.length, 1);
  assert.ok(await PlatformAuditLog.exists({ action: 'platform_bank_account_added' }));
  assert.ok(await PlatformAuditLog.exists({ action: 'platform_bank_account_qr' }));
});

test("a card checkout from a gym's Billing tab follows the way chosen; a gym Stripe already bills keeps its card buttons", async () => {
  const keys = await panel('PUT', '/settings', { body: { stripe: { secretKey: 'sk_test_platform_gate', webhookSecret: 'whsec_platform_gate', enabled: true } } });
  assert.equal(keys.status, 200, keys.text);
  assert.equal(keys.body.data.onlinePayments.provider, 'safepay', 'still the way chosen');

  // Safepay is the way: no new card subscriptions...
  const hand = await billing('GET', '/subscription?usage=0');
  assert.equal(hand.status, 200, hand.text);
  assert.equal(hand.body.data.stripeConfigured, false);
  const checkout = await billing('POST', '/checkout', { body: {} });
  assert.equal(checkout.status, 409, checkout.text);
  assert.equal(checkout.body.code, 'PLATFORM_STRIPE_NOT_CONFIGURED');
  assert.match(checkout.body.message, /another way now.*System → Payments/);
  // ...but the gym Stripe already bills is still served by card.
  const card = await billing('GET', '/subscription?usage=0', { user: stripeAdmin, forGym: stripeGym });
  assert.equal(card.status, 200, card.text);
  assert.equal(card.body.data.stripeConfigured, true);
  assert.equal(card.body.data.hasStripeSubscription, true);

  // Stripe chosen: card subscriptions are offered again.
  await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'stripe' } } });
  assert.equal((await billing('GET', '/subscription?usage=0')).body.data.stripeConfigured, true);
  // Back to Safepay for the tests that follow; Stripe stays on for the gym it bills.
  const back = await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'safepay' } } });
  assert.equal(back.body.data.stripe.enabled, true);
  assert.equal((await billing('GET', '/subscription?usage=0', { user: stripeAdmin, forGym: stripeGym })).body.data.stripeConfigured, true);
});

/* ------------------------- paying through Safepay ------------------------- */

const gymNow = (forGym = gym) => Gym.findById(forGym._id).lean();

// What Safepay's servers send: no website, no tenant header, the signed bytes.
function deliver({ body, signature }) {
  return send('POST', '/api/platform/safepay/webhook', { body, headers: { 'X-SFPY-SIGNATURE': signature } });
}

async function payNow(body = {}, options = {}) {
  const res = await billing('POST', '/pay', { body, ...options });
  assert.equal(res.status, 200, res.text);
  const url = new URL(res.body.data.url);
  return { url, tracker: url.searchParams.get('tracker') };
}

test("Pay now opens Safepay's page with GymsPilotPro's keys, returning to the gym's own site", async () => {
  const before = await gymNow();
  const { url, tracker } = await payNow();
  assert.equal(url.origin, fake.base, 'the stand-in Safepay');
  assert.equal(url.pathname, '/embedded/');
  assert.equal(url.searchParams.get('redirect_url'), 'http://pay-gym.test/admin/settings?tab=billing&paid=1');
  assert.equal(url.searchParams.get('cancel_url'), 'http://pay-gym.test/admin/settings?tab=billing');
  assert.equal(url.searchParams.get('environment'), 'sandbox');
  // The platform's keys (the gym has none), the gym's agreed amount in paisa.
  const created = fake.callsTo('POST', '/order/payments/v3/').filter((c) => c.path === '/order/payments/v3/').pop();
  assert.equal(created.headers['x-sfpy-merchant-secret'], SECRET);
  assert.equal(created.body.merchant_api_key, PUBLIC);
  assert.deepEqual([created.body.amount, created.body.currency], [800000, 'PKR']);
  assert.equal(fake.tracker(tracker).amount, 800000);

  const PlatformSafepayCheckout = h.src('platform/models/platformSafepayCheckoutModel');
  const row = await PlatformSafepayCheckout.findOne({ tracker }).lean();
  assert.deepEqual([row.gymSlug, row.amount, row.currency, row.status, row.billingCycle, row.change], ['pay-gym', 8000, 'PKR', 'pending', 'monthly', null]);
  assert.equal(row.openedBy.email, admin.email);
  // Opening the page changes nothing yet.
  assert.deepEqual((await gymNow()).subscription.currentPeriodEnd, before.subscription.currentPeriodEnd);
});

test("Safepay's signed webhook records the payment and extends the subscription once, however often it comes", async () => {
  const before = await gymNow();
  await Gym.updateOne({ _id: gym._id }, { $set: { 'subscription.status': 'past_due', 'subscription.pastDueSince': new Date() } });
  const { tracker } = await payNow();
  fake.pay(tracker);
  const event = fake.event(tracker, 'payment.succeeded', { secret: WEBHOOK });

  // Signed with anything but the platform's secret: refused, nothing changes.
  const forged = await deliver({ body: event.body, signature: fake.event(tracker, 'payment.succeeded', { secret: 'whsec_a_gyms_own' }).signature });
  assert.equal(forged.status, 400, forged.text);
  assert.equal(forged.body.received, false);
  assert.equal((await deliver({ body: event.body, signature: '' })).status, 400);
  assert.equal((await gymNow()).subscription.status, 'past_due');

  const first = await deliver(event);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body, { received: true, applied: true, duplicate: false });
  const { addCycle } = h.src('platform/services/manualPayments');
  const expected = addCycle(before.subscription.currentPeriodEnd, 'monthly');
  const after = await gymNow();
  assert.deepEqual(after.subscription.currentPeriodEnd, expected);
  assert.equal(after.subscription.status, 'active');
  assert.equal(after.subscription.pastDueSince, null);

  const again = await deliver(event);
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.body, { received: true, applied: false, duplicate: true });
  // Safepay sends one event per attempt; another for the same payment changes nothing either.
  assert.equal((await deliver(fake.event(tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, false);
  assert.deepEqual((await gymNow()).subscription.currentPeriodEnd, expected);

  const PlatformPayment = h.src('platform/models/platformPaymentModel');
  const payments = await PlatformPayment.find({ gymId: gym._id, method: 'safepay' }).lean();
  assert.equal(payments.length, 1);
  assert.deepEqual([payments[0].amount, payments[0].currency, payments[0].reference, payments[0].statusBefore, payments[0].recordedBy.email], [8000, 'PKR', tracker, 'past_due', 'safepay']);
  assert.ok(await PlatformAuditLog.exists({ action: 'platform_safepay_event', gymSlug: 'pay-gym' }));

  // The super admin's payment history lists it, and the "Record payment"
  // form still offers only what is typed in by hand.
  const history = await panel('GET', `/gyms/${gym._id}/payments`);
  assert.equal(history.status, 200, history.text);
  assert.equal(history.body.data[0].methodLabel, 'Safepay');
  assert.deepEqual(history.body.next.methods.map((m) => m.value), ['bank_transfer', 'jazzcash', 'easypaisa', 'cash', 'other']);
});

test('a failed attempt, a short payment and an event for no GymsPilotPro payment change nothing', async () => {
  const before = await gymNow();
  const PlatformSafepayCheckout = h.src('platform/models/platformSafepayCheckoutModel');

  const failed = await payNow();
  const declined = await deliver(fake.event(failed.tracker, 'payment.failed', { secret: WEBHOOK, message: 'Card declined' }));
  assert.equal(declined.status, 200, declined.text);
  assert.equal((await PlatformSafepayCheckout.findOne({ tracker: failed.tracker }).lean()).status, 'failed');

  const short = await payNow();
  fake.pay(short.tracker);
  const less = await deliver(fake.event(short.tracker, 'payment.succeeded', { secret: WEBHOOK, amount: 100 }));
  assert.equal(less.status, 200, less.text);
  assert.equal(less.body.applied, false);
  assert.match((await PlatformSafepayCheckout.findOne({ tracker: short.tracker }).lean()).error, /Not recorded/);

  const stranger = await deliver(fake.event('track_not_ours', 'payment.succeeded', { secret: WEBHOOK }));
  assert.equal(stranger.status, 200, stranger.text);
  assert.equal(stranger.body.ignored, 'no GymsPilotPro payment for it');
  assert.deepEqual((await gymNow()).subscription.currentPeriodEnd, before.subscription.currentPeriodEnd);
});

test('an event of a kind not known here is checked with Safepay, with the platform keys, and recorded as Safepay says', async () => {
  const before = await gymNow();
  const { tracker } = await payNow();
  fake.pay(tracker);
  const asked = fake.callsTo('GET', `/reporter/api/v1/payments/${tracker}`).length;
  const res = await deliver(fake.event(tracker, 'tracker.updated', { secret: WEBHOOK }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.applied, true);
  const call = fake.callsTo('GET', `/reporter/api/v1/payments/${tracker}`)[asked];
  assert.equal(call.headers['x-sfpy-merchant-secret'], SECRET);
  const { addCycle } = h.src('platform/services/manualPayments');
  assert.deepEqual((await gymNow()).subscription.currentPeriodEnd, addCycle(before.subscription.currentPeriodEnd, 'monthly'));
});

test('paying yearly, or for another plan, is priced on the server and moves the subscription to it once paid', async () => {
  const PlatformPlan = h.src('platform/models/platformPlanModel');
  await PlatformPlan.create({ slug: 'pro', name: 'Pro', price: { monthly: 12000, yearly: 120000, currency: 'PKR' } });
  const before = await gymNow();
  const { addCycle } = h.src('platform/services/manualPayments');

  const yearly = await payNow({ billingCycle: 'yearly' });
  assert.equal(fake.tracker(yearly.tracker).amount, 8000000, 'the plan list price for a year');
  fake.pay(yearly.tracker);
  assert.equal((await deliver(fake.event(yearly.tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, true);
  let after = await gymNow();
  assert.deepEqual([after.subscription.billingCycle, after.subscription.amount], ['yearly', 80000]);
  assert.deepEqual(after.subscription.currentPeriodEnd, addCycle(before.subscription.currentPeriodEnd, 'yearly'));

  const pro = await payNow({ planSlug: 'pro', billingCycle: 'monthly' });
  assert.equal(fake.tracker(pro.tracker).amount, 1200000);
  fake.pay(pro.tracker);
  assert.equal((await deliver(fake.event(pro.tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, true);
  after = await gymNow();
  const proPlan = await PlatformPlan.findOne({ slug: 'pro' }).lean();
  assert.equal(String(after.plan), String(proPlan._id));
  assert.deepEqual([after.subscription.billingCycle, after.subscription.amount, after.subscription.planAmount], ['monthly', 12000, 12000]);

  for (const [body, status, code] of [
    [{ billingCycle: 'weekly' }, 400, 'INVALID_CYCLE'],
    [{ planSlug: 'nope' }, 404, 'PLAN_NOT_FOUND']
  ]) {
    const res = await billing('POST', '/pay', { body });
    assert.equal(res.status, status, res.text);
    assert.equal(res.body.code, code);
  }
  // Back on Growth for what follows.
  await Gym.updateOne({ _id: gym._id }, { $set: { plan: plan._id, 'subscription.amount': 8000, 'subscription.planAmount': 8000 } });
});

test('Pay now answers which way to pay when it is not Safepay; the gym Stripe bills is sent to Stripe', async () => {
  const card = await billing('POST', '/pay', { body: {}, user: stripeAdmin, forGym: stripeGym });
  assert.equal(card.status, 409, card.text);
  assert.equal(card.body.code, 'STRIPE_CHECKOUT');

  await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'generic' } } });
  const bank = await billing('POST', '/pay', { body: {} });
  assert.equal(bank.status, 409, bank.text);
  assert.equal(bank.body.code, 'BANK_TRANSFER_ONLY');

  await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'none' } } });
  const off = await billing('POST', '/pay', { body: {} });
  assert.equal(off.status, 409, off.text);
  assert.equal(off.body.code, 'ONLINE_PAYMENT_OFF');

  // A payment opened while Safepay was the way is still recorded after it stops being it.
  await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'safepay' } } });
  const late = await payNow();
  await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'generic' } } });
  fake.pay(late.tracker);
  assert.equal((await deliver(fake.event(late.tracker, 'payment.succeeded', { secret: WEBHOOK }))).body.applied, true);
  await panel('PUT', '/settings', { body: { onlinePayments: { provider: 'safepay' } } });

  // Signed in or nothing.
  assert.equal((await send('POST', '/api/billing/pay', { body: {}, headers: { 'x-tenant-slug': gym.slug } })).status, 401);
});
