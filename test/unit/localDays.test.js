// Day boundaries in the gym's own timezone, and list fields as multipart
// forms send them. Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const T = require('../../src/attendance/services/timeUtils');
const { parseList } = require('../../src/gymfolio/controller/gymClassController');

const gymIn = (timezone) => ({
  _id: '000000000000000000000002',
  slug: 'unit-gym-tz',
  database: { name: 'gympilot_unit_gym' },
  domains: [],
  locale: { timezone }
});

test('isDateOnly recognises a bare calendar date and nothing else', () => {
  assert.equal(T.isDateOnly('2026-09-30'), true);
  assert.equal(T.isDateOnly(' 2026-09-30 '), true);
  assert.equal(T.isDateOnly('2026-09-30T10:00:00Z'), false);
  assert.equal(T.isDateOnly(''), false);
  assert.equal(T.isDateOnly(null), false);
  assert.equal(T.isDateOnly(20260930), false);
});

test('the last moment of a local day is 23:59:59.999 at the gym, not at UTC', async () => {
  await runWithTenant(gymIn('Asia/Karachi'), async () => {
    // Karachi is UTC+5 all year: the day ends at 18:59:59.999Z.
    assert.equal(T.lastMomentOfLocalDay('2026-09-30').toISOString(), '2026-09-30T18:59:59.999Z');
    assert.equal(T.startOfLocalDay('2026-10-01').toISOString(), '2026-09-30T19:00:00.000Z');
  });
  await runWithTenant(gymIn('Europe/London'), async () => {
    // British Summer Time in September (UTC+1), GMT in December (UTC+0).
    assert.equal(T.lastMomentOfLocalDay('2026-09-30').toISOString(), '2026-09-30T22:59:59.999Z');
    assert.equal(T.lastMomentOfLocalDay('2026-12-31').toISOString(), '2026-12-31T23:59:59.999Z');
    assert.equal(T.startOfLocalDay('2026-09-30').toISOString(), '2026-09-29T23:00:00.000Z');
  });
  await runWithTenant(gymIn('America/New_York'), async () => {
    assert.equal(T.lastMomentOfLocalDay('2026-07-04').toISOString(), '2026-07-05T03:59:59.999Z');
  });
});

test('a coupon valid until a date still works late that evening at the gym', async () => {
  await runWithTenant(gymIn('Asia/Karachi'), async () => {
    const until = T.lastMomentOfLocalDay('2026-09-30');
    const lateEvening = new Date('2026-09-30T18:30:00Z'); // 23:30 in Karachi
    const nextMorning = new Date('2026-09-30T19:30:00Z'); // 00:30 on 1 Oct in Karachi
    assert.ok(lateEvening <= until, 'still valid at 23:30 local');
    assert.ok(nextMorning > until, 'expired after local midnight');
  });
});

test('list fields are read from arrays, JSON strings and comma strings without joining arrays', () => {
  assert.deepEqual(parseList(['a', ' b ', ''], []), ['a', 'b']);
  assert.deepEqual(parseList('["https://x/1.jpg","https://x/2.jpg"]', []), ['https://x/1.jpg', 'https://x/2.jpg']);
  assert.deepEqual(parseList('a, b,,c', []), ['a', 'b', 'c']);
  assert.deepEqual(parseList('[not json', []), ['[not json']);
  assert.deepEqual(parseList(undefined, ['kept']), ['kept']);
  assert.deepEqual(parseList(null, ['kept']), ['kept']);
  assert.deepEqual(parseList('', ['kept']), []);
  assert.deepEqual(parseList('[]', ['kept']), []);
});
