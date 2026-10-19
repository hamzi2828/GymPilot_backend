// src/platform/services/ownerPayReminders.js
//
// The emails a gym's owner gets about paying GymsPilotPro: `daysBefore` days
// before the due date (subscription.currentPeriodEnd), on it (`onDueDay`),
// and `lastDayAfterDue` days after it -- System → Payments → "Reminders to
// gym owners" (platform_settings.billingReminders). Part of the daily job,
// as a platform pass after the gyms (index.js /api/jobs/reminders).
//
// Each milestone goes once per period: it is recorded on the gym
// (subscription.payReminders, "<milestone>@<due date>") before the email
// goes, so two runs side by side cannot both send it, and given back when
// the email could not be sent, for the next run. A milestone the job missed
// is not sent late once a later one is reached, and after the last day
// nothing more is sent -- the roll-over and the lifecycle emails
// (jobs.sendOwnerBillingNotices) take it from there.
//
// For gyms paying by hand or through GymsPilotPro's Safepay or bank
// accounts: not a gym Stripe bills (Stripe charges it itself), not a trial
// (the trial emails say it), not a free one. With no platform email
// (SMTP_*) the pass is skipped: { skipped: 'no platform email' }.

const Gym = require('../models/gymModel');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformSettings = require('../models/platformSettingsModel');
const gateways = require('./payments');
const { activeAccounts } = require('./platformBankAccounts');
const { platformEmailConfigured } = require('./platformEmail');
const { siteUrlFor } = require('../tenantContext');
// Called through the module, so the stand-in a test installs is the one used.
const emailService = require('../../services/emailService');
const { shell, paragraph, button, detailTable, callout, dateLabel, escapeHtml } = require('../../templates/gymEmails');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';
const DAY_MS = 86400000;

/** 'YYYY-MM-DD' of a moment, in UTC: the day a due date names everywhere (pay.due_date). */
function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function shiftKey(key, days) {
  const anchor = new Date(`${key}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return dayKey(anchor);
}

function daysBetween(fromKey, toKey) {
  return Math.round((new Date(`${toKey}T12:00:00Z`) - new Date(`${fromKey}T12:00:00Z`)) / DAY_MS);
}

/** The reminders as stored, with the defaults an unset field means. */
function remindersOf(settings) {
  const r = (settings && settings.billingReminders) || {};
  return {
    daysBefore: Array.isArray(r.daysBefore) ? r.daysBefore.filter((d) => Number.isInteger(d) && d >= 0 && d <= 30) : [3],
    onDueDay: r.onDueDay !== undefined && r.onDueDay !== null ? !!r.onDueDay : true,
    lastDayAfterDue: Number.isInteger(r.lastDayAfterDue) ? r.lastDayAfterDue : 3
  };
}

/**
 * The milestones of one due date, in date order: 'before<N>' for each of
 * daysBefore (0 days before is the due day), 'due', and 'last'.
 * @returns {{ key, kind: 'before'|'due'|'last', date }[]}
 */
function milestonesFor(dueDate, reminders) {
  const list = [];
  const add = (milestone) => {
    if (!list.some((m) => m.key === milestone.key)) list.push(milestone);
  };
  for (const days of [...reminders.daysBefore].sort((a, b) => b - a)) {
    add(days === 0 ? { key: 'due', kind: 'due', date: dueDate } : { key: `before${days}`, kind: 'before', date: shiftKey(dueDate, -days) });
  }
  if (reminders.onDueDay) add({ key: 'due', kind: 'due', date: dueDate });
  if (reminders.lastDayAfterDue > 0) add({ key: 'last', kind: 'last', date: shiftKey(dueDate, reminders.lastDayAfterDue) });
  return list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The milestone today calls for: the latest one reached, none after the last one's day. */
function currentMilestone(milestones, today) {
  if (!milestones.length) return null;
  if (today > milestones[milestones.length - 1].date) return null;
  let current = null;
  for (const m of milestones) if (m.date <= today) current = m;
  return current;
}

function money(amount, currency) {
  return `${String(currency || '').toUpperCase()} ${Number(amount || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/**
 * The email for one milestone: plan, amount, due date and how to pay --
 * "Pay now" (Safepay, Stripe), GymsPilotPro's bank accounts (bank
 * transfer), or whom to contact (none) -- linking to the gym's Billing tab.
 */
function reminderEmail({ gym, planName, milestone, dueDate, today, provider, accounts = [], contactEmail = '', cutOff = '' }) {
  const sub = gym.subscription || {};
  const firstName = (gym.owner && gym.owner.firstName) || 'there';
  const link = `${String(siteUrlFor(gym) || '').replace(/\/+$/, '')}/admin/settings?tab=billing`;
  const left = daysBetween(today, dueDate);
  const dueLabel = dateLabel(new Date(`${dueDate}T00:00:00Z`)) || dueDate;
  const when = left <= 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;

  const opening =
    milestone.kind === 'last'
      ? `Hi ${escapeHtml(firstName)}, the ${PLATFORM_NAME} payment for ${escapeHtml(gym.name)} was due on ${escapeHtml(dueLabel)} and has not reached us yet.`
      : `Hi ${escapeHtml(firstName)}, the ${PLATFORM_NAME} payment for ${escapeHtml(gym.name)} is due ${escapeHtml(when)}${left > 1 ? `, on ${escapeHtml(dueLabel)}` : ''}.`;
  const details = detailTable([
    ...(planName ? [['Plan', planName]] : []),
    ['Amount', money(sub.amount, sub.currency)],
    ['Due date', dueLabel]
  ]);

  const howToPay = [];
  if (provider === 'safepay') {
    howToPay.push(paragraph('Pay online by card, JazzCash, Easypaisa or any bank app.'), button(link, 'Pay now'));
  } else if (provider === 'stripe') {
    howToPay.push(paragraph('Pay online by card.'), button(link, 'Pay now'));
  } else if (provider === 'generic' && accounts.length) {
    howToPay.push(paragraph(`Pay by bank transfer to ${accounts.length === 1 ? 'this account' : 'one of these accounts'}:`));
    for (const account of accounts) {
      howToPay.push(
        detailTable([
          ['Bank', account.bankName],
          ['Account title', account.accountTitle],
          ...(account.accountNumber ? [['Account number', account.accountNumber]] : []),
          ...(account.iban ? [['IBAN', account.iban]] : [])
        ])
      );
    }
    howToPay.push(paragraph('Then upload the receipt on your Billing page.'), button(link, 'Upload receipt'));
  } else {
    howToPay.push(paragraph(`To pay, contact ${escapeHtml(contactEmail || PLATFORM_NAME)}.`), button(link, 'View billing'));
  }

  const body = [
    paragraph(opening),
    details,
    ...howToPay,
    ...(milestone.kind === 'last' && cutOff ? [callout(`If it is not paid by ${escapeHtml(cutOff)}, ${escapeHtml(gym.name)}'s website, member app and admin stop being served.`, 'bad')] : [])
  ].join('');

  const subject =
    milestone.kind === 'last'
      ? `Last reminder: ${gym.name}'s ${PLATFORM_NAME} payment is overdue`
      : `${gym.name}: your ${PLATFORM_NAME} payment is due ${when}`;
  return { subject, html: shell(PLATFORM_NAME, milestone.kind === 'last' ? 'Payment overdue' : 'Payment due', body) };
}

/** Records `marker` as sent -- only if no other run has. */
async function claim(gym, marker, dueDate) {
  const kept = ((gym.subscription && gym.subscription.payReminders) || []).filter((key) => key.endsWith(`@${dueDate}`));
  const result = await Gym.updateOne({ _id: gym._id, 'subscription.payReminders': { $ne: marker } }, { $set: { 'subscription.payReminders': [...kept, marker] } });
  return result.modifiedCount === 1;
}

function release(gym, marker) {
  return Gym.updateOne({ _id: gym._id }, { $pull: { 'subscription.payReminders': marker } }).catch(() => {});
}

/**
 * The pass. With dryRun nothing is sent or recorded; the answer lists what
 * would be.
 *
 * @returns {Promise<{ sent, covered, errors, not_due, dry_run } | { skipped: string }>}
 */
async function sendOwnerPayReminders({ dryRun = false, now = new Date() } = {}) {
  if (!platformEmailConfigured()) return { skipped: 'no platform email' };
  const settings = await PlatformSettings.getSettings();
  const reminders = remindersOf(settings);
  if (!reminders.daysBefore.length && !reminders.onDueDay && !(reminders.lastDayAfterDue > 0)) return { skipped: 'reminders switched off' };

  const today = dayKey(now);
  const earliest = Math.max(0, ...reminders.daysBefore);
  // Due dates whose milestones can fall today: up to `earliest` days ahead,
  // up to the last day behind.
  const from = new Date(`${shiftKey(today, -(reminders.lastDayAfterDue + 1))}T00:00:00Z`);
  const to = new Date(`${shiftKey(today, earliest + 1)}T23:59:59Z`);
  const gyms = await Gym.find({
    status: 'active',
    'owner.email': { $nin: ['', null] },
    'subscription.status': { $in: ['active', 'past_due'] },
    'subscription.stripeSubscriptionId': { $in: ['', null] },
    'subscription.amount': { $gt: 0 },
    'subscription.currentPeriodEnd': { $gte: from, $lte: to }
  })
    .sort({ slug: 1 })
    .lean();

  const planIds = [...new Set(gyms.map((g) => g.plan && String(g.plan)).filter(Boolean))];
  const plans = planIds.length ? await PlatformPlan.find({ _id: { $in: planIds } }).select('name').lean() : [];
  const planName = (gym) => (plans.find((p) => String(p._id) === String(gym.plan)) || {}).name || '';
  const chosen = await gateways.activeProvider(settings);
  const provider = chosen ? chosen.id : 'none';
  const accounts = activeAccounts(settings);
  const { GRACE_DAYS } = require('../jobs');

  const sent = [];
  const covered = [];
  const errors = [];
  let notDue = 0;

  for (const gym of gyms) {
    const sub = gym.subscription || {};
    const dueDate = dayKey(sub.currentPeriodEnd);
    const milestone = currentMilestone(milestonesFor(dueDate, reminders), today);
    const marker = milestone ? `${milestone.key}@${dueDate}` : '';
    if (!milestone || (sub.payReminders || []).includes(marker)) {
      notDue += 1;
      continue;
    }
    const entry = { slug: gym.slug, milestone: milestone.key, to: gym.owner.email, due_date: dueDate };
    if (dryRun) {
      sent.push(entry);
      continue;
    }
    if (!(await claim(gym, marker, dueDate))) {
      notDue += 1;
      continue;
    }
    // The overdue email went to this owner a moment ago (the gym went past
    // due on its due date): one email that morning, not two.
    if (milestone.kind === 'due' && sub.notices && sub.notices.pastDue && dayKey(sub.notices.pastDue) === today) {
      covered.push({ ...entry, by: 'pastDue notice' });
      continue;
    }
    try {
      const graceFrom = [sub.currentPeriodEnd, sub.pastDueSince].filter(Boolean).map((d) => new Date(d).getTime());
      const cutOff = graceFrom.length ? dateLabel(new Date(Math.min(...graceFrom) + GRACE_DAYS * DAY_MS)) : '';
      const { subject, html } = reminderEmail({ gym, planName: planName(gym), milestone, dueDate, today, provider, accounts, contactEmail: process.env.PLATFORM_CONTACT_EMAIL || '', cutOff });
      const result = await emailService.sendEmail(gym.owner.email, subject, html);
      if (!result || !result.success) throw new Error((result && result.error) || 'email could not be sent');
      sent.push(entry);
    } catch (error) {
      await release(gym, marker);
      console.error(`[jobs] payment reminder ${milestone.key} for ${gym.slug} failed:`, error.message);
      errors.push({ ...entry, error: error.message });
    }
  }

  return { sent, covered, errors, not_due: notDue, dry_run: dryRun };
}

module.exports = { sendOwnerPayReminders, milestonesFor, currentMilestone, remindersOf, reminderEmail, dayKey, shiftKey };
