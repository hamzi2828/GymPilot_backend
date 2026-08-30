// src/gymfolio/services/membershipExpiry.js
//
// Moves memberships whose end date has passed out of 'active'.
//
// Why this is needed: nothing in this system ever wrote that transition. An
// order was set to 'active' when it was paid for and stayed that way forever,
// so every admin screen that filters or counts by status counted last year's
// lapsed members among this month's live ones.
//
// The front desk was never fooled -- membershipFor() in the attendance module
// re-derives active/expired from subscription.endDate on every punch, which is
// why an expired member is still greeted correctly at the counter. This fixes
// the stored status that everything ELSE reads.
//
// Deliberately NOT a background job. This backend runs serverless on Vercel,
// where there is no always-on process to host a scheduler, so the sweep is
// triggered by the screens that care (throttled, below) and is also available
// as scripts/expireMemberships.js for a real cron once one exists.

const PackageOrder = require('../models/packageOrderModel');

// How long a sweep's result is trusted before another is allowed. The screens
// that call this are opened many times a minute in a busy gym, and running a
// full scan for each would be pointless -- nothing can lapse twice in five
// minutes that could not equally wait five minutes to be noticed.
const THROTTLE_MS = 5 * 60 * 1000;

// Per-process, so each serverless instance sweeps at most once per window.
// Losing this on a cold start is harmless: the sweep is idempotent.
let lastSweepAt = 0;
let inFlight = null;

/**
 * The one query that defines "lapsed".
 *
 * Scoped tightly on purpose:
 *  - payment.status 'paid'   -- an unpaid order was never active to begin with
 *  - status 'active'         -- leaves 'cancelled' and 'suspended' alone, both
 *                               of which are decisions a human made and must
 *                               not be overwritten by the passage of time
 *  - endDate set and past    -- an open-ended membership (no end date) never
 *                               expires on its own
 */
function lapsedFilter(now) {
  return {
    'payment.status': 'paid',
    status: 'active',
    'subscription.endDate': { $ne: null, $lt: now }
  };
}

/**
 * Flips every lapsed membership to 'expired'.
 *
 * Idempotent -- running it twice changes nothing the second time, because the
 * filter no longer matches what it just updated. Safe to call concurrently:
 * two instances racing produce the same write.
 *
 * @param {Date} [now] the moment to judge against; injectable for tests
 * @returns {Promise<{ expired: number }>}
 */
async function expireLapsedOrders(now = new Date()) {
  const result = await PackageOrder.updateMany(lapsedFilter(now), {
    $set: {
      status: 'expired',
      'subscription.isActive': false
    }
  });

  const expired = result.modifiedCount || 0;
  if (expired > 0) {
    console.log(`[membership] marked ${expired} lapsed membership(s) expired`);
  }

  return { expired };
}

/**
 * The version the request path calls: sweeps at most once per THROTTLE_MS, and
 * never lets a sweep failure break the request that triggered it.
 *
 * Callers may await this (so the response reflects the sweep) or not (so the
 * response is not delayed by it). Both are safe -- concurrent callers share
 * one in-flight promise rather than starting a scan each.
 *
 * @returns {Promise<{ expired: number, skipped?: boolean }>}
 */
async function sweepIfDue() {
  const now = Date.now();

  if (now - lastSweepAt < THROTTLE_MS) {
    return { expired: 0, skipped: true };
  }

  // A second caller arriving mid-sweep waits for the first rather than
  // launching its own.
  if (inFlight) return inFlight;

  lastSweepAt = now;
  inFlight = expireLapsedOrders()
    .catch((error) => {
      // Housekeeping must never be the reason a page fails to load. Reset the
      // clock so the next request retries rather than waiting out the window.
      console.error('[membership] expiry sweep failed:', error.message);
      lastSweepAt = 0;
      return { expired: 0, failed: true };
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * How many memberships are currently lapsed but still stored as active.
 * Used by the script to report what it is about to do; not used on any
 * request path.
 *
 * @returns {Promise<number>}
 */
function countLapsed(now = new Date()) {
  return PackageOrder.countDocuments(lapsedFilter(now));
}

module.exports = {
  expireLapsedOrders,
  sweepIfDue,
  countLapsed,
  THROTTLE_MS
};
