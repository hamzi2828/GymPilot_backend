// src/platform/jobs.js
//
// Scheduled work that spans every gym. The daily cron hits one endpoint;
// this is what turns that into "for each gym, in its own database".

const Gym = require('./models/gymModel');
const { runWithTenant, siteUrlFor } = require('./tenantContext');
const { invalidateTenantCache } = require('./middleware/resolveTenant');
const { noticesDue } = require('./billingNotices');
const { sendEmail } = require('../services/emailService');
const { shell, paragraph, button, detailTable, callout, dateLabel, escapeHtml } = require('../templates/gymEmails');

// How long a gym keeps being served after its period ends before it is cut
// off. Days, so a missed invoice is a reminder before it is an outage.
const GRACE_DAYS = Math.max(0, Number(process.env.SUBSCRIPTION_GRACE_DAYS || 7));
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymPilot';

/**
 * Runs `fn(gym)` inside each active gym's tenant context, one after another.
 * A failure in one gym is recorded and the loop carries on -- one gym's
 * broken SMTP must not stop every other gym's reminders.
 */
async function forEachActiveGym(fn) {
  // +database.uri: a gym on its own cluster must be entered there, not on
  // the shared one.
  const gyms = await Gym.find({ status: 'active' }).select('+database.uri').sort({ slug: 1 }).lean();
  const results = {};

  for (const gym of gyms) {
    if (Gym.accessBlock(gym)) {
      results[gym.slug] = { skipped: 'subscription inactive' };
      continue;
    }
    try {
      results[gym.slug] = await runWithTenant(gym, () => fn(gym));
    } catch (error) {
      console.error(`[jobs] ${gym.slug} failed:`, error);
      results[gym.slug] = { error: error.message };
    }
  }

  return results;
}

/**
 * Moves subscriptions along as their dates pass:
 *   trialing / active  -> past_due   when the period has ended
 *   past_due           -> expired    GRACE_DAYS after that
 *
 * Expiry is applied before past-due so a gym never jumps from active to
 * expired in a single run.
 */
async function rollSubscriptionStatuses({ dryRun = false, now = new Date() } = {}) {
  const graceCutoff = new Date(now.getTime() - GRACE_DAYS * 86400000);

  const toPastDue = {
    status: 'active',
    'subscription.status': { $in: ['trialing', 'active'] },
    'subscription.currentPeriodEnd': { $ne: null, $lt: now }
  };
  const toExpired = {
    'subscription.status': 'past_due',
    'subscription.currentPeriodEnd': { $ne: null, $lt: graceCutoff }
  };

  const [pastDue, expired] = await Promise.all([Gym.countDocuments(toPastDue), Gym.countDocuments(toExpired)]);

  if (!dryRun) {
    if (expired) await Gym.updateMany(toExpired, { $set: { 'subscription.status': 'expired' } });
    if (pastDue) await Gym.updateMany(toPastDue, { $set: { 'subscription.status': 'past_due' } });
    if (expired || pastDue) invalidateTenantCache();
  }

  return { past_due: pastDue, expired, grace_days: GRACE_DAYS, dry_run: dryRun };
}

/* --------------------------- owner lifecycle emails --------------------------- */

/**
 * The email for one notice. Every one names the gym and the date, and
 * points at the gym's own Settings page, where the owner subscribes or
 * updates the card.
 */
function ownerNoticeEmail({ notice, gym, siteUrl, daysLeft }) {
  const sub = gym.subscription || {};
  const gymName = gym.name;
  const firstName = (gym.owner && gym.owner.firstName) || 'there';
  const endLabel = dateLabel(sub.currentPeriodEnd) || 'soon';
  const settingsUrl = `${String(siteUrl).replace(/\/+$/, '')}/admin/settings`;
  const paying = !!sub.stripeSubscriptionId;
  const details = detailTable([
    ['Gym', gymName],
    [notice === 'expired' ? 'Ended' : notice === 'pastDue' ? 'Was due' : 'Trial ends', endLabel]
  ]);

  if (notice.startsWith('trial')) {
    const when = daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
    const body = [
      paragraph(`Hi ${escapeHtml(firstName)}, the free trial for ${escapeHtml(gymName)} ends ${escapeHtml(when)}, on ${escapeHtml(endLabel)}.`),
      details,
      paying
        ? callout(`Your card is on file and will be charged when the trial ends. Nothing to do unless you want to change it.`, 'good')
        : callout(`To keep your website, member app and admin running after that, subscribe from your Settings page before ${escapeHtml(endLabel)}.`),
      button(settingsUrl, paying ? 'Manage billing' : 'Subscribe now')
    ].join('');
    return { subject: `${gymName}: your ${PLATFORM_NAME} trial ends ${when}`, html: shell(PLATFORM_NAME, 'Your trial is ending', body) };
  }

  if (notice === 'pastDue') {
    const body = [
      paragraph(`Hi ${escapeHtml(firstName)}, the ${PLATFORM_NAME} subscription for ${escapeHtml(gymName)} was due on ${escapeHtml(endLabel)} and has not been paid.`),
      details,
      callout(`${escapeHtml(gymName)} keeps running for ${GRACE_DAYS} more days. After that its website, member app and admin stop being served until the subscription is paid.`, 'bad'),
      button(settingsUrl, paying ? 'Update my card' : 'Subscribe now')
    ].join('');
    return { subject: `Action needed: ${gymName}'s ${PLATFORM_NAME} payment is overdue`, html: shell(PLATFORM_NAME, 'Payment overdue', body) };
  }

  const body = [
    paragraph(`Hi ${escapeHtml(firstName)}, the ${PLATFORM_NAME} subscription for ${escapeHtml(gymName)} has ended, so its website, member app and admin are no longer being served.`),
    details,
    callout('Nothing has been deleted. Subscribe again and everything is back exactly as you left it.', 'bad'),
    button(settingsUrl, 'Subscribe again')
  ].join('');
  return { subject: `${gymName}'s ${PLATFORM_NAME} subscription has ended`, html: shell(PLATFORM_NAME, 'Subscription ended', body) };
}

/**
 * Emails each gym's owner about where its subscription stands: trial ending
 * in 7 / 3 / 1 days, gone past due, expired -- each once (see
 * billingNotices.js). Sent by the platform, not by the gym: no tenant
 * context, so the platform's own SMTP (the env) is what delivers them.
 *
 * With dryRun, nothing is sent or marked; the answer lists what would be.
 */
async function sendOwnerBillingNotices({ dryRun = false, now = new Date() } = {}) {
  const gyms = await Gym.find({
    status: 'active',
    'owner.email': { $nin: ['', null] },
    'subscription.status': { $in: ['trialing', 'past_due', 'expired'] }
  })
    .sort({ slug: 1 })
    .lean();

  const sent = [];
  const errors = [];
  let skipped = 0;

  for (const gym of gyms) {
    const due = noticesDue(gym.subscription, now);
    if (!due.send) {
      if (due.mark.length && !dryRun) await stampNotices(gym, due.mark, now);
      skipped += 1;
      continue;
    }

    const to = gym.owner.email;
    const entry = { slug: gym.slug, notice: due.send, to, days_left: due.daysLeft };
    if (dryRun) {
      sent.push(entry);
      continue;
    }

    try {
      const { subject, html } = ownerNoticeEmail({ notice: due.send, gym, siteUrl: siteUrlFor(gym), daysLeft: due.daysLeft });
      const result = await sendEmail(to, subject, html);
      if (!result || !result.success) throw new Error((result && result.error) || 'email could not be sent');
      await stampNotices(gym, due.mark, now);
      sent.push(entry);
    } catch (error) {
      console.error(`[jobs] billing notice ${due.send} for ${gym.slug} failed:`, error.message);
      errors.push({ ...entry, error: error.message });
    }
  }

  return { sent, errors, skipped, dry_run: dryRun };
}

function stampNotices(gym, keys, now) {
  const set = {};
  for (const key of keys) set[`subscription.notices.${key}`] = now;
  return Gym.updateOne({ _id: gym._id }, { $set: set });
}

module.exports = { forEachActiveGym, rollSubscriptionStatuses, sendOwnerBillingNotices, ownerNoticeEmail, GRACE_DAYS };
