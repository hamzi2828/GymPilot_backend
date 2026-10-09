process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { packageSnapshot, termEnd, periodLength, periodProblem, MembershipError } = require('../../src/gymfolio/services/membershipService');

const start = new Date('2026-01-31T10:00:00Z');

test('a MembershipError carries its name, which is how the booking and PT handlers recognise it', () => {
  // classBookingController and ptController test `error.name`, not the
  // class: without the name a used-up pack answered 500 instead of saying so.
  const error = new MembershipError('No sessions left on this pack', 400, 'NO_SESSIONS');
  assert.equal(error.name, 'MembershipError');
  assert.ok(error instanceof Error);
  assert.deepEqual([error.message, error.status, error.code], ['No sessions left on this pack', 400, 'NO_SESSIONS']);
  assert.deepEqual([new MembershipError('x').status, new MembershipError('x').code], [400, null]);
});

test('packageSnapshot fills in the shape older packages never had', () => {
  const snap = packageSnapshot({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['x'] });
  assert.equal(snap.kind, 'membership');
  assert.equal(snap.billing.mode, 'one_time');
  assert.equal(snap.sessions, 0);
  assert.equal(snap.joiningFee, 0);
});

test('termEnd follows the period label for one-off packages', () => {
  // A month from 31 Jan ends on the last day of February, not 3 March.
  assert.equal(termEnd(start, { period: 'month' }).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(termEnd(start, { period: '3 months' }).toISOString().slice(0, 10), '2026-04-30');
  assert.equal(termEnd(start, { period: 'year' }).toISOString().slice(0, 10), '2027-01-31');
  assert.equal(termEnd(start, { period: 'week' }).toISOString().slice(0, 10), '2026-02-07');
  assert.equal(termEnd(start, { period: 'whatever' }).toISOString().slice(0, 10), '2026-03-02');
});

test('an explicit duration in days wins, and recurring intervals are honoured', () => {
  assert.equal(termEnd(start, { period: 'month', durationDays: 10 }).toISOString().slice(0, 10), '2026-02-10');
  assert.equal(termEnd(start, { billing: { mode: 'recurring', interval: 'week', intervalCount: 2 } }).toISOString().slice(0, 10), '2026-02-14');
  assert.equal(termEnd(start, { billing: { mode: 'recurring', interval: 'year', intervalCount: 1 } }).toISOString().slice(0, 10), '2027-01-31');
});

test('a period label is read as the length it names, whatever a gym calls its plans', () => {
  const months = (n) => ({ months: n });
  const days = (n) => ({ days: n });
  const cases = [
    // The plain units, alone or counted.
    ['day', days(1)], ['daily', days(1)], ['30 days', days(30)], ['7 day trial', days(7)],
    ['week', days(7)], ['weekly', days(7)], ['2 weeks', days(14)],
    ['month', months(1)], ['Monthly', months(1)], ['per month', months(1)], ['3 months', months(3)], ['6-month', months(6)], ['12 Months Membership', months(12)],
    ['year', months(12)], ['Yearly', months(12)], ['2 years', months(24)],
    // The names that used to fall through to 30 days.
    ['Annual', months(12)], ['annually', months(12)],
    ['Quarter', months(3)], ['Quarterly', months(3)], ['2 quarters', months(6)],
    ['Half year', months(6)], ['half-yearly', months(6)], ['Half a year', months(6)], ['Semi-annual', months(6)], ['semiannually', months(6)],
    ['Fortnight', days(14)], ['fortnightly', days(14)], ['Biweekly', days(14)], ['bi-weekly', days(14)],
    // Counts written as words; the count next to the unit, else the one the label opens with.
    ['Six Months', months(6)], ['twelve months', months(12)], ['two weeks', days(14)], ['3 x month', months(3)],
    // The first length named is the one meant.
    ['Monthly (30 days)', months(1)], ['3 months + 1 week free', months(3)], ['per year, billed monthly', months(12)]
  ];
  for (const [label, expected] of cases) assert.deepEqual(periodLength(label), expected, label);
});

test('a label that names no length, or could be read two ways, is not guessed at', () => {
  const unreadable = ['Lifetime', 'Custom', 'B2B Deal', '10 sessions', 'One-off', 'Weekend pass', 'Holiday pass', 'bi-monthly', 'Biannual', 'biennial', '1.5 months', '0 months', '2026 year plan', '', null, undefined];
  for (const label of unreadable) assert.equal(periodLength(label), null, String(label));
});

test('termEnd sells what the label says: an annual plan is a year, not 30 days', () => {
  const ends = (period) => termEnd(start, { period }).toISOString().slice(0, 10);
  assert.equal(ends('Annual'), '2027-01-31');
  assert.equal(ends('Quarterly'), '2026-04-30');
  assert.equal(ends('Half year'), '2026-07-31');
  assert.equal(ends('Fortnight'), '2026-02-14');
  assert.equal(ends('Six Months'), '2026-07-31');
  // A stored package whose label names nothing keeps the 30 days it always had.
  assert.equal(ends('Lifetime'), '2026-03-02');
  // No label at all is a month, as before.
  assert.equal(termEnd(start, {}).toISOString().slice(0, 10), '2026-02-28');
  // Validity in days, then a recurring interval, still win over any label.
  assert.equal(termEnd(start, { period: 'Annual', durationDays: 10 }).toISOString().slice(0, 10), '2026-02-10');
  assert.equal(termEnd(start, { period: 'Annual', billing: { mode: 'recurring', interval: 'month', intervalCount: 1 } }).toISOString().slice(0, 10), '2026-02-28');
});

test('a package is only saved when something says how long it lasts', () => {
  assert.equal(periodProblem({ period: 'Annual' }), null);
  assert.equal(periodProblem({ period: '3 months', billing: { mode: 'one_time' } }), null);
  // The label is not needed when the days or the billing interval say it.
  assert.equal(periodProblem({ period: 'Lifetime', durationDays: 3650 }), null);
  assert.equal(periodProblem({ period: 'Custom', billing: { mode: 'recurring', interval: 'month' } }), null);
  const problem = periodProblem({ period: ' Lifetime ', durationDays: 0, billing: { mode: 'one_time' } });
  assert.match(problem, /^The period "Lifetime" does not say how long this package lasts\./);
  assert.match(problem, /day, week, fortnight, month, quarter, half year or year/);
  assert.match(problem, /how many days it is valid for/);
  assert.match(periodProblem({ period: '10 sessions' }), /"10 sessions"/);
});
