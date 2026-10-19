// How gyms pay GymsPilotPro, as plain functions: which way is chosen (and
// what an unchosen platform reads as), what the Payments page is told about
// each way, the masked secrets, the reminders read strictly, and a bank
// account read whole. No database: settings are plain objects.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const gateways = require('../../src/platform/services/payments');
const bankAccounts = require('../../src/platform/services/platformBankAccounts');
const { maskSecret, readReminders, remindersView } = require('../../src/platform/controllers/platformSettingsController');

const keys = { publicKey: 'pub_x', secretKey: 'sec_x', webhookSecret: 'whsec_x' };

test('the registry lists stripe, safepay and generic, and none is a choice too', () => {
  assert.deepEqual(gateways.PROVIDER_IDS, ['stripe', 'safepay', 'generic']);
  assert.deepEqual(gateways.CHOICES, ['none', 'stripe', 'safepay', 'generic']);
  assert.equal(gateways.getProvider('paypal'), null);
  for (const provider of gateways.listProviders()) {
    assert.ok(provider.label && provider.description && provider.checkoutLabel, provider.id);
    assert.ok(Array.isArray(provider.configFields));
    assert.ok(!provider.configFields.some((f) => f.name === 'enabled'), `${provider.id}: choosing it is its switch`);
  }
});

test('an unchosen platform reads as Stripe while Stripe is switched on, and none otherwise', () => {
  assert.deepEqual(gateways.selectedFrom({}), { id: 'none', explicit: false });
  assert.deepEqual(gateways.selectedFrom({ stripe: { enabled: true } }), { id: 'stripe', explicit: false });
  assert.deepEqual(gateways.selectedFrom({ stripe: { enabled: true }, onlinePayments: { provider: 'generic' } }), { id: 'generic', explicit: true });
  assert.deepEqual(gateways.selectedFrom({ stripe: { enabled: true }, onlinePayments: { provider: 'none' } }), { id: 'none', explicit: true });
  // Something that is not a choice (a gateway removed later) reads as unset.
  assert.deepEqual(gateways.selectedFrom({ onlinePayments: { provider: 'paypal' } }), { id: 'none', explicit: false });
});

test('each way is set up by its own rule: Stripe and Safepay their keys, bank transfer an active account', async () => {
  const configured = async (id, settings) => !!(await gateways.getProvider(id).isConfigured(settings));
  assert.equal(await configured('stripe', { stripe: { secretKey: 'sk_x' } }), false, 'the webhook secret too');
  assert.equal(await configured('stripe', { stripe: { secretKey: 'sk_x', webhookSecret: 'whsec_x' } }), true);
  assert.equal(await configured('safepay', { safepay: { publicKey: 'pub', secretKey: 'sec' } }), false);
  assert.equal(await configured('safepay', { safepay: keys }), true);
  assert.equal(await configured('generic', { bankAccounts: [{ active: false }] }), false);
  assert.equal(await configured('generic', { bankAccounts: [{ active: false }, { active: true }] }), true);

  // Chosen AND set up, or nothing.
  assert.equal(await gateways.activeProvider({ onlinePayments: { provider: 'safepay' }, safepay: { publicKey: 'pub' } }), null);
  assert.equal((await gateways.activeProvider({ onlinePayments: { provider: 'safepay' }, safepay: keys })).id, 'safepay');
  assert.equal(await gateways.activeProvider({ onlinePayments: { provider: 'none' }, safepay: keys }), null);
});

test('the Payments page is told every way, its fields, whether set up and which is chosen', async () => {
  const { data, selected } = await gateways.describeProviders({
    settings: { onlinePayments: { provider: 'safepay' }, safepay: keys, bankAccounts: [] },
    apiBase: 'https://api.gymspilotpro.test'
  });
  assert.equal(selected, 'safepay');
  assert.deepEqual(data.map((row) => [row.id, row.selected, row.configured]), [['stripe', false, false], ['safepay', true, true], ['generic', false, false]]);
  assert.equal(data[1].webhook_url, 'https://api.gymspilotpro.test/api/platform/safepay/webhook');
  assert.equal(data[0].webhook_url, 'https://api.gymspilotpro.test/api/platform/stripe/webhook');
  assert.equal(data[2].webhook_url, null);
  // Copies: the page cannot change the registry by editing what it got.
  data[1].config_fields[0].options[0].label = 'changed';
  assert.notEqual(gateways.getProvider('safepay').configFields[0].options[0].label, 'changed');
});

test('a secret is shown as eight dots and its last four characters, never more', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret('abc'), '•••');
  assert.equal(maskSecret('sec_live_1234567890'), '••••••••7890');
});

test('the owner reminders are read strictly: whole days 0-30, at most ten, largest first', () => {
  assert.deepEqual(remindersView({}), { daysBefore: [3], onDueDay: true, lastDayAfterDue: 3 });
  assert.deepEqual(readReminders({ daysBefore: [1, 7, 1, '3'] }).value.daysBefore, [7, 3, 1]);
  assert.deepEqual(readReminders({ onDueDay: false }, { daysBefore: [5], onDueDay: true, lastDayAfterDue: 2 }).value, { daysBefore: [5], onDueDay: false, lastDayAfterDue: 2 });
  assert.match(readReminders({ daysBefore: Array.from({ length: 11 }, (_, i) => i) }).problem, /at most 10/);
  assert.match(readReminders({ daysBefore: [31] }).problem, /0 to 30/);
  assert.match(readReminders({ lastDayAfterDue: '' }).problem, /lastDayAfterDue/);
  assert.equal(readReminders({ lastDayAfterDue: 0 }).value.lastDayAfterDue, 0);
});

test('a bank account is read whole: name, title, a number or a valid IBAN', () => {
  assert.match(bankAccounts.readAccount({}).problem, /bank name/);
  assert.match(bankAccounts.readAccount({ bankName: 'HBL' }).problem, /account title/);
  assert.match(bankAccounts.readAccount({ bankName: 'HBL', accountTitle: 'GPP' }).problem, /number or the IBAN/);
  assert.match(bankAccounts.readAccount({ bankName: 'HBL', accountTitle: 'GPP', iban: 'PK1' }).problem, /IBAN/);
  assert.deepEqual(bankAccounts.readAccount({ bankName: ' HBL ', accountTitle: 'GPP', iban: 'pk36 scbl 0000 0011 2345 6702' }).value, {
    bankName: 'HBL',
    accountTitle: 'GPP',
    accountNumber: '',
    iban: 'PK36SCBL0000001123456702',
    active: true
  });
  // An edit changes what it sends and keeps the rest.
  const existing = { bankName: 'HBL', accountTitle: 'GPP', accountNumber: '123', iban: '', active: true };
  assert.deepEqual(bankAccounts.readAccount({ active: false }, existing).value, { ...existing, active: false });
  // What a gym's Billing tab is shown.
  assert.deepEqual(bankAccounts.gymFacingAccount({ bankName: 'HBL', accountTitle: 'GPP', accountNumber: '123', iban: 'PK36', qrCodeUrl: '/uploads/q.png' }), {
    bank_name: 'HBL',
    account_title: 'GPP',
    account_number: '123',
    iban: 'PK36',
    qr_code_url: '/uploads/q.png'
  });
});
