// The reminders a gym's owner gets to pay GymsPilotPro, as plain functions:
// the milestones of a due date, which one today calls for (the latest
// reached, none after the last), and what each email says for each way of
// paying. No database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../src/platform/services/ownerPayReminders');

const defaults = { daysBefore: [3], onDueDay: true, lastDayAfterDue: 3 };

test('a due date has its days-before, due-day and last-day milestones, in date order', () => {
  assert.deepEqual(R.milestonesFor('2026-11-19', defaults), [
    { key: 'before3', kind: 'before', date: '2026-11-16' },
    { key: 'due', kind: 'due', date: '2026-11-19' },
    { key: 'last', kind: 'last', date: '2026-11-22' }
  ]);
  // Several days before, across a month end; 0 days before is the due day, once.
  assert.deepEqual(
    R.milestonesFor('2026-12-02', { daysBefore: [1, 7, 0], onDueDay: true, lastDayAfterDue: 0 }).map((m) => `${m.key}:${m.date}`),
    ['before7:2026-11-25', 'before1:2026-12-01', 'due:2026-12-02']
  );
  assert.deepEqual(R.milestonesFor('2026-11-19', { daysBefore: [], onDueDay: false, lastDayAfterDue: 0 }), []);
});

test('today calls for the latest milestone reached, and nothing before the first or after the last', () => {
  const list = R.milestonesFor('2026-11-19', { daysBefore: [7, 3], onDueDay: true, lastDayAfterDue: 3 });
  assert.equal(R.currentMilestone(list, '2026-11-11'), null);
  assert.equal(R.currentMilestone(list, '2026-11-12').key, 'before7');
  // The job missed the 7-days-before day: on the 3-days-before day only that one is due.
  assert.equal(R.currentMilestone(list, '2026-11-16').key, 'before3');
  assert.equal(R.currentMilestone(list, '2026-11-18').key, 'before3');
  assert.equal(R.currentMilestone(list, '2026-11-19').key, 'due');
  assert.equal(R.currentMilestone(list, '2026-11-22').key, 'last');
  assert.equal(R.currentMilestone(list, '2026-11-23'), null);
  assert.equal(R.currentMilestone([], '2026-11-19'), null);
});

test('the reminders read from the settings, with the defaults an unset field means', () => {
  assert.deepEqual(R.remindersOf({}), defaults);
  assert.deepEqual(R.remindersOf({ billingReminders: { daysBefore: [5, 40, 1.5], onDueDay: false, lastDayAfterDue: 0 } }), { daysBefore: [5], onDueDay: false, lastDayAfterDue: 0 });
  assert.equal(R.dayKey(new Date('2026-11-19T23:30:00Z')), '2026-11-19');
  assert.equal(R.shiftKey('2026-03-01', -1), '2026-02-28');
});

const gym = {
  name: 'Iron Works',
  slug: 'iron-works',
  domains: [{ host: 'ironworks.com', isPrimary: true }],
  owner: { firstName: 'Ali', email: 'ali@iron.test' },
  subscription: { amount: 8000, currency: 'PKR', currentPeriodEnd: new Date('2026-11-19T00:00:00Z') }
};
const email = (provider, milestone = { key: 'before3', kind: 'before' }, today = '2026-11-16', extra = {}) =>
  R.reminderEmail({ gym, planName: 'Growth', milestone, dueDate: '2026-11-19', today, provider, ...extra });

test('each email says the plan, the amount, the due date and how to pay, and links to the Billing tab', () => {
  const safepay = email('safepay');
  assert.equal(safepay.subject, 'Iron Works: your GymsPilotPro payment is due in 3 days');
  for (const part of ['Growth', 'PKR 8,000', 'JazzCash', 'Pay now', 'https://ironworks.com/admin/settings?tab=billing']) assert.match(safepay.html, new RegExp(part.replace(/[?.]/g, '\\$&')));

  const bank = email('generic', undefined, undefined, { accounts: [{ bankName: 'Meezan Bank', accountTitle: 'GymsPilotPro', accountNumber: '0101', iban: 'PK36MEZN0001010123456702' }] });
  for (const part of ['Meezan Bank', 'PK36MEZN0001010123456702', 'Upload receipt']) assert.match(bank.html, new RegExp(part));
  assert.doesNotMatch(bank.html, /Pay now/);

  const none = email('none', undefined, undefined, { contactEmail: 'billing@gymspilotpro.com' });
  assert.match(none.html, /contact billing@gymspilotpro\.com/);
  assert.match(email('stripe').html, /by card/);

  assert.equal(email('safepay', { key: 'before1', kind: 'before' }, '2026-11-18').subject, 'Iron Works: your GymsPilotPro payment is due tomorrow');
  assert.equal(email('safepay', { key: 'due', kind: 'due' }, '2026-11-19').subject, 'Iron Works: your GymsPilotPro payment is due today');
  const last = email('generic', { key: 'last', kind: 'last' }, '2026-11-22', { cutOff: '26 Nov 2026', accounts: [] });
  assert.equal(last.subject, "Last reminder: Iron Works's GymsPilotPro payment is overdue");
  assert.match(last.html, /not paid by 26 Nov 2026/);
});
