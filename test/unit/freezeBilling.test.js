// Where a freeze moves a Stripe subscription's next charge, and where
// resuming early moves it back. Pure date arithmetic; the Stripe calls that
// apply it are covered by test/integration/membershipFreeze.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../../src/gymfolio/services/membershipService');

const DAY = 86400;
const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('a freeze pushes the next charge back by exactly its days from the end of the paid period', () => {
  const periodEnd = new Date('2026-10-01T09:30:00Z');
  assert.equal(svc.freezeTrialEnd({ periodEnd, days: 10, seq: 0 }), sec('2026-10-11T09:30:00Z'));
  // A marker left by an earlier, finished freeze does not change the base.
  const old = { seq: 0, days: 5, trialEnd: sec('2026-09-01T00:00:00Z') };
  assert.equal(svc.freezeTrialEnd({ periodEnd, days: 10, seq: 1, marker: old }), sec('2026-10-11T09:30:00Z'));
});

test('a retried freeze that already reached Stripe starts from where that attempt started, never pushing twice', () => {
  // Attempt one pushed 1 Oct -> 11 Oct, then failed to save here. Stripe now
  // reports the pushed date as the period end.
  const marker = { seq: 2, days: 10, trialEnd: sec('2026-10-11T09:30:00Z') };
  const pushedPeriodEnd = new Date('2026-10-11T09:30:00Z');
  assert.equal(svc.freezeTrialEnd({ periodEnd: pushedPeriodEnd, days: 10, seq: 2, marker }), sec('2026-10-11T09:30:00Z'));
  // Retried with a different length: still measured from the original date.
  assert.equal(svc.freezeTrialEnd({ periodEnd: pushedPeriodEnd, days: 4, seq: 2, marker }), sec('2026-10-05T09:30:00Z'));
});

test('resuming early brings the charge back by the unused days, or bills now once the paid time has run out', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const pushedTo = sec('2026-10-11T09:30:00Z');
  assert.equal(svc.resumeTrialEnd({ pushedTo, unusedDays: 7, now }), pushedTo - 7 * DAY);
  assert.equal(svc.resumeTrialEnd({ pushedTo, unusedDays: 0, now }), pushedTo);
  // Froze an hour before the renewal, resumed straight away: nothing left.
  const nearly = sec('2026-09-21T12:03:00Z') + 3 * DAY;
  assert.equal(svc.resumeTrialEnd({ pushedTo: nearly, unusedDays: 3, now }), 'now');
  assert.equal(svc.resumeTrialEnd({ pushedTo: sec('2026-09-20T00:00:00Z') + 2 * DAY, unusedDays: 2, now }), 'now');
  // Comfortably ahead: a date, not 'now'.
  assert.equal(svc.resumeTrialEnd({ pushedTo: sec('2026-09-21T13:00:00Z') + DAY, unusedDays: 1, now }), sec('2026-09-21T13:00:00Z'));
});

test('the freeze marker is read back only when it is one this system wrote', () => {
  assert.deepEqual(svc.readFreezeMarker({ [svc.FREEZE_MARKER]: `3:10:${sec('2026-10-11T00:00:00Z')}` }), {
    seq: 3,
    days: 10,
    trialEnd: sec('2026-10-11T00:00:00Z')
  });
  for (const metadata of [null, undefined, {}, { [svc.FREEZE_MARKER]: '' }, { [svc.FREEZE_MARKER]: 'x:1:2' }, { [svc.FREEZE_MARKER]: '1:2' }]) {
    assert.equal(svc.readFreezeMarker(metadata), null, JSON.stringify(metadata));
  }
});

test('the freeze modes are distinct and named', () => {
  assert.equal(svc.FREEZE_STRIPE, 'stripe_trial');
  assert.equal(svc.FREEZE_LOCAL, 'local');
});
