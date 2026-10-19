// The gym's renewal-billing rules (services/billing/settings.js) and the one
// door to its payment gateway (services/billing/provider.js). Pure logic, no
// database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { billingSettings, leadDays, readBilling, DEFAULTS } = require('../../src/services/billing/settings');
const provider = require('../../src/services/billing/provider');

test('a gym that never saved the block gets the defaults', () => {
  const b = billingSettings({});
  assert.deepEqual(b, {
    reminderDaysBefore: [3],
    dueDayReminder: true,
    lastDayAfterDue: 3,
    sendVia: { email: true, sms: false, whatsapp: true, push: true },
    autoCharge: { enabled: false }
  });
  assert.deepEqual(billingSettings(null), b);
  assert.equal(leadDays(b), 3);
  assert.deepEqual(DEFAULTS.reminderDaysBefore, [3]);
});

test('stored values are read leniently: out of range days dropped, largest first, no repeats', () => {
  const b = billingSettings({ billing: { reminderDaysBefore: [1, 7, 7, 45, -1, 'x', 3], lastDayAfterDue: 99, sendVia: { sms: true } } });
  assert.deepEqual(b.reminderDaysBefore, [7, 3, 1]);
  assert.equal(b.lastDayAfterDue, 3, 'out of range: the default');
  assert.deepEqual(b.sendVia, { email: true, sms: true, whatsapp: true, push: true });
  assert.equal(leadDays(b), 7);
  assert.equal(leadDays(billingSettings({ billing: { reminderDaysBefore: [] } })), 0, 'no reminders before: made on the due day');
});

test('a save is read strictly, over what is stored', () => {
  const stored = { reminderDaysBefore: [5], dueDayReminder: false, lastDayAfterDue: 2, sendVia: { email: true, sms: true, whatsapp: false, push: false }, autoCharge: { enabled: true } };
  const { value, problem } = readBilling({ reminderDaysBefore: ['3', 1], sendVia: { whatsapp: 'true' } }, stored);
  assert.equal(problem, undefined);
  assert.deepEqual(value, {
    reminderDaysBefore: [3, 1],
    dueDayReminder: false,
    lastDayAfterDue: 2,
    sendVia: { email: true, sms: true, whatsapp: true, push: false },
    autoCharge: { enabled: true }
  });
  assert.equal(readBilling({ autoCharge: false }, stored).value.autoCharge.enabled, false, 'a bare boolean is read as enabled');
  assert.equal(readBilling({ lastDayAfterDue: 0 }, stored).value.lastDayAfterDue, 0, '0: no last-day message');
});

test('a value it cannot use is refused, naming the field', () => {
  const cases = [
    [{ reminderDaysBefore: 3 }, /reminderDaysBefore must be a list/],
    [{ reminderDaysBefore: [31] }, /from 0 to 30/],
    [{ reminderDaysBefore: [1.5] }, /whole number/],
    [{ reminderDaysBefore: [1, 2, 3, 4, 5, 6] }, /at most 5/],
    [{ dueDayReminder: 'maybe' }, /dueDayReminder must be true or false/],
    [{ lastDayAfterDue: -1 }, /lastDayAfterDue must be a whole number/],
    [{ sendVia: { sms: 'yes' } }, /sendVia\.sms must be true or false/],
    [{ autoCharge: { enabled: 'on' } }, /autoCharge\.enabled/],
    ['on', /billing must be an object/]
  ];
  for (const [input, message] of cases) {
    const { value, problem } = readBilling(input, {});
    assert.equal(value, undefined, JSON.stringify(input));
    assert.match(problem, message);
  }
});

test('the gateway door: no registry is no gateway; a test can swap one in; capabilities are read, not assumed', async () => {
  // This worktree may or may not have services/payments yet: either way it answers, never throws.
  const real = await provider.activeProvider();
  assert.ok(real === null || typeof real === 'object');

  const fake = { id: 'safepay', label: 'Safepay', capabilities: { checkout: true, autoCharge: true }, createCheckout() {}, chargeSavedMethod() {} };
  provider.setProviderForTests(fake);
  assert.equal(await provider.activeProvider(), fake);
  provider.setProviderForTests(async () => null);
  assert.equal(await provider.activeProvider(), null);
  provider.setProviderForTests(undefined);

  assert.equal(provider.canCheckout(fake), true);
  assert.equal(provider.canAutoCharge(fake), true);
  assert.equal(provider.canAutoCharge({ ...fake, capabilities: { checkout: true } }), false, 'autoCharge must be said');
  assert.equal(provider.canAutoCharge({ ...fake, chargeSavedMethod: undefined }), false);
  assert.equal(provider.canCheckout(null), false);
  assert.equal(provider.onlineLabel(fake), 'Card, JazzCash, Easypaisa or any bank app');
  assert.equal(provider.onlineLabel({ id: 'stripe' }), 'Card');
  assert.equal(provider.onlineLabel({ id: 'payfast', label: 'PayFast' }), 'PayFast');
  assert.equal(provider.onlineLabel({ id: 'safepay', memberLabel: 'Pay online' }), 'Pay online');
  assert.equal(provider.onlineLabel(null), null);
});
