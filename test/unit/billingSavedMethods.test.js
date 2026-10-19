// Which saved card the due-date charge may use (services/billing/
// savedMethods.js): one with automatic payment on, saved through the gym's
// gateway, not past its expiry month -- and what the member is shown of it.
// Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { isExpired, autoPayMethod, savedMethodView } = require('../../src/services/billing/savedMethods');

const card = (id, extra = {}) => ({ id, provider: 'safepay', token: 'enc:v1:x', customerToken: 'cus', brand: 'Visa', last4: '4242', expMonth: 10, expYear: 2026, autoPay: true, ...extra });
const oct = new Date('2026-10-31T20:00:00Z');
const nov = new Date('2026-11-01T00:00:00Z');

test('a card is good to the end of its expiry month; an unknown expiry is not called expired', () => {
  assert.equal(isExpired(card('a'), oct), false);
  assert.equal(isExpired(card('a'), nov), true);
  assert.equal(isExpired(card('a', { expYear: 26 }), nov), true, 'a two-digit year');
  assert.equal(isExpired(card('a', { expMonth: null, expYear: null }), nov), false);
});

test('the charge uses the first auto-pay card of the gym\'s gateway that has not expired, and says why when none', () => {
  assert.equal(autoPayMethod([card('off', { autoPay: false }), card('on')], 'safepay', oct).method.id, 'on');
  assert.equal(autoPayMethod([card('old', { expYear: 2025 }), card('new', { expYear: 2030 })], 'safepay', oct).method.id, 'new');
  assert.deepEqual(autoPayMethod([], 'safepay', oct), { method: null, reason: 'no saved card with automatic payment' });
  assert.equal(autoPayMethod([card('stripe', { provider: 'stripe' })], 'safepay', oct).reason, 'no saved card with automatic payment', 'another gateway\'s card');
  const expired = autoPayMethod([card('a')], 'safepay', nov);
  assert.equal(expired.method, null);
  assert.equal(expired.reason, 'saved card expired');
  assert.equal(expired.expired.id, 'a');
});

test('what the member is shown carries no token and no gateway customer', () => {
  const view = savedMethodView(card('a', { consentAt: new Date('2026-10-01T00:00:00Z'), consentText: 'I allow' }));
  assert.deepEqual(Object.keys(view).sort(), ['auto_pay', 'brand', 'consent_at', 'consent_text', 'created_at', 'exp_month', 'exp_year', 'id', 'last4', 'provider']);
  assert.equal(view.auto_pay, true);
  assert.equal(savedMethodView(card('b', { autoPay: false })).auto_pay, false);
});
