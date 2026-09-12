// Platform billing rules: which owner notice is due, what a gym is entitled
// to, how a subscription period is derived, and how Stripe's payloads are
// read. Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { noticesDue } = require('../../src/platform/billingNotices');
const { hasAddon } = require('../../src/platform/entitlements');
const { subscriptionFor } = require('../../src/platform/provisioning');
const { periodEndOf, subscriptionIdOfInvoice, amountOf, STATUS_MAP } = require('../../src/platform/services/platformWebhook');
const { fromMinorUnits, intervalFor } = require('../../src/platform/services/platformBilling');

const DAY = 86400000;
const now = new Date('2026-09-12T09:00:00Z');
const inDays = (n) => new Date(now.getTime() + n * DAY);

test('trial notices go out at 7, 3 and 1 days, each once', () => {
  assert.deepEqual(noticesDue({ status: 'trialing', currentPeriodEnd: inDays(10) }, now).send, null);
  assert.equal(noticesDue({ status: 'trialing', currentPeriodEnd: inDays(7) }, now).send, 'trial7');
  assert.equal(noticesDue({ status: 'trialing', currentPeriodEnd: inDays(6), notices: { trial7: now } }, now).send, null);
  assert.equal(noticesDue({ status: 'trialing', currentPeriodEnd: inDays(3), notices: { trial7: now } }, now).send, 'trial3');
  assert.equal(noticesDue({ status: 'trialing', currentPeriodEnd: inDays(1), notices: { trial7: now, trial3: now } }, now).send, 'trial1');
  assert.equal(noticesDue({ status: 'trialing', currentPeriodEnd: inDays(0.5), notices: { trial7: now, trial3: now, trial1: now } }, now).send, null);
});

test('when several trial notices are due at once only the most urgent is sent and the rest are marked', () => {
  const due = noticesDue({ status: 'trialing', currentPeriodEnd: inDays(2) }, now);
  assert.equal(due.send, 'trial3');
  assert.deepEqual(due.mark, ['trial3', 'trial7']);
  assert.equal(due.daysLeft, 2);
});

test('a trial that has already ended is marked, not emailed -- the roll-over owns it', () => {
  const due = noticesDue({ status: 'trialing', currentPeriodEnd: inDays(-2) }, now);
  assert.equal(due.send, null);
  assert.deepEqual(due.mark, ['trial1', 'trial3', 'trial7']);
});

test('past due and expired are told once each; active gyms hear nothing', () => {
  assert.equal(noticesDue({ status: 'past_due', currentPeriodEnd: inDays(-1) }, now).send, 'pastDue');
  assert.equal(noticesDue({ status: 'past_due', currentPeriodEnd: inDays(-1), notices: { pastDue: now } }, now).send, null);
  assert.equal(noticesDue({ status: 'expired', currentPeriodEnd: inDays(-9) }, now).send, 'expired');
  assert.equal(noticesDue({ status: 'expired', notices: { expired: now } }, now).send, null);
  assert.equal(noticesDue({ status: 'active', currentPeriodEnd: inDays(1) }, now).send, null);
  assert.equal(noticesDue({ status: 'trialing', currentPeriodEnd: null }, now).send, null);
  assert.equal(noticesDue(null, now).send, null);
});

test('a gym has an add-on when it has no plan, when the plan includes it, or when it bought it', () => {
  assert.equal(hasAddon(null, { addons: [] }, 'member-app'), true);
  assert.equal(hasAddon({ includedAddons: ['member-app'] }, { addons: [] }, 'member-app'), true);
  assert.equal(hasAddon({ includedAddons: [] }, { addons: [{ slug: 'member-app', amount: 1500 }] }, 'Member-App'), true);
  assert.equal(hasAddon({ includedAddons: [] }, { addons: [] }, 'member-app'), false);
  assert.equal(hasAddon({ includedAddons: ['member-app'] }, null, ''), false);
});

test('a plan with no trial days is due now, not never', () => {
  const plan = { price: { monthly: 100, yearly: 1000, currency: 'USD' }, trialDays: 0, includedAddons: [] };
  const before = Date.now();
  const sub = subscriptionFor(plan, {}, []);
  assert.equal(sub.status, 'trialing');
  assert.ok(sub.currentPeriodEnd instanceof Date);
  assert.ok(sub.currentPeriodEnd.getTime() >= before && sub.currentPeriodEnd.getTime() <= Date.now() + 1000);

  const trial = subscriptionFor({ ...plan, trialDays: 14 }, {}, []);
  assert.ok(Math.abs(trial.currentPeriodEnd.getTime() - (Date.now() + 14 * DAY)) < 5000);

  // No plan: nothing to bill, unless somebody says it is on trial.
  assert.equal(subscriptionFor(null, {}, []).currentPeriodEnd, null);
  assert.ok(subscriptionFor(null, { status: 'trialing' }, []).currentPeriodEnd instanceof Date);
});

test('only add-ons in the plan currency are put on the subscription; included ones are free whatever they cost', () => {
  const plan = { price: { monthly: 100, yearly: 1000, currency: 'USD' }, trialDays: 14, includedAddons: ['reports'] };
  const addons = [
    { slug: 'member-app', name: 'Member app', price: { monthly: 10, yearly: 100, currency: 'USD' } },
    { slug: 'whatsapp', name: 'WhatsApp', price: { monthly: 1500, yearly: 15000, currency: 'PKR' } },
    { slug: 'reports', name: 'Reports', price: { monthly: 2000, yearly: 20000, currency: 'PKR' } }
  ];
  const sub = subscriptionFor(plan, { billingCycle: 'yearly' }, addons);
  assert.deepEqual(sub.addons.map((a) => a.slug), ['member-app', 'reports']);
  assert.equal(sub.planAmount, 1000);
  assert.equal(sub.amount, 1100);
  assert.equal(sub.currency, 'USD');
});

test('the period end is read from wherever the Stripe API version put it', () => {
  assert.equal(periodEndOf({ current_period_end: 1800000000 }).getTime(), 1800000000000);
  assert.equal(periodEndOf({ items: { data: [{ current_period_end: 1800000000 }, { current_period_end: 1800086400 }] } }).getTime(), 1800086400000);
  assert.equal(periodEndOf({ items: { data: [] } }), null);
  assert.equal(periodEndOf(null), null);
});

test('an invoice names its subscription directly or under parent.subscription_details', () => {
  assert.equal(subscriptionIdOfInvoice({ subscription: 'sub_1' }), 'sub_1');
  assert.equal(subscriptionIdOfInvoice({ subscription: { id: 'sub_2' } }), 'sub_2');
  assert.equal(subscriptionIdOfInvoice({ parent: { subscription_details: { subscription: 'sub_3' } } }), 'sub_3');
  assert.equal(subscriptionIdOfInvoice({}), '');
});

test('what a subscription charges is the sum of its items, back in major units', () => {
  const priced = amountOf({
    items: {
      data: [
        { quantity: 1, price: { unit_amount: 890000, currency: 'pkr', recurring: { interval: 'month' } } },
        { quantity: 1, price: { unit_amount: 150000, currency: 'pkr', recurring: { interval: 'month' } } }
      ]
    }
  });
  assert.deepEqual(priced, { amount: 10400, currency: 'PKR', interval: 'month' });
  assert.equal(fromMinorUnits(1500, 'JPY'), 1500);
  assert.equal(fromMinorUnits(1234, 'usd'), 12.34);
  assert.equal(intervalFor('yearly'), 'year');
  assert.equal(intervalFor('monthly'), 'month');
});

test("Stripe's subscription statuses map onto the platform's", () => {
  assert.equal(STATUS_MAP.trialing, 'trialing');
  assert.equal(STATUS_MAP.active, 'active');
  assert.equal(STATUS_MAP.past_due, 'past_due');
  assert.equal(STATUS_MAP.unpaid, 'past_due');
  assert.equal(STATUS_MAP.canceled, 'cancelled');
  assert.equal(STATUS_MAP.incomplete, undefined);
});
