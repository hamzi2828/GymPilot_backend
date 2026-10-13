// src/platform/jobs.js
//
// Scheduled work that spans every gym. The daily cron hits one endpoint;
// this is what turns that into "for each gym, in its own database".

const Gym = require('./models/gymModel');
const DemoRequest = require('./models/demoRequestModel');
const PlatformJobRun = require('./models/platformJobRunModel');
const { runWithTenant, siteUrlFor } = require('./tenantContext');
const { invalidateTenantCache } = require('./middleware/resolveTenant');
const { noticesDue } = require('./billingNotices');
// Called through the module, so a test can stand in for it.
const signupProvisioning = require('./services/signupProvisioning');
const { sendEmail } = require('../services/emailService');
const { shell, paragraph, button, detailTable, callout, dateLabel, escapeHtml } = require('../templates/gymEmails');

// How long a gym keeps being served after its period ends before it is cut
// off. Days, so a missed invoice is a reminder before it is an outage.
const GRACE_DAYS = Math.max(0, Number(process.env.SUBSCRIPTION_GRACE_DAYS || 7));
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';
// A gym Stripe bills is charged about an hour AFTER its period ends, and the
// webhook then moves the period on. Marking it past due (and emailing "payment
// overdue") the moment the date passes would cry wolf at every renewal, so
// Stripe is given this long to report before the date alone decides.
const STRIPE_SETTLE_DAYS = 2;

/* ------------------------------ per-gym scheduling ----------------------------- */

// What a gym left over by the time budget is reported as.
const DEFERRED = 'time budget used; first in line next run';

/**
 * How the daily job paces itself, from the env:
 *
 *   DAILY_JOB_CONCURRENCY  gyms worked on side by side (default 3, 1-10).
 *   DAILY_JOB_BUDGET_MS    how long after the cron fired new gyms are still
 *                          started (default 45000). Gyms already running are
 *                          left to finish, so this must sit below the
 *                          function's time limit by about the time one gym
 *                          takes: the default suits Vercel's 60-second
 *                          ceiling; on a 300-second function, 240000.
 *
 * A gym not reached is not lost: the next run starts with it.
 */
function dailyJobPace(env = process.env) {
  const int = (value, fallback, min, max) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    concurrency: int(env.DAILY_JOB_CONCURRENCY, 3, 1, 10),
    budgetMs: int(env.DAILY_JOB_BUDGET_MS, 45000, 1000, 15 * 60 * 1000)
  };
}

/**
 * The order a job visits gyms in: the one whose last run began longest ago
 * first, gyms it has never run for before all of them, slug breaking ties
 * (so a first run, and a job that keeps no record, go alphabetically as
 * they always did). `runs` are PlatformJobRun rows for the job.
 */
function orderByLastRun(gyms, runs = []) {
  const started = new Map(runs.map((r) => [String(r.gymId), r.lastStartedAt ? new Date(r.lastStartedAt).getTime() : 0]));
  const at = (gym) => started.get(String(gym._id)) || 0;
  const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  return [...gyms].sort((a, b) => at(a) - at(b) || bySlug(a, b));
}

/**
 * Runs `worker(item)` for each item in order, at most `concurrency` at a
 * time, and starts no new item once `budgetMs` has passed since `startedAt`.
 * Items already running are left to finish. The first item is always
 * started, so a run that begins late still moves the queue on.
 *
 * `worker` must not throw. Resolves with the items never started, in order.
 */
async function runWithinBudget(items, worker, { concurrency = 1, budgetMs = Infinity, startedAt = Date.now(), now = Date.now } = {}) {
  let next = 0;
  // Each lane takes the next item when it is free. Taking one is synchronous,
  // so two lanes can never take the same item.
  const lane = async () => {
    while (next < items.length && (next === 0 || now() - startedAt < budgetMs)) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  };
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return items.slice(next);
}

/**
 * Runs `fn(gym)` inside each active gym's own tenant context, and says how
 * the run went: `{ gyms: { slug: result }, schedule }`.
 *
 * A failure in one gym is recorded and the rest carry on -- one gym's broken
 * SMTP must not stop every other gym's reminders. Each gym runs inside its
 * own runWithTenant, so gyms running side by side never see each other's
 * database.
 *
 * Options, all optional -- without any, gyms run one after another in slug
 * order until all are done:
 *   slug         only this gym (a manual catch-up)
 *   job          remember each gym's run under this name (platform_job_runs)
 *                and start with the gyms least recently run
 *   record       false to use that order but write nothing (a dry run)
 *   concurrency  gyms side by side
 *   budgetMs     stop starting gyms this long after `startedAt`; the gyms
 *                not reached come back as skipped and are first next time
 *   startedAt    when the budget began (default now) -- the caller's own
 *                start, so time it spent before the gyms counts too
 */
async function scheduleActiveGyms(fn, options = {}) {
  const { slug = null, job = null, record = true, concurrency = 1, budgetMs = Infinity, startedAt = Date.now() } = options;

  const filter = { status: 'active' };
  if (slug) filter.slug = String(slug).toLowerCase().trim();
  // +database.uri: a gym on its own cluster must be entered there, not on
  // the shared one.
  const found = await Gym.find(filter).select('+database.uri').sort({ slug: 1 }).lean();
  const runs = job && found.length ? await PlatformJobRun.find({ job, gymId: { $in: found.map((g) => g._id) } }).select('gymId lastStartedAt').lean() : [];
  const gyms = job ? orderByLastRun(found, runs) : found;

  const results = {};
  const tookMs = {};
  const runnable = [];
  for (const gym of gyms) {
    if (Gym.accessBlock(gym)) results[gym.slug] = { skipped: 'subscription inactive' };
    else runnable.push(gym);
  }

  // Bookkeeping must never cost a gym its run: a failed write is logged and
  // the gym simply keeps its old place in the queue.
  const remember = (gym, fields) =>
    job && record
      ? PlatformJobRun.updateOne({ job, gymId: gym._id }, { $set: { gymSlug: gym.slug, ...fields } }, { upsert: true }).catch((error) =>
          console.error(`[jobs] could not record the ${job} run for ${gym.slug}:`, error.message)
        )
      : null;

  const deferred = await runWithinBudget(
    runnable,
    async (gym) => {
      const began = Date.now();
      await remember(gym, { lastStartedAt: new Date(began) });
      let outcome;
      try {
        results[gym.slug] = await runWithTenant(gym, () => fn(gym));
        outcome = { lastOutcome: 'ok', lastError: '' };
      } catch (error) {
        console.error(`[jobs] ${gym.slug} failed:`, error);
        results[gym.slug] = { error: error.message };
        outcome = { lastOutcome: 'error', lastError: String(error.message || error).slice(0, 500) };
      }
      tookMs[gym.slug] = Date.now() - began;
      await remember(gym, { lastRunAt: new Date(), lastDurationMs: tookMs[gym.slug], ...outcome });
    },
    { concurrency, budgetMs, startedAt }
  );
  for (const gym of deferred) results[gym.slug] = { skipped: DEFERRED };

  // Gyms finish in any order side by side; the answer lists them by slug.
  const bySlug = {};
  for (const key of Object.keys(results).sort()) bySlug[key] = results[key];

  return {
    gyms: bySlug,
    schedule: {
      gym: slug ? filter.slug : null,
      concurrency,
      budget_ms: Number.isFinite(budgetMs) ? budgetMs : null,
      elapsed_ms: Date.now() - startedAt,
      processed: runnable.length - deferred.length,
      failed: Object.values(results).filter((r) => r && r.error).length,
      deferred: deferred.map((g) => g.slug),
      took_ms: tookMs
    }
  };
}

/**
 * Runs `fn(gym)` inside each active gym's tenant context and answers
 * `{ slug: result }`. Same options as scheduleActiveGyms; with none, one gym
 * after another in slug order.
 */
async function forEachActiveGym(fn, options = {}) {
  return (await scheduleActiveGyms(fn, options)).gyms;
}

/**
 * The queries behind rollSubscriptionStatuses, for a given moment. Gyms
 * billed by hand go past due the moment their period ends; gyms Stripe bills
 * STRIPE_SETTLE_DAYS later, unless the webhook has moved their period on by
 * then (or marked them past due itself, on a failed payment).
 *
 * A past-due gym expires GRACE_DAYS after its period ended (toExpired) or
 * after it went past due (toExpiredPastDue), whichever comes first. The
 * second is what cuts off a gym whose card Stripe keeps failing to charge:
 * Stripe moves the period on at every renewal, paid or not, so its period
 * end alone would keep it served for ever. pastDueClock is the past-due gyms
 * with no clock yet (past due before it was kept, or re-saved from the
 * panel): theirs starts today.
 */
function rollFilters(now = new Date(), graceDays = GRACE_DAYS) {
  const DAY_MS = 86400000;
  const graceCutoff = new Date(now.getTime() - graceDays * DAY_MS);
  const stripeCutoff = new Date(now.getTime() - STRIPE_SETTLE_DAYS * DAY_MS);
  const noStripe = { $in: ['', null] };

  return {
    toPastDue: {
      status: 'active',
      'subscription.status': { $in: ['trialing', 'active'] },
      $or: [
        { 'subscription.stripeSubscriptionId': noStripe, 'subscription.currentPeriodEnd': { $ne: null, $lt: now } },
        { 'subscription.stripeSubscriptionId': { $nin: ['', null] }, 'subscription.currentPeriodEnd': { $ne: null, $lt: stripeCutoff } }
      ]
    },
    toExpired: {
      'subscription.status': 'past_due',
      'subscription.currentPeriodEnd': { $ne: null, $lt: graceCutoff }
    },
    toExpiredPastDue: {
      'subscription.status': 'past_due',
      'subscription.pastDueSince': { $ne: null, $lt: graceCutoff }
    },
    pastDueClock: {
      'subscription.status': 'past_due',
      'subscription.pastDueSince': null
    }
  };
}

/**
 * Moves subscriptions along as their dates pass:
 *   trialing / active  -> past_due   when the period has ended
 *                                    (Stripe-billed: STRIPE_SETTLE_DAYS later)
 *   past_due           -> expired    GRACE_DAYS after the period ended, or
 *                                    after it went past due if that is sooner
 *
 * Expiry is applied before past-due so a gym never jumps from active to
 * expired in a single run.
 */
async function rollSubscriptionStatuses({ dryRun = false, now = new Date() } = {}) {
  const { toPastDue, toExpired, toExpiredPastDue, pastDueClock } = rollFilters(now);
  const toExpire = { $or: [toExpired, toExpiredPastDue] };

  const [pastDue, expired, clocks] = await Promise.all([Gym.countDocuments(toPastDue), Gym.countDocuments(toExpire), Gym.countDocuments(pastDueClock)]);

  if (!dryRun) {
    if (expired) await Gym.updateMany(toExpire, { $set: { 'subscription.status': 'expired' } });
    if (clocks) await Gym.updateMany(pastDueClock, { $set: { 'subscription.pastDueSince': now } });
    if (pastDue) await Gym.updateMany(toPastDue, { $set: { 'subscription.status': 'past_due', 'subscription.pastDueSince': now } });
    if (expired || pastDue) invalidateTenantCache();
  }

  return { past_due: pastDue, expired, past_due_clock_started: clocks, grace_days: GRACE_DAYS, dry_run: dryRun };
}

/* ---------------------------- stuck paid sign-ups ---------------------------- */

// Each can mean making a gym, inside the daily function's time limit.
const SIGNUP_RECOVERIES_PER_RUN = 3;

/**
 * Paid sign-ups nothing else will finish: left being set up by a webhook
 * delivery that died, or failed, for longer than signupProvisioning.STUCK_MS.
 * Each is set up again from what Stripe says was paid for
 * (signupProvisioning.recoverSignup) -- the longest-waiting first, a few a
 * run. One still stuck after a few tries is reported to the admins; one
 * stuck for days is given up on, its Stripe subscription cancelled and the
 * buyer told.
 *
 * With dryRun, nothing is tried; the answer lists what would be.
 */
async function recoverStuckSignups({ dryRun = false, now = new Date(), limit = SIGNUP_RECOVERIES_PER_RUN } = {}) {
  const due = await DemoRequest.find(signupProvisioning.recoveryFilter(now.getTime())).sort({ updatedAt: 1 }).limit(limit).select('_id').lean();
  if (dryRun) return { due: due.map((doc) => String(doc._id)), dry_run: true };

  const results = [];
  for (const doc of due) results.push(await signupProvisioning.recoverSignup(doc._id, { now }));
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  for (const r of results) {
    if (r.outcome !== 'ready' && r.outcome !== 'not due') console.warn(`[jobs] signup ${r.id} ${r.outcome}: ${r.error || ''}`);
  }
  return { recovered: count('ready'), failed: count('failed'), gave_up: count('gave up'), results, dry_run: false };
}

/* --------------------------- owner lifecycle emails --------------------------- */

/**
 * The email for one notice. Every one names the gym and the date, and
 * points at the Billing tab of the gym's own Settings, where the owner
 * subscribes or updates the card. Once the gym has expired that page is
 * not served; the site shows a "sign in to renew" page in its place, and
 * paying there lands the owner back on the Billing tab.
 */
function ownerNoticeEmail({ notice, gym, siteUrl, daysLeft }) {
  const sub = gym.subscription || {};
  const gymName = gym.name;
  const firstName = (gym.owner && gym.owner.firstName) || 'there';
  // Stripe moves the period on at a renewal whether or not the charge went
  // through, so for a gym cut off for not paying with its period still
  // ahead, what ended is the payment -- when it went past due.
  const periodAhead = !!sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() > Date.now();
  const endLabel = dateLabel(notice === 'expired' && periodAhead && sub.pastDueSince ? sub.pastDueSince : sub.currentPeriodEnd) || 'soon';
  const settingsUrl = `${String(siteUrl).replace(/\/+$/, '')}/admin/settings?tab=billing`;
  const paying = !!sub.stripeSubscriptionId;
  // The day the grace period runs out, which is what the owner has to beat:
  // GRACE_DAYS after the period ended or it went past due, whichever is sooner.
  const graceFrom = [sub.currentPeriodEnd, sub.pastDueSince].filter(Boolean).map((d) => new Date(d).getTime());
  const cutOffLabel = graceFrom.length ? dateLabel(new Date(Math.min(...graceFrom) + GRACE_DAYS * 86400000)) : '';
  const details = detailTable([
    ['Gym', gymName],
    [notice === 'expired' ? 'Ended' : notice === 'cancelled' ? 'Cancelled' : notice === 'pastDue' ? 'Was due' : 'Trial ends', notice === 'cancelled' ? dateLabel(sub.cancelledAt) || 'recently' : endLabel]
  ]);

  if (notice.startsWith('trial')) {
    const when = daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
    const body = [
      paragraph(`Hi ${escapeHtml(firstName)}, the free trial for ${escapeHtml(gymName)} ends ${escapeHtml(when)}, on ${escapeHtml(endLabel)}.`),
      details,
      paying
        ? callout(`Your card is on file and will be charged when the trial ends. Nothing to do unless you want to change it.`, 'good')
        : callout(`To keep your website, member app and admin running after that, choose a plan under Settings → Billing before ${escapeHtml(endLabel)}.`),
      button(settingsUrl, paying ? 'Manage billing' : 'Subscribe now')
    ].join('');
    return { subject: `${gymName}: your ${PLATFORM_NAME} trial ends ${when}`, html: shell(PLATFORM_NAME, 'Your trial is ending', body) };
  }

  if (notice === 'pastDue') {
    // Stripe moves the period on at a renewal whether or not the charge went
    // through, so after a failed card the date on record is the NEXT one and
    // the grace period is Stripe's retries, not our date.
    const cardFailed = paying && !!sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() > Date.now();
    const body = cardFailed
      ? [
          paragraph(`Hi ${escapeHtml(firstName)}, the latest ${PLATFORM_NAME} payment for ${escapeHtml(gymName)} did not go through.`),
          detailTable([['Gym', gymName]]),
          callout(
            `Stripe will try your card again over the next few days. Update it now: if it cannot be charged${cutOffLabel ? ` by ${escapeHtml(cutOffLabel)}` : ''}, ${escapeHtml(gymName)}'s website, member app and admin stop being served.`,
            'bad'
          ),
          button(settingsUrl, 'Update my card')
        ]
      : [
          paragraph(`Hi ${escapeHtml(firstName)}, the ${PLATFORM_NAME} subscription for ${escapeHtml(gymName)} was due on ${escapeHtml(endLabel)} and has not been paid.`),
          details,
          callout(
            cutOffLabel
              ? `${escapeHtml(gymName)} keeps running until ${escapeHtml(cutOffLabel)}. After that its website, member app and admin stop being served until the subscription is paid.`
              : `${escapeHtml(gymName)} keeps running for a few more days. After that its website, member app and admin stop being served until the subscription is paid.`,
            'bad'
          ),
          button(settingsUrl, paying ? 'Update my card' : 'Subscribe now')
        ];
    return { subject: `Action needed: ${gymName}'s ${PLATFORM_NAME} payment is overdue`, html: shell(PLATFORM_NAME, 'Payment overdue', body.join('')) };
  }

  if (notice === 'cancelled') {
    // Stripe ended the subscription -- cancelled from the billing portal, or
    // after its retries of a failing card ran out -- and the gym with it.
    const body = [
      paragraph(`Hi ${escapeHtml(firstName)}, the ${PLATFORM_NAME} subscription for ${escapeHtml(gymName)} has been cancelled, so its website, member app and admin are no longer being served.`),
      details,
      callout('Nothing has been deleted. To start again, open your website, choose "Sign in to renew", sign in with your owner account and subscribe. Everything is back exactly as you left it within a minute or two.', 'bad'),
      button(settingsUrl, 'Renew now')
    ].join('');
    return { subject: `${gymName}'s ${PLATFORM_NAME} subscription has been cancelled`, html: shell(PLATFORM_NAME, 'Subscription ended', body) };
  }

  const body = [
    paragraph(`Hi ${escapeHtml(firstName)}, the ${PLATFORM_NAME} subscription for ${escapeHtml(gymName)} has ended, so its website, member app and admin are no longer being served.`),
    details,
    callout('Nothing has been deleted. Open your website, choose "Sign in to renew", sign in with your owner account and pay. Everything is back exactly as you left it within a minute or two.', 'bad'),
    button(settingsUrl, 'Renew now')
  ].join('');
  return { subject: `${gymName}'s ${PLATFORM_NAME} subscription has ended`, html: shell(PLATFORM_NAME, 'Subscription ended', body) };
}

/**
 * Emails each gym's owner about where its subscription stands: trial ending
 * in 7 / 3 / 1 days, gone past due, expired, cancelled -- each once (see
 * billingNotices.js). Sent by the platform, not by the gym: no tenant
 * context, so the platform's own SMTP (the env) is what delivers them.
 *
 * With dryRun, nothing is sent or marked; the answer lists what would be.
 */
async function sendOwnerBillingNotices({ dryRun = false, now = new Date() } = {}) {
  const gyms = await Gym.find({
    status: 'active',
    'owner.email': { $nin: ['', null] },
    'subscription.status': { $in: ['trialing', 'past_due', 'expired', 'cancelled'] }
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

module.exports = {
  forEachActiveGym,
  scheduleActiveGyms,
  runWithinBudget,
  orderByLastRun,
  dailyJobPace,
  rollSubscriptionStatuses,
  rollFilters,
  recoverStuckSignups,
  sendOwnerBillingNotices,
  ownerNoticeEmail,
  GRACE_DAYS,
  STRIPE_SETTLE_DAYS
};
