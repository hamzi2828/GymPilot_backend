process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { packageSnapshot, termEnd } = require('../../src/gymfolio/services/membershipService');

const start = new Date('2026-01-31T10:00:00Z');

test('packageSnapshot fills in the shape older packages never had', () => {
  const snap = packageSnapshot({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['x'] });
  assert.equal(snap.kind, 'membership');
  assert.equal(snap.billing.mode, 'one_time');
  assert.equal(snap.sessions, 0);
  assert.equal(snap.joiningFee, 0);
});

test('termEnd follows the period label for one-off packages', () => {
  assert.equal(termEnd(start, { period: 'month' }).toISOString().slice(0, 10), '2026-03-03');
  assert.equal(termEnd(start, { period: '3 months' }).toISOString().slice(0, 10), '2026-05-01');
  assert.equal(termEnd(start, { period: 'year' }).toISOString().slice(0, 10), '2027-01-31');
  assert.equal(termEnd(start, { period: 'week' }).toISOString().slice(0, 10), '2026-02-07');
  assert.equal(termEnd(start, { period: 'whatever' }).toISOString().slice(0, 10), '2026-03-02');
});

test('an explicit duration in days wins, and recurring intervals are honoured', () => {
  assert.equal(termEnd(start, { period: 'month', durationDays: 10 }).toISOString().slice(0, 10), '2026-02-10');
  assert.equal(termEnd(start, { billing: { mode: 'recurring', interval: 'week', intervalCount: 2 } }).toISOString().slice(0, 10), '2026-02-14');
  assert.equal(termEnd(start, { billing: { mode: 'recurring', interval: 'year', intervalCount: 1 } }).toISOString().slice(0, 10), '2027-01-31');
});
