// How a campaign recognises who it has already sent to: by the address the
// message log files a recipient under, which for a phone number is the
// normalised number that was actually texted, not what is typed in the
// member's record. No database here; the whole send, batch after batch, is
// in test/integration/campaignSend.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { logAddress, addressFor } = require('../../src/services/campaignService');
const { normalizePhone } = require('../../src/services/messaging');

const member = (fields) => ({ userId: 'u1', email: '', phone: '', ...fields });

test('a phone number is matched as it is logged, however it was typed', () => {
  const pk = { defaultCountryCode: '+92' };
  for (const typed of ['0300 1234567', '0300-1234567', '+92 300 1234567', '00923001234567', '3001234567', 'whatsapp:+923001234567']) {
    assert.equal(logAddress(member({ phone: typed }), 'sms', pk), '+923001234567', typed);
    assert.equal(logAddress(member({ phone: typed }), 'whatsapp', pk), '+923001234567', typed);
  }
  // It is exactly what messaging.js writes in the log's `to`.
  assert.equal(logAddress(member({ phone: '0300 1234567' }), 'sms', pk), normalizePhone('0300 1234567', '+92'));
  // No default country code: still the digits that were sent, not the cell.
  assert.equal(logAddress(member({ phone: '0300 1234567' }), 'sms'), '03001234567');
  // What the audience preview shows is unchanged: the number as stored.
  assert.equal(addressFor(member({ phone: '0300 1234567' }), 'sms'), '0300 1234567');
});

test('a phone cell with no number in it, or none at all, cannot be reached', () => {
  assert.equal(logAddress(member({ phone: 'n/a' }), 'sms', { defaultCountryCode: '+92' }), '');
  assert.equal(logAddress(member({ phone: '' }), 'whatsapp'), '');
});

test('push reaches a member only when they have a device', () => {
  const devices = new Set(['u1']);
  assert.equal(logAddress(member({ userId: 'u1' }), 'push', { devices }), 'u1');
  assert.equal(logAddress(member({ userId: 'u2' }), 'push', { devices }), '');
  // A lead or a newsletter subscriber has no account to push to.
  assert.equal(logAddress(member({ userId: null }), 'push', { devices }), '');
});

test('an email address is matched as it is', () => {
  assert.equal(logAddress(member({ email: 'jo@example.com' }), 'email'), 'jo@example.com');
  assert.equal(logAddress(member({}), 'email'), '');
});
