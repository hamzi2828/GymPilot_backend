// A trainer's PT commission terms (gymfolio/services/ptService.js): a percent
// of what the session was worth or a fixed amount per session, the trainer's
// own terms before an older percent, and the gym's default last. No database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { commissionTerms, commissionFor } = require('../../src/gymfolio/services/ptService');

test('the trainer\'s own terms come first, then a percent set before them, then the gym\'s default', () => {
  assert.deepEqual(commissionTerms({ commissionType: 'amount', commissionValue: 500, commissionPercent: null }, 10), { basis: 'amount', value: 500 });
  assert.deepEqual(commissionTerms({ commissionType: 'percent', commissionValue: 15, commissionPercent: 15 }, 10), { basis: 'percent', value: 15 });
  // A trainer set up before the fixed amount existed.
  assert.deepEqual(commissionTerms({ commissionPercent: 20 }, 10), { basis: 'percent', value: 20 });
  // Nothing of their own: the gym's default.
  assert.deepEqual(commissionTerms({ commissionType: null, commissionValue: null, commissionPercent: null }, 10), { basis: 'percent', value: 10 });
  assert.deepEqual(commissionTerms(null, 7), { basis: 'percent', value: 7 });
  // A type with no value is not a term.
  assert.deepEqual(commissionTerms({ commissionType: 'amount', commissionValue: null }, 10), { basis: 'percent', value: 10 });
  // 0 is a real term: no commission.
  assert.deepEqual(commissionTerms({ commissionType: 'percent', commissionValue: 0 }, 10), { basis: 'percent', value: 0 });
});

test('a percent is of the session\'s worth; a fixed amount is paid whatever the session was worth', () => {
  assert.deepEqual(commissionFor(2000, { basis: 'percent', value: 15 }), { basis: 'percent', percent: 15, amount: 300 });
  assert.deepEqual(commissionFor(333.33, { basis: 'percent', value: 10 }), { basis: 'percent', percent: 10, amount: 33.33 });
  assert.deepEqual(commissionFor(2000, { basis: 'amount', value: 500 }), { basis: 'amount', percent: 0, amount: 500 });
  // A free taster still earns the fixed amount, and nothing on a percent.
  assert.deepEqual(commissionFor(0, { basis: 'amount', value: 250.5 }), { basis: 'amount', percent: 0, amount: 250.5 });
  assert.deepEqual(commissionFor(0, { basis: 'percent', value: 50 }), { basis: 'percent', percent: 50, amount: 0 });
});
