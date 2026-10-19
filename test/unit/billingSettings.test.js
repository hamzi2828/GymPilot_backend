// The gym's renewal-billing rules as the billing side reads them
// (services/billing/settings.js -- saving and checking them is PUT /settings')
// and the one door to its payment gateway (services/billing/provider.js).
// Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { billingSettings, leadDays, DEFAULTS } = require('../../src/services/billing/settings');
const provider = require('../../src/services/billing/provider');

test('a gym that never saved the block gets the defaults', () => {
  const b = billingSettings({});
  assert.deepEqual(b, {
    reminderDaysBefore: [3],
    dueDayReminder: true,
    lastDayAfterDue: 3,
    sendVia: { email: true, sms: false, whatsapp: false, push: true },
    autoCharge: { enabled: false }
  });
  assert.deepEqual(billingSettings(null), b);
  assert.equal(leadDays(b), 3);
  assert.deepEqual(DEFAULTS.reminderDaysBefore, [3]);
});

test('stored values are read leniently: out of range days dropped, largest first, no repeats, at most ten', () => {
  assert.equal(billingSettings({ billing: { reminderDaysBefore: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } }).reminderDaysBefore.length, 10);
  const b = billingSettings({ billing: { reminderDaysBefore: [1, 7, 7, 45, -1, 'x', 3], lastDayAfterDue: 99, sendVia: { sms: true } } });
  assert.deepEqual(b.reminderDaysBefore, [7, 3, 1]);
  assert.equal(b.lastDayAfterDue, 3, 'out of range: the default');
  assert.deepEqual(b.sendVia, { email: true, sms: true, whatsapp: false, push: true });
  assert.equal(leadDays(b), 7);
  assert.equal(leadDays(billingSettings({ billing: { reminderDaysBefore: [] } })), 0, 'no reminders before: made on the due day');
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
  assert.equal(provider.canCheckout({ ...fake, capabilities: { checkout: true, paymentLinks: false } }), false, 'a gateway that takes no payment links (Stripe)');
  assert.equal(provider.canCheckout({ ...fake, capabilities: { checkout: false, paymentLinks: true } }), false, 'one that opens no checkout (bank transfer)');
  assert.equal(provider.onlineLabel(fake), 'Card, JazzCash, Easypaisa or any bank app');
  assert.equal(provider.onlineLabel({ id: 'stripe' }), 'Card');
  assert.equal(provider.onlineLabel({ id: 'payfast', label: 'PayFast' }), 'PayFast');
  assert.equal(provider.onlineLabel({ id: 'safepay', memberLabel: 'Pay online' }), 'Pay online');
  assert.equal(provider.onlineLabel(null), null);
  // The registry's own wording for the gateway wins (services/payments checkoutLabel).
  assert.equal(provider.onlineLabel({ id: 'payfast', label: 'PayFast', checkoutLabel: 'Card or bank account' }), 'Card or bank account');
});
