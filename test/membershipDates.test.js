// Membership dates: a month from the 31st lands on the last day of the next
// month, not in the month after it, and imported dates are whole days at the
// gym. Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../src/platform/tenantContext');
const { addMonths, termEnd } = require('../src/gymfolio/services/membershipService');
const { parseDate } = require('../src/controller/userImportController');

const gymIn = (timezone) => ({
  _id: '000000000000000000000003',
  slug: 'unit-gym-dates',
  database: { name: 'gympilot_unit_gym' },
  domains: [],
  locale: { timezone }
});

const inGym = (timezone, fn) => runWithTenant(gymIn(timezone), async () => fn());
const day = (date) => date.toISOString().slice(0, 10);

test('a month from the 31st is clamped to the last day of the next month', async () => {
  await inGym('UTC', () => {
    assert.equal(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString(), '2026-02-28T10:00:00.000Z');
    assert.equal(addMonths(new Date('2028-01-31T10:00:00Z'), 1).toISOString(), '2028-02-29T10:00:00.000Z');
    assert.equal(addMonths(new Date('2026-03-31T10:00:00Z'), 1).toISOString(), '2026-04-30T10:00:00.000Z');
    assert.equal(addMonths(new Date('2026-01-31T10:00:00Z'), 3).toISOString(), '2026-04-30T10:00:00.000Z');
    // Days every month has are left alone, and the year rolls over.
    assert.equal(addMonths(new Date('2026-01-15T10:00:00Z'), 1).toISOString(), '2026-02-15T10:00:00.000Z');
    assert.equal(addMonths(new Date('2026-11-30T10:00:00Z'), 2).toISOString(), '2027-01-30T10:00:00.000Z');
    // A year from 29 February is 28 February.
    assert.equal(addMonths(new Date('2028-02-29T10:00:00Z'), 12).toISOString(), '2029-02-28T10:00:00.000Z');
  });
});

test('months are counted on the gym calendar, not the UTC one', async () => {
  // 02:00 on 31 January in Karachi is still 30 January in UTC. A month
  // later is 28 February at 02:00 in Karachi -- not 1 March, which is what
  // clamping the UTC date (30 Jan -> 28 Feb 21:00Z) would have given.
  await inGym('Asia/Karachi', () => {
    assert.equal(addMonths(new Date('2026-01-30T21:00:00Z'), 1).toISOString(), '2026-02-27T21:00:00.000Z');
  });
  // Across a DST change the wall-clock time is kept: 09:00 in London in
  // March (GMT) is 09:00 in April (BST), an hour earlier in UTC.
  await inGym('Europe/London', () => {
    assert.equal(addMonths(new Date('2026-03-15T09:00:00Z'), 1).toISOString(), '2026-04-15T08:00:00.000Z');
  });
});

test('termEnd no longer rolls a monthly term into the month after', async () => {
  await inGym('UTC', () => {
    const start = new Date('2026-01-31T10:00:00Z');
    assert.equal(day(termEnd(start, { period: 'month' })), '2026-02-28');
    assert.equal(day(termEnd(start, { period: '3 months' })), '2026-04-30');
    assert.equal(day(termEnd(start, { period: 'year' })), '2027-01-31');
    assert.equal(day(termEnd(start, { billing: { mode: 'recurring', interval: 'month', intervalCount: 1 } })), '2026-02-28');
    assert.equal(day(termEnd(start, { billing: { mode: 'recurring', interval: 'month', intervalCount: 2 } })), '2026-03-31');
    // The day- and week-based terms are unchanged.
    assert.equal(day(termEnd(start, { period: 'week' })), '2026-02-07');
    assert.equal(day(termEnd(start, { period: 'month', durationDays: 10 })), '2026-02-10');
  });
});

test('imported dates are whole days at the gym, and an end date runs to the end of its day', async () => {
  await inGym('Asia/Karachi', () => {
    // Karachi is UTC+5: the 30th ends at 18:59:59.999Z, not at midnight UTC.
    assert.equal(parseDate('2026-09-30', 'end').toISOString(), '2026-09-30T18:59:59.999Z');
    assert.equal(parseDate('30/09/2026', 'end').toISOString(), '2026-09-30T18:59:59.999Z');
    assert.equal(parseDate('2026-09-30 00:00:00', 'end').toISOString(), '2026-09-30T18:59:59.999Z');
    assert.equal(parseDate('2026-09-01', 'start').toISOString(), '2026-08-31T19:00:00.000Z');
    // A birthday sits safely inside its day.
    assert.equal(parseDate('1990-05-14').toISOString(), '1990-05-14T07:00:00.000Z');
  });
  await inGym('America/New_York', () => {
    // Behind UTC: read as UTC midnight, the 30th would have ended on the 29th.
    assert.equal(parseDate('2026-09-30', 'end').toISOString(), '2026-10-01T03:59:59.999Z');
  });
});

test('imported timestamps keep their instant, and impossible dates are refused', async () => {
  await inGym('Asia/Karachi', () => {
    assert.equal(parseDate('2026-09-30T10:15:00Z', 'end').toISOString(), '2026-09-30T10:15:00.000Z');
    assert.equal(parseDate('2026-02-31', 'end'), null);
    assert.equal(parseDate('31/02/2026', 'end'), null);
    assert.equal(parseDate('not a date', 'end'), null);
    assert.equal(parseDate('', 'end'), null);
  });
});
