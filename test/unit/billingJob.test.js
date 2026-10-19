// The daily billing job's pure parts (services/billing/billingJob.js and
// billingMessages.js): which milestone a day calls for -- on the gym's
// calendar, catching up a missed run without sending a stale message, and
// nothing after the last day -- that a notice is claimed once, whether the
// job runs at all, and what the messages say. No database: the one model
// call is replaced.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithTenant } = require('../../src/platform/tenantContext');
const T = require('../../src/attendance/services/timeUtils');
const job = require('../../src/services/billing/billingJob');
const due = require('../../src/services/billing/dueRenewals');
const { billingSettings } = require('../../src/services/billing/settings');
const { periodLabel, amountLabel, cardLabel } = require('../../src/services/billing/billingMessages');
const { billingEmail } = require('../../src/templates/billingEmails');
const templates = require('../../src/services/templateService');

const karachi = { _id: '000000000000000000000001', slug: 'k', locale: { timezone: 'Asia/Karachi' }, database: { name: 'gympilot_unit_k' } };
const london = { _id: '000000000000000000000002', slug: 'l', locale: { timezone: 'Europe/London' }, database: { name: 'gympilot_unit_l' } };

const defaults = billingSettings({});

test('the milestones: N days before, the due day, the last day -- in date order', () => {
  const list = job.milestonesFor('2026-11-19', '2026-11-22', billingSettings({ billing: { reminderDaysBefore: [7, 3] } }));
  assert.deepEqual(list.map((m) => [m.key, m.kind, m.date]), [
    ['before7', 'before', '2026-11-12'],
    ['before3', 'before', '2026-11-16'],
    ['due', 'due', '2026-11-19'],
    ['last', 'last', '2026-11-22']
  ]);
  // No last-day message when the last day is the due day (lastDayAfterDue 0),
  // and none for the due day when it is switched off.
  const lean = job.milestonesFor('2026-11-19', '2026-11-19', billingSettings({ billing: { reminderDaysBefore: [3], dueDayReminder: false, lastDayAfterDue: 0 } }));
  assert.deepEqual(lean.map((m) => m.key), ['before3']);
  // Across a month end.
  assert.equal(job.milestonesFor('2026-03-02', '2026-03-05', defaults)[0].date, '2026-02-27');
});

test('the day decides: the latest milestone reached; a missed run catches up with that one only; nothing after the last day', () => {
  const list = job.milestonesFor('2026-11-19', '2026-11-22', billingSettings({ billing: { reminderDaysBefore: [7, 3] } }));
  const on = (day) => (job.currentMilestone(list, day, '2026-11-22') || {}).key || null;
  assert.equal(on('2026-11-11'), null, 'before the first');
  assert.equal(on('2026-11-12'), 'before7');
  assert.equal(on('2026-11-14'), 'before7', 'still the 7-day one (sent once, by the notices)');
  assert.equal(on('2026-11-16'), 'before3');
  assert.equal(on('2026-11-18'), 'before3');
  assert.equal(on('2026-11-19'), 'due');
  assert.equal(on('2026-11-21'), 'due', 'a missed due day is caught up -- the last day has not come');
  assert.equal(on('2026-11-22'), 'last');
  assert.equal(on('2026-11-23'), null, 'after the last day: stop');
  // A "0 days before" and the due-day message on the same day: the due day counts.
  const both = job.milestonesFor('2026-11-19', '2026-11-22', billingSettings({ billing: { reminderDaysBefore: [0] } }));
  assert.equal(job.currentMilestone(both, '2026-11-19', '2026-11-22').key, 'due');
  const zeroOnly = job.milestonesFor('2026-11-19', '2026-11-22', billingSettings({ billing: { reminderDaysBefore: [0], dueDayReminder: false } }));
  assert.equal(job.currentMilestone(zeroOnly, '2026-11-19', '2026-11-22').kind, 'due', 'read as the due day');
});

test('the due date is the day the term ends on the gym\'s calendar, not the server\'s', async () => {
  // 20:30 UTC on 18 Nov is already 19 Nov in Karachi (UTC+5), still 18 Nov in London.
  const end = new Date('2026-11-18T20:30:00Z');
  const k = await runWithTenant(karachi, () => due.datesFor(end, defaults));
  const l = await runWithTenant(london, () => due.datesFor(end, defaults));
  assert.deepEqual(k, { dueDate: '2026-11-19', lastDay: '2026-11-22' });
  assert.deepEqual(l, { dueDate: '2026-11-18', lastDay: '2026-11-21' });
  // And "today" for the job is the gym's too.
  const now = new Date('2026-11-18T20:30:00Z');
  assert.equal(await runWithTenant(karachi, () => T.dateKey(now)), '2026-11-19');
  assert.equal(due.linkLastDay('2026-11-22'), '2026-11-29');
});

test('a notice is claimed once: the second claim on the same reading loses', async () => {
  // The order model's one call, answered as the database answers a
  // conditional update.
  let stored = '';
  const filters = [];
  const Model = {
    async updateOne(filter, update) {
      filters.push(filter);
      const wanted = filter['metadata.billingNotices'];
      if (!(typeof wanted === 'string' ? stored === wanted : stored === '')) return { modifiedCount: 0 };
      stored = update.$set['metadata.billingNotices'];
      return { modifiedCount: 1 };
    }
  };
  const order = () => ({ _id: 'o1', metadata: new Map() });
  const a = order();
  const b = order();
  assert.equal(await job.claimNotices(a, ['before3@2026-11-19'], Model), '');
  assert.equal(await job.claimNotices(b, ['before3@2026-11-19'], Model), null, 'the other run read the same, and loses');
  assert.equal(stored, 'before3@2026-11-19');
  assert.equal(a.metadata.get('billingNotices'), 'before3@2026-11-19');
  assert.equal(await job.claimNotices(a, ['due@2026-11-19', 'before3@2026-11-19'], Model), 'before3@2026-11-19');
  assert.equal(stored, 'before3@2026-11-19,due@2026-11-19', 'no repeats');
  assert.ok(filters.every((filter) => filter.status === 'pending'), 'only an open order is claimed');
});

test('the job runs only for a gym that can be paid and has something switched on', () => {
  const safepay = { id: 'safepay', capabilities: { checkout: true, autoCharge: true }, createCheckout() {}, chargeSavedMethod() {} };
  const generic = { id: 'generic', capabilities: { checkout: false, autoCharge: false } };
  const on = billingSettings({ billing: { autoCharge: { enabled: true } } });
  assert.deepEqual(job.billingState({ billing: on, provider: safepay, banks: [] }), { enabled: true, remindersOn: true, autoChargeOn: true });
  assert.equal(job.billingState({ billing: on, provider: generic, banks: [{}] }).autoChargeOn, false, 'a gateway that cannot charge never does');
  assert.equal(job.billingState({ billing: defaults, provider: safepay, banks: [] }).autoChargeOn, false, 'the gym has not switched it on');
  assert.equal(job.billingState({ billing: defaults, provider: null, banks: [{}] }).enabled, true, 'bank details are enough');
  assert.match(job.billingState({ billing: defaults, provider: null, banks: [] }).reason, /nothing a member could pay with/);
  const silent = billingSettings({ billing: { sendVia: { email: false, sms: false, whatsapp: false, push: false } } });
  assert.match(job.billingState({ billing: silent, provider: null, banks: [{}] }).reason, /switched off/);
  assert.equal(job.billingState({ billing: { ...silent, autoCharge: { enabled: true } }, provider: safepay, banks: [] }).enabled, true, 'charging alone still runs');
});

test('the period, amount and card read as a member says them', () => {
  assert.equal(periodLabel({ period: 'month' }), '1 month');
  assert.equal(periodLabel({ period: '3 months' }), '3 months');
  assert.equal(periodLabel({ period: 'year' }), '1 year');
  assert.equal(periodLabel({ period: 'fortnight' }), '2 weeks');
  assert.equal(periodLabel({ period: 'month', durationDays: 45 }), '45 days');
  assert.equal(periodLabel({ period: 'x', billing: { mode: 'recurring', interval: 'week', intervalCount: 1 } }), '1 week');
  assert.equal(periodLabel({ period: 'Lifetime' }), 'Lifetime');
  assert.equal(amountLabel(5000), '5,000');
  assert.equal(amountLabel(49.5), '49.50');
  assert.equal(cardLabel({ brand: 'Visa', last4: '4242' }), 'Visa •••• 4242');
});

test('the emails lead with the gym, carry the package, dates, link and bank details, and escape what people typed', () => {
  const v = {
    siteName: 'Iron <Gym>',
    firstName: '<b>Ann</b>',
    packageName: 'Monthly',
    period: '1 month',
    amount: '5,000',
    currency: 'PKR',
    dueDate: '19 Nov 2026',
    lastDay: '22 Nov 2026',
    orderNumber: 'PKG1',
    payUrl: 'https://iron.example/pay/GPP1.x',
    onlineLabel: 'Card, JazzCash, Easypaisa or any bank app',
    banks: [{ name: 'Meezan', accountTitle: 'Iron', accountNumber: '01', iban: 'PK36' }]
  };
  const before = billingEmail('before', v);
  assert.equal(before.subject, 'Iron <Gym>: your membership expires on 19 Nov 2026');
  for (const part of ['Iron &lt;Gym&gt;', '1 month', 'PKR 5,000', '19 Nov 2026', '22 Nov 2026', 'https://iron.example/pay/GPP1.x', 'Pay now', 'Meezan', 'PK36', 'Sent with GymsPilotPro']) {
    assert.ok(before.html.includes(part), part);
  }
  assert.ok(!before.html.includes('<b>Ann</b>'), 'a name is text, not markup');
  assert.match(billingEmail('declined', { ...v, reason: 'Your card was declined.' }).html, /Your card was declined\. Your membership is not paid yet/);
  assert.equal(billingEmail('last', v).subject, 'Iron <Gym>: today is the last day to pay your renewal');
  assert.equal(billingEmail('due', v).subject, 'Iron <Gym>: your membership expires today');
  assert.equal(billingEmail('link', v).subject, 'Iron <Gym>: your payment link');
  const bankOnly = billingEmail('due', { ...v, onlineLabel: null });
  assert.match(bankOnly.html, /Pay by bank transfer/);
  assert.doesNotMatch(bankOnly.html, /Pay now|Pay online/);
  const autoPay = billingEmail('before', { ...v, autoPayCard: 'Visa •••• 4242' });
  assert.match(autoPay.html, /we will charge your saved card Visa •••• 4242 on the due date/);
});

test('the short texts are registered for the gym to reword, and fill in every detail', () => {
  for (const key of ['payment_due_soon', 'payment_due_today', 'payment_card_declined', 'payment_last_day', 'payment_link']) {
    assert.ok(templates.isEvent(key), key);
    const event = templates.EVENTS.find((e) => e.key === key);
    assert.equal(event.group, 'Payments');
    const text = templates.fill(event.text, templates.sampleVars('Iron Gym', 'https://iron.example'));
    for (const part of ['Iron Gym', 'Monthly Unlimited', '1 month', 'USD 49.00', 'https://iron.example/pay/GPP1.example', 'Raast']) assert.ok(text.includes(part), `${key}: ${part}`);
    assert.doesNotMatch(text, /\{\{/);
  }
});
