// The registry of payment gateways (services/payments): every gateway has
// the one shape checkout, payment links and auto-charge code against, and a
// gym that never chose a gateway reads as Stripe when Stripe is on for it
// and as none otherwise. Pure: settings are passed in.

const test = require('node:test');
const assert = require('node:assert/strict');

const payments = require('../../src/services/payments');

const METHODS = ['isConfigured', 'status', 'unavailableError', 'testConnection', 'createPurchaseCheckout', 'createCheckout', 'chargeSavedMethod', 'fetchStatus', 'verifyWebhook', 'webhookUrl'];
const CAPABILITIES = ['autoCharge', 'bankApps', 'checkout', 'paymentLinks', 'receiptUpload', 'savedCards', 'wallets'];

test('every gateway has the one interface, and the ids are the ones settings accept', () => {
  assert.deepEqual(payments.PROVIDER_IDS, ['stripe', 'safepay', 'generic']);
  assert.deepEqual(payments.CHOICES, ['none', 'stripe', 'safepay', 'generic']);
  for (const provider of payments.listProviders()) {
    assert.equal(typeof provider.id, 'string');
    assert.equal(typeof provider.label, 'string');
    assert.equal(typeof provider.checkoutLabel, 'string');
    assert.ok(Array.isArray(provider.countries), provider.id);
    assert.deepEqual(Object.keys(provider.capabilities).sort(), CAPABILITIES, provider.id);
    for (const value of Object.values(provider.capabilities)) assert.equal(typeof value, 'boolean');
    assert.ok(Array.isArray(provider.configFields), provider.id);
    for (const field of provider.configFields) {
      assert.ok(field.name && field.label && ['text', 'secret', 'select', 'boolean'].includes(field.type), `${provider.id}.${field.name}`);
      assert.equal(field.secret, field.type === 'secret', `${provider.id}.${field.name}`);
      if (field.type === 'select') assert.ok(field.options.length > 0);
    }
    for (const name of METHODS) assert.equal(typeof provider[name], 'function', `${provider.id}.${name}`);
    assert.equal(payments.getProvider(provider.id), provider);
  }
  assert.equal(payments.getProvider('none'), null);
  assert.equal(payments.getProvider('paypal'), null);
});

test('a gym that never chose reads as Stripe when Stripe is on, else none; a stored choice wins', async () => {
  assert.deepEqual(await payments.selectedProviderId({ stripe: { enabled: true } }), { id: 'stripe', explicit: false });
  assert.deepEqual(await payments.selectedProviderId({ stripe: { enabled: false } }), { id: 'none', explicit: false });
  assert.deepEqual(await payments.selectedProviderId({}), { id: 'none', explicit: false });
  assert.deepEqual(await payments.selectedProviderId({ stripe: { enabled: true }, onlinePayments: { provider: 'safepay' } }), { id: 'safepay', explicit: true });
  assert.deepEqual(await payments.selectedProviderId({ stripe: { enabled: true }, onlinePayments: { provider: 'none' } }), { id: 'none', explicit: true });
  // A value no gateway answers to is read as never chosen.
  assert.deepEqual(await payments.selectedProviderId({ stripe: { enabled: true }, onlinePayments: { provider: 'paypal' } }), { id: 'stripe', explicit: false });
});

test('the webhook addresses each gateway has the gym register', () => {
  assert.equal(payments.getProvider('safepay').webhookUrl('https://api.example.test', 'iron'), 'https://api.example.test/api/payments/safepay/webhook/iron');
  assert.equal(payments.getProvider('stripe').webhookUrl('https://api.example.test', 'iron'), 'https://api.example.test/api/gymfolio/payment/webhook/iron');
  assert.equal(payments.getProvider('generic').webhookUrl('https://api.example.test', 'iron'), null);
});

test('what each gateway is offered as at checkout', () => {
  assert.equal(payments.getProvider('safepay').checkoutLabel, 'Card, JazzCash, Easypaisa or any bank app');
  assert.equal(payments.getProvider('stripe').checkoutLabel, 'Card');
  assert.equal(payments.getProvider('generic').checkoutLabel, 'Bank transfer — upload your receipt');
  assert.deepEqual(payments.getProvider('generic').countries, ['*']);
  assert.deepEqual(payments.getProvider('safepay').countries, ['PK']);
});
