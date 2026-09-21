// The daily job's two judgements, without a database: which memberships are
// going to renew themselves (and so must not be told "your membership ends --
// renew"), and whether a member's check-in puts them at the class they booked
// (so auto no-show marks them attended rather than absent). Plus the expiry
// email for a subscription the member has set not to renew.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { storage } = require('../../src/platform/tenantContext');
const { willAutoRenew, sessionWindow, visitCoversSession } = require('../../src/services/reminderJobs');
const t = require('../../src/templates/gymEmails');

// A London gym: GMT in January, BST in July.
const inLondon = (fn) => storage.run({ gym: { _id: 'london', slug: 'london', locale: { timezone: 'Europe/London' } } }, fn);
const at = (iso) => new Date(iso);

/* ---------------------------- auto-renewal ------------------------------ */

const subscription = (overrides = {}) => ({
  payment: { stripeSubscriptionId: 'sub_123', ...(overrides.payment || {}) },
  subscription: { autoRenew: true, cancelAtPeriodEnd: false, stripeStatus: 'active', ...(overrides.subscription || {}) }
});

test('a live Stripe subscription nobody has told to stop renews itself', () => {
  assert.equal(willAutoRenew(subscription()), true);
  assert.equal(willAutoRenew(subscription({ subscription: { stripeStatus: 'trialing' } })), true);
  // Not recorded yet (the webhook has not said): the order's own flags decide.
  assert.equal(willAutoRenew(subscription({ subscription: { stripeStatus: '' } })), true);
});

test('cancelled at period end, switched off, or ended at Stripe: it does not', () => {
  assert.equal(willAutoRenew(subscription({ subscription: { cancelAtPeriodEnd: true } })), false);
  assert.equal(willAutoRenew(subscription({ subscription: { autoRenew: false } })), false);
  for (const stripeStatus of ['canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused']) {
    assert.equal(willAutoRenew(subscription({ subscription: { stripeStatus } })), false, stripeStatus);
  }
});

test('a term paid once -- cash, bank transfer, a one-off card payment -- never renews itself', () => {
  assert.equal(willAutoRenew({ payment: { method: 'cash' }, subscription: { autoRenew: false } }), false);
  // A recurring package paid by transfer carries no subscription id.
  assert.equal(willAutoRenew({ payment: { stripeSubscriptionId: null }, subscription: { autoRenew: true } }), false);
  assert.equal(willAutoRenew({ payment: { stripeSubscriptionId: '' }, subscription: { autoRenew: true } }), false);
  assert.equal(willAutoRenew(null), false);
  assert.equal(willAutoRenew({}), false);
});

/* ------------------------------ attendance ------------------------------ */

test('a session runs from its local start to its local end, in the gym\'s zone', () =>
  inLondon(() => {
    const winter = sessionWindow({ sessionDate: '2026-01-14', sessionStart: '18:00', sessionEnd: '19:00' });
    assert.equal(winter.start.toISOString(), '2026-01-14T18:00:00.000Z');
    assert.equal(winter.end.toISOString(), '2026-01-14T19:00:00.000Z');

    const summer = sessionWindow({ sessionDate: '2026-07-14', sessionStart: '18:00', sessionEnd: '18:45' });
    assert.equal(summer.start.toISOString(), '2026-07-14T17:00:00.000Z', 'BST is an hour ahead');
    assert.equal(summer.end.toISOString(), '2026-07-14T17:45:00.000Z');
  }));

test('a session with no usable end time is taken to last an hour', () =>
  inLondon(() => {
    for (const sessionEnd of ['', undefined, '17:00', 'soon']) {
      const w = sessionWindow({ sessionDate: '2026-01-14', sessionStart: '18:00', sessionEnd });
      assert.equal(w.end.getTime() - w.start.getTime(), 60 * 60000, String(sessionEnd));
    }
  }));

test('checked in before the class and out after it: there', () =>
  inLondon(() => {
    const w = sessionWindow({ sessionDate: '2026-01-14', sessionStart: '18:00', sessionEnd: '19:00' });
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T17:50:00Z'), checkOutAt: at('2026-01-14T19:10:00Z') }, w), true);
    // Arrived mid-class, or left before the end: still turned up.
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T18:20:00Z'), checkOutAt: at('2026-01-14T19:30:00Z') }, w), true);
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T17:00:00Z'), checkOutAt: at('2026-01-14T18:30:00Z') }, w), true);
    // In all day.
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T07:00:00Z'), checkOutAt: at('2026-01-14T20:00:00Z') }, w), true);
  }));

test('a visit that ended before the class began, or began after it ended, is not the class', () =>
  inLondon(() => {
    const w = sessionWindow({ sessionDate: '2026-01-14', sessionStart: '18:00', sessionEnd: '19:00' });
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T07:00:00Z'), checkOutAt: at('2026-01-14T08:30:00Z') }, w), false);
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T16:30:00Z'), checkOutAt: at('2026-01-14T17:55:00Z') }, w), false);
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T19:05:00Z'), checkOutAt: at('2026-01-14T20:00:00Z') }, w), false);
    assert.equal(visitCoversSession({ checkInAt: null }, w), false);
    assert.equal(visitCoversSession(null, w), false);
  }));

test('never checked out: the check-in has to fall shortly before the class or during it', () =>
  inLondon(() => {
    const w = sessionWindow({ sessionDate: '2026-01-14', sessionStart: '18:00', sessionEnd: '19:00' });
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T17:45:00Z'), checkOutAt: null }, w), true);
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T16:00:00Z') }, w), true, 'two hours early still counts');
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T18:40:00Z') }, w), true);
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T09:00:00Z') }, w), false, 'the morning visit is not the evening class');
    assert.equal(visitCoversSession({ checkInAt: at('2026-01-14T19:30:00Z') }, w), false);
  }));

/* ------------------------------- the email ------------------------------ */

test('the expiry email offers a renewal -- or, for a subscription set not to renew, switching it back on', () => {
  const plain = t.membershipExpiring({ firstName: 'Sam', packageName: 'Monthly', endDate: '2026-10-01', daysLeft: 7, siteName: 'Iron Works', renewUrl: 'https://iron.test/packages' });
  assert.match(plain.subject, /ends in 7 days/);
  assert.match(plain.html, /Renew my membership/);
  assert.match(plain.html, /iron\.test\/packages/);
  assert.doesNotMatch(plain.html, /Keep renewing/);

  const resumable = t.membershipExpiring({ firstName: 'Sam', packageName: 'Monthly', endDate: '2026-10-01', daysLeft: 1, siteName: 'Iron Works', renewUrl: 'https://iron.test/user-detail?tab=history', resumable: true });
  assert.match(resumable.subject, /ends tomorrow/);
  assert.match(resumable.html, /set not to renew/);
  assert.match(resumable.html, /Keep renewing/);
  assert.match(resumable.html, /user-detail\?tab=history/);
  assert.doesNotMatch(resumable.html, /Renew my membership/);
});
