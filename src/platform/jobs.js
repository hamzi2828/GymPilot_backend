// src/platform/jobs.js
//
// Scheduled work that spans every gym. The daily cron hits one endpoint;
// this is what turns that into "for each gym, in its own database".

const Gym = require('./models/gymModel');
const { runWithTenant } = require('./tenantContext');
const { invalidateTenantCache } = require('./middleware/resolveTenant');

// How long a gym keeps being served after its period ends before it is cut
// off. Days, so a missed invoice is a reminder before it is an outage.
const GRACE_DAYS = Math.max(0, Number(process.env.SUBSCRIPTION_GRACE_DAYS || 7));

/**
 * Runs `fn(gym)` inside each active gym's tenant context, one after another.
 * A failure in one gym is recorded and the loop carries on -- one gym's
 * broken SMTP must not stop every other gym's reminders.
 */
async function forEachActiveGym(fn) {
  const gyms = await Gym.find({ status: 'active' }).sort({ slug: 1 }).lean();
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

module.exports = { forEachActiveGym, rollSubscriptionStatuses, GRACE_DAYS };
