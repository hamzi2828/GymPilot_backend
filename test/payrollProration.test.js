// Salaries: a whole calendar month costs exactly the monthly salary, whatever
// its length, a part-month is that month's share, and weekly and fortnightly
// salaries are counted per cycle. Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/accounts/services/ledger');
const { daysInside } = require('../src/services/payrollService');

const cents = (n) => Math.round(n * 100) / 100;

test('a full calendar month pays exactly the monthly salary, February included', () => {
  assert.equal(cents(L.salaryForDays(3000, 'monthly', '2026-02-01', '2026-02-28')), 3000);
  assert.equal(cents(L.salaryForDays(3000, 'monthly', '2028-02-01', '2028-02-29')), 3000);
  assert.equal(cents(L.salaryForDays(3000, 'monthly', '2026-01-01', '2026-01-31')), 3000);
  assert.equal(cents(L.salaryForDays(3000, 'monthly', '2026-09-01', '2026-09-30')), 3000);
  // No cycle set means monthly, as it always did.
  assert.equal(cents(L.salaryForDays(3000, undefined, '2026-02-01', '2026-02-28')), 3000);
  // A quarter is three salaries.
  assert.equal(cents(L.salaryForDays(3000, 'monthly', '2026-01-01', '2026-03-31')), 9000);
});

test('a part-month is pro-rated by the days of that month', () => {
  // Half of September (30 days).
  assert.equal(cents(L.salaryForDays(3000, 'monthly', '2026-09-01', '2026-09-15')), 1500);
  // Ten days of February are worth more than ten days of January.
  assert.equal(cents(L.salaryForDays(2800, 'monthly', '2026-02-01', '2026-02-10')), 1000);
  assert.equal(cents(L.salaryForDays(3100, 'monthly', '2026-01-01', '2026-01-10')), 1000);
  // Across two months each part is its own month's share: 17/31 + 14/28.
  assert.equal(cents(L.salaryForDays(3100, 'monthly', '2026-01-15', '2026-02-14')), cents(1700 + 1550));
  assert.equal(L.salaryPerDay(2800, 'monthly', '2026-02-10'), 100);
});

test('weekly and fortnightly salaries are counted per cycle', () => {
  assert.equal(cents(L.salaryForDays(700, 'weekly', '2026-09-07', '2026-09-13')), 700);
  // A 30-day month is four and two-sevenths weeks, not one salary.
  assert.equal(cents(L.salaryForDays(700, 'weekly', '2026-09-01', '2026-09-30')), 3000);
  assert.equal(cents(L.salaryForDays(1400, 'biweekly', '2026-09-01', '2026-09-14')), 1400);
  assert.equal(cents(L.salaryForDays(1400, 'biweekly', '2026-09-01', '2026-09-30')), 3000);
});

test('nothing is owed for an empty or unset salary, or a range that ends before it starts', () => {
  assert.equal(L.salaryForDays(0, 'monthly', '2026-09-01', '2026-09-30'), 0);
  assert.equal(L.salaryForDays(undefined, 'monthly', '2026-09-01', '2026-09-30'), 0);
  assert.equal(L.salaryForDays(3000, 'monthly', '2026-09-30', '2026-09-01'), 0);
});

test('leave days are clipped to the payslip period', () => {
  assert.equal(daysInside('2026-08-28', '2026-09-03', '2026-09-01', '2026-09-30'), 3);
  assert.equal(daysInside('2026-09-10', '2026-09-12', '2026-09-01', '2026-09-30'), 3);
  assert.equal(daysInside('2026-10-01', '2026-10-05', '2026-09-01', '2026-09-30'), 0);
});
