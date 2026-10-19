// A gym's online payment gateway, against a real MongoDB through the
// settings and payment controllers: the gateways it can choose from
// (Stripe, Safepay, generic bank transfer) and their forms; Safepay's keys
// masked and sealed like Stripe's, with the address to register for its
// webhook; the billing reminders read strictly; the choice stored only once
// it is made; "Test connection" against a stand-in Safepay; and what the
// website's checkout is told it can offer.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');
const { createFakeSafepay } = require('./helpers/fakeSafepay');

const SECRET = 'sec_gateway_secret_9999';
const PUBLIC = 'pub_gateway_key';
const WEBHOOK = 'whsec_gateway_shared_7777';
const SLUG = 'gateways-gym';

let gym;
let fake;
let settings;
let orders;
let Settings;
let Bank;

const test = h.suite(async () => {
  fake = await createFakeSafepay({ secretKey: SECRET, publicKey: PUBLIC }).start();
  process.env.SAFEPAY_API_BASE_URL = fake.base;
  settings = h.src('controller/settingsController');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  Settings = h.src('models/settings');
  Bank = h.src('models/bank');
  gym = await h.createGym(SLUG, { currency: 'PKR' });
});

require('node:test').after(async () => {
  delete process.env.SAFEPAY_API_BASE_URL;
  if (fake) await fake.stop();
});

const req = (extra = {}) => ({ headers: { host: 'api.gateways.test' }, protocol: 'https', ...extra });
const put = (body) => h.call(settings.updateSettings, req({ body }));
const shown = async () => (await h.call(settings.getSettings, req())).body.data;
const methods = async () => (await h.call(orders.paymentMethods, {})).body.data;
const raw = () => h.rawDb(gym.database.name).collection('settings').findOne({ isActive: true });

test('a gym that never chose reads as no gateway, with the Safepay webhook address to register', async () => {
  await h.inGym(gym, async () => {
    const data = await shown();
    assert.deepEqual(data.onlinePayments, { provider: 'none', providerChosen: false });
    assert.equal(data.safepay.webhook_url, `https://api.gateways.test/api/payments/safepay/webhook/${SLUG}`);
    assert.equal(data.safepay.enabled, false);
    assert.equal(data.safepay.environment, 'sandbox');
    assert.deepEqual(data.billing.reminderDaysBefore, [3]);
    assert.equal(data.billing.lastDayAfterDue, 3);
    assert.equal(data.billing.autoCharge.enabled, false);
    // As before: no Stripe, so the checkout is told card is off and why.
    const m = await methods();
    assert.equal(m.card, false);
    assert.equal(m.cardUnavailable.code, 'STRIPE_NOT_CONFIGURED');
    assert.equal(m.online, null);
  });
});

test("Safepay's keys are masked on the way out, kept when sent back masked, and sealed at rest", async () => {
  await h.inGym(gym, async () => {
    const first = await put({ safepay: { enabled: true, environment: 'sandbox', publicKey: PUBLIC, secretKey: SECRET, webhookSecret: WEBHOOK } });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    const data = first.body.data;
    assert.equal(data.safepay.secretKey, '••••••••9999');
    assert.equal(data.safepay.webhookSecret, '••••••••7777');
    assert.equal(data.safepay.secretKeySet, true);
    assert.equal(data.safepay.publicKey, PUBLIC);
    assert.ok(data.safepay.webhook_url, 'the PUT answer carries the webhook address too');

    // The page sends the masked values back on every save: the keys stay.
    const again = await put({ safepay: { ...data.safepay, environment: 'production' } });
    assert.equal(again.statusCode, 200, JSON.stringify(again.body));
    const stored = await Settings.getSettings();
    assert.equal(stored.safepay.secretKey, SECRET);
    assert.equal(stored.safepay.webhookSecret, WEBHOOK);
    assert.equal(stored.safepay.environment, 'production');
    const row = await raw();
    assert.match(row.safepay.secretKey, /^enc:v1:/);
    assert.match(row.safepay.webhookSecret, /^enc:v1:/);
    assert.doesNotMatch(JSON.stringify(row.safepay), new RegExp(SECRET));

    const bad = await put({ safepay: { environment: 'live' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.message, /sandbox or production/);
    await put({ safepay: { environment: 'sandbox' } });

    // Never on the public endpoint.
    const pub = await h.call(settings.getPublicSettings, {});
    assert.doesNotMatch(JSON.stringify(pub.body), /safepay|sec_gateway|whsec_gateway/i);
  });
});

test('billing reminders are read strictly and stored as days, largest first', async () => {
  await h.inGym(gym, async () => {
    const ok = await put({ billing: { reminderDaysBefore: [3, 7, 3, 0], dueDayReminder: false, lastDayAfterDue: 5, sendVia: { sms: true, whatsapp: 'true', push: false }, autoCharge: { enabled: true } } });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.billing, {
      reminderDaysBefore: [7, 3, 0],
      dueDayReminder: false,
      lastDayAfterDue: 5,
      sendVia: { email: true, sms: true, whatsapp: true, push: false },
      autoCharge: { enabled: true }
    });
    // A partial save changes only what it sends.
    const partial = await put({ billing: { lastDayAfterDue: 0 } });
    assert.deepEqual(partial.body.data.billing.reminderDaysBefore, [7, 3, 0]);
    assert.equal(partial.body.data.billing.lastDayAfterDue, 0);

    for (const [billing, field] of [
      [{ reminderDaysBefore: [31] }, /reminderDaysBefore/],
      [{ reminderDaysBefore: [-1] }, /reminderDaysBefore/],
      [{ reminderDaysBefore: [2.5] }, /reminderDaysBefore/],
      [{ reminderDaysBefore: 3 }, /list of days/],
      [{ lastDayAfterDue: 'soon' }, /lastDayAfterDue/],
      [{ lastDayAfterDue: 40 }, /lastDayAfterDue/]
    ]) {
      const res = await put({ billing });
      assert.equal(res.statusCode, 400, JSON.stringify(billing));
      assert.match(res.body.message, field);
    }
    const kept = await Settings.getSettings();
    assert.deepEqual(kept.billing.reminderDaysBefore, [7, 3, 0]);
  });
});

test('the gateway is stored once chosen, never pinned by the page sending back what it read', async () => {
  await h.inGym(gym, async () => {
    const wrong = await put({ onlinePayments: { provider: 'paypal' } });
    assert.equal(wrong.statusCode, 400);
    assert.match(wrong.body.message, /none, stripe, safepay, generic/);

    // The page sends back 'none' as it read it: nothing is stored, and the save is fine.
    const echoed = await put({ onlinePayments: { provider: 'none' } });
    assert.equal(echoed.statusCode, 200, JSON.stringify(echoed.body));
    assert.equal(echoed.body.data.onlinePayments.providerChosen, false);
    assert.equal(((await raw()).onlinePayments || {}).provider, undefined);

    const chosen = await put({ onlinePayments: { provider: 'safepay' } });
    assert.equal(chosen.statusCode, 200);
    assert.deepEqual(chosen.body.data.onlinePayments, { provider: 'safepay', providerChosen: true });
    assert.equal((await raw()).onlinePayments.provider, 'safepay');
  });
});

test('the gateway list says what each gateway does, the fields its form needs, and which is set up and chosen', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(settings.paymentGateways, req());
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.map((row) => row.id), ['stripe', 'safepay', 'generic']);
    assert.equal(res.body.selected, 'safepay');
    const byId = Object.fromEntries(res.body.data.map((row) => [row.id, row]));

    for (const row of res.body.data) {
      assert.deepEqual(Object.keys(row.capabilities).sort(), ['autoCharge', 'bankApps', 'checkout', 'paymentLinks', 'receiptUpload', 'savedCards', 'wallets'], row.id);
      assert.equal(typeof row.configured, 'boolean');
      assert.equal(row.selected, row.id === 'safepay');
    }
    assert.deepEqual(byId.safepay.countries, ['PK']);
    assert.deepEqual(byId.safepay.capabilities, { checkout: true, paymentLinks: true, receiptUpload: false, savedCards: true, autoCharge: true, wallets: true, bankApps: true });
    assert.deepEqual(byId.safepay.config_fields.map((f) => [f.name, f.type, f.secret]), [
      ['enabled', 'boolean', false],
      ['environment', 'select', false],
      ['publicKey', 'text', false],
      ['secretKey', 'secret', true],
      ['webhookSecret', 'secret', true]
    ]);
    assert.deepEqual(byId.safepay.config_fields[1].options.map((o) => o.value), ['sandbox', 'production']);
    assert.equal(byId.safepay.settings_key, 'safepay');
    assert.equal(byId.safepay.configured, true);
    assert.equal(byId.safepay.webhook_url, `https://api.gateways.test/api/payments/safepay/webhook/${SLUG}`);
    assert.equal(byId.stripe.configured, false);
    assert.equal(byId.stripe.webhook_url, `https://api.gateways.test/api/gymfolio/payment/webhook/${SLUG}`);
    assert.deepEqual(byId.generic.countries, ['*']);
    assert.equal(byId.generic.label, 'Generic — bank transfer with receipt (works anywhere)');
    assert.deepEqual(byId.generic.capabilities, { checkout: false, paymentLinks: true, receiptUpload: true, savedCards: false, autoCharge: false, wallets: false, bankApps: true });
    assert.deepEqual(byId.generic.config_fields, []);
    assert.equal(byId.generic.configured, false, 'no bank account yet');
    // Never a secret in the list.
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(`${SECRET}|${WEBHOOK}`));
  });
});

test('"Test connection" asks Safepay with the saved keys, or the typed ones, and says what Safepay said', async () => {
  await h.inGym(gym, async () => {
    const test1 = (body) => h.call(settings.testGateway, req({ body }));
    const saved = await test1({});
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.success, true);
    assert.match(saved.body.message, /Connected to Safepay \(sandbox\)/);
    const passport = fake.callsTo('POST', '/client/passport/v1/token').slice(-1)[0];
    assert.equal(passport.headers['x-sfpy-merchant-secret'], SECRET);

    // The masked preview means "the saved one".
    assert.equal((await test1({ secretKey: '••••••••9999' })).statusCode, 200);

    const typed = await test1({ secretKey: 'sec_typo', publicKey: PUBLIC });
    assert.equal(typed.statusCode, 400);
    assert.equal(typed.body.success, false);
    assert.match(typed.body.message, /Safepay refused the keys/);

    const wrongKey = await test1({ publicKey: 'pub_someone_else' });
    assert.equal(wrongKey.statusCode, 400);
    assert.match(wrongKey.body.message, /merchant_api_key/);

    // The generic gateway reports its bank accounts.
    const generic = (await h.call(settings.testGateway, req({ params: { id: 'generic' }, body: {} }))).body;
    assert.deepEqual([generic.success, /Settings → Banks/.test(generic.message)], [false, true]);
    await Bank.create({ name: 'Meezan Bank', accountTitle: 'Gateways Gym', accountNumber: '0101-1234567', iban: 'PK36MEZN0001010101234567' });
    const ready = (await h.call(settings.testGateway, req({ params: { id: 'generic' }, body: {} }))).body;
    assert.deepEqual([ready.success, ready.message], [true, '1 bank account is ready for transfers.']);
    assert.equal((await h.call(settings.testGateway, req({ params: { id: 'nope' }, body: {} }))).statusCode, 404);
  });
});

test('the checkout is told what the chosen gateway offers right now', async () => {
  await h.inGym(gym, async () => {
    // Safepay chosen and fully set up.
    let m = await methods();
    assert.equal(m.card, true);
    assert.equal(m.cardUnavailable, null);
    assert.deepEqual(m.online, { provider: 'safepay', label: 'Card, JazzCash, Easypaisa or any bank app' });
    assert.equal(m.bankTransfer, true);

    // Without the webhook secret no new payment starts.
    await Settings.updateOne({ isActive: true }, { $set: { 'safepay.webhookSecret': '' } });
    m = await methods();
    assert.deepEqual([m.card, m.cardUnavailable.code, m.online], [false, 'SAFEPAY_WEBHOOK_NOT_CONFIGURED', null]);
    await put({ safepay: { webhookSecret: WEBHOOK } });

    // Generic: the bank transfer is the way to pay.
    await put({ onlinePayments: { provider: 'generic' } });
    m = await methods();
    assert.deepEqual([m.card, m.cardUnavailable.code], [false, 'BANK_TRANSFER_ONLY']);
    assert.deepEqual(m.online, { provider: 'generic', label: 'Bank transfer — upload your receipt' });

    // Switched off on purpose.
    await put({ onlinePayments: { provider: 'none' } });
    m = await methods();
    assert.deepEqual([m.card, m.cardUnavailable.code, m.online], [false, 'ONLINE_PAYMENTS_OFF', null]);
    await put({ onlinePayments: { provider: 'safepay' } });
  });
});

test('every new payment setting route needs settings, and the writes need manage', async () => {
  const router = h.src('routes/allRoutes');
  const find = (method, path) => router.stack.find((entry) => entry.route && entry.route.path === path && entry.route.methods[method]);
  for (const [method, path] of [['get', '/settings/payment-gateways'], ['post', '/settings/safepay/test'], ['post', '/settings/payment-gateways/:id/test']]) {
    const layer = find(method, path);
    assert.ok(layer, `${method} ${path} is routed`);
    assert.equal(layer.route.stack[1].handle.name, 'permissionGate', `${method} ${path} is gated`);
  }
});
