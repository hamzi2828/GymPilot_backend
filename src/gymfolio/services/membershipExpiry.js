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
const User = require('../../models/user');
const notify = require('../../services/gymNotifications');
const { afterResponse } = require('../../services/afterResponse');
const { tenantKey } = require('../../platform/tenantContext');

const DAY_MS = 86400000;

// A Stripe subscription renews on Stripe's clock, not ours. The next term's
// invoice is paid around the moment the current one ends, and the
// invoice.paid that moves endDate on can land an hour or more later (days,
// if Stripe is retrying a card). Expiring on the dot marked renewing
// members expired in between. They get the same allowance the platform
// gives the gyms it bills through Stripe (platform/jobs.js).
const STRIPE_SETTLE_DAYS = 2;

// A subscription Stripe will still try to renew: it has an id, and nobody
// -- the member, the desk or Stripe -- has said stop. One that has been
// told to stop ends on its end date like any other membership. The same
// rule as reminderJobs.willAutoRenew, written as a query.
const RENEWING = {
  'payment.stripeSubscriptionId': { $nin: [null, ''] },
  'subscription.autoRenew': true,
  'subscription.cancelAtPeriodEnd': { $ne: true },
  'subscription.stripeStatus': { $nin: ['canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'] }
};

// "Your membership has ended" goes to members whose membership lapsed within
// this many days. Older lapses -- the backlog the first sweep after a deploy
// corrects -- are closed quietly: a notice months late is noise.
const EXPIRED_NOTICE_DAYS = 7;

// How long a sweep's result is trusted before another is allowed. The screens
// that call this are opened many times a minute in a busy gym, and running a
// full scan for each would be pointless -- nothing can lapse twice in five
// minutes that could not equally wait five minutes to be noticed.
const THROTTLE_MS = 5 * 60 * 1000;

// Per-process and per-gym, so each serverless instance sweeps each gym at
// most once per window. Losing this on a cold start is harmless: the sweep
// is idempotent.
const sweeps = new Map(); // tenantKey -> { lastSweepAt, inFlight }

function sweepState() {
  const key = tenantKey();
  let state = sweeps.get(key);
  if (!state) {
    state = { lastSweepAt: 0, inFlight: null };
    sweeps.set(key, state);
  }
  return state;
}

/**
 * The one query that defines "lapsed".
 *
 * Scoped tightly on purpose:
 *  - payment.status 'paid'   -- an unpaid order was never active to begin with
 *  - status 'active'         -- leaves 'cancelled' and 'suspended' alone, both
 *                               of which are decisions a human made and must
 *                               not be overwritten by the passage of time
 *  - endDate set and past    -- an open-ended membership (no end date) never
 *                               expires on its own; a Stripe subscription
 *                               still renewing gets STRIPE_SETTLE_DAYS more
 *
 * 'past_due' (a renewal Stripe could not collect and is retrying) and
 * 'frozen' are never swept: past-due ends when Stripe says so -- paid
 * (active again) or given up on (customer.subscription.deleted, cancelled)
 * -- and is not the same thing as a membership that ran out.
 */
function lapsedFilter(now) {
  const settled = new Date(now.getTime() - STRIPE_SETTLE_DAYS * DAY_MS);
  return {
    'payment.status': 'paid',
    status: 'active',
    $or: [
      { 'subscription.endDate': { $ne: null, $lt: settled } },
      { 'subscription.endDate': { $ne: null, $lt: now }, $nor: [RENEWING] }
    ]
  };
}

/**
 * The one query that defines "live": paid, in a status that grants access
 * (frozen and past-due members are still members), and not past its end.
 * The dashboard, the reports and the campaign audiences all count from this
 * so they cannot disagree about how many members the gym has.
 */
const LIVE_STATUSES = ['active', 'frozen', 'past_due'];

function liveFilter(now = new Date()) {
  return {
    'payment.status': 'paid',
    status: { $in: LIVE_STATUSES },
    'subscription.endDate': { $gte: now }
  };
}

/**
 * How many distinct PEOPLE hold a live order -- a member with a membership
 * and a session pack is one member, not two. Guest orders (no userId) are
 * told apart by email. `extra` narrows the live filter (an end-date window
 * for "expiring", say).
 */
async function countLiveMembers(now = new Date(), extra = {}) {
  const rows = await PackageOrder.aggregate([
    { $match: { ...liveFilter(now), ...extra } },
    { $group: { _id: { $ifNull: ['$userId', { $toLower: { $ifNull: ['$customerInfo.email', ''] } }] } } },
    { $count: 'n' }
  ]);
  return rows.length ? rows[0].n : 0;
}

const EXPIRE = { $set: { status: 'expired', 'subscription.isActive': false } };

/**
 * Who, if anyone, to tell that this membership has ended: only a membership
 * (a pack or a pass running out is not "your membership has ended"), only
 * an account still open, and only when nothing else live follows it -- a
 * member who renewed early has their next term starting right now.
 *
 * @returns {Promise<{ tell: boolean, member?: object|null }>}
 */
async function expiredNoticeFor(order, now) {
  const kind = (order.packageDetails && order.packageDetails.kind) || 'membership';
  if (kind !== 'membership') return { tell: false };

  const member = order.userId ? await User.findById(order.userId).select('firstName lastName email isActive').lean() : null;
  if (order.userId && (!member || member.isActive === false)) return { tell: false };

  const owner = [];
  if (order.userId) owner.push({ userId: order.userId });
  const email = order.customerInfo && order.customerInfo.email;
  if (email) owner.push({ 'customerInfo.email': String(email).toLowerCase().trim() });
  if (owner.length) {
    const next = await PackageOrder.exists({
      ...liveFilter(now),
      _id: { $ne: order._id },
      $and: [{ $or: owner }, { $or: [{ 'packageDetails.kind': 'membership' }, { 'packageDetails.kind': { $exists: false } }] }]
    });
    if (next) return { tell: false };
  }
  return { tell: true, member };
}

/** Sends the "membership ended" notice if it is due. Never throws. */
async function tellExpired(order, now) {
  try {
    const { tell, member } = await expiredNoticeFor(order, now);
    if (!tell) return false;
    await notify.membershipExpired(order, member);
    return true;
  } catch (error) {
    console.error(`[membership] expiry notice for ${order.orderNumber} failed:`, error.message);
    return false;
  }
}

/**
 * Flips every lapsed membership to 'expired', and tells the members whose
 * membership has just ended.
 *
 * Idempotent -- running it twice changes nothing the second time, because the
 * filter no longer matches what it just updated. Safe to call concurrently:
 * recent lapses are flipped one conditional update at a time, and only the
 * sweep whose update matched sends that order's notice, so two sweeps
 * racing (two serverless instances, the cron and a page load) tell the
 * member once. The older backlog is flipped in one write, silently.
 *
 * @param {Date} [now] the moment to judge against; injectable for tests
 * @param {{ waitForNotices?: boolean }} [options] false: send the notices in
 *   the background (the request path), rather than before returning
 * @returns {Promise<{ expired: number, notified: number }>} notified: notices
 *   sent -- or, when not waiting, orders queued to be considered for one
 */
async function expireLapsedOrders(now = new Date(), { waitForNotices = true } = {}) {
  const lapsed = lapsedFilter(now);
  const noticeFrom = new Date(now.getTime() - EXPIRED_NOTICE_DAYS * DAY_MS);

  let expired = 0;
  const notices = [];
  const recent = await PackageOrder.find({ $and: [lapsed, { 'subscription.endDate': { $gte: noticeFrom } }] }).select('_id').lean();
  for (const { _id } of recent) {
    const order = await PackageOrder.findOneAndUpdate({ $and: [{ _id }, lapsed] }, EXPIRE, { new: true }).lean();
    if (!order) continue; // another sweep flipped it first, and tells the member
    expired += 1;
    notices.push(tellExpired(order, now));
  }

  const result = await PackageOrder.updateMany(lapsed, EXPIRE);
  expired += result.modifiedCount || 0;

  if (expired > 0) {
    console.log(`[membership] marked ${expired} lapsed membership(s) expired`);
  }

  if (!waitForNotices) {
    if (notices.length) afterResponse(Promise.all(notices), 'membershipExpired');
    return { expired, notified: notices.length };
  }
  const notified = (await Promise.all(notices)).filter(Boolean).length;
  return { expired, notified };
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
  const state = sweepState();

  if (now - state.lastSweepAt < THROTTLE_MS) {
    return { expired: 0, skipped: true };
  }

  // A second caller arriving mid-sweep waits for the first rather than
  // launching its own.
  if (state.inFlight) return state.inFlight;

  state.lastSweepAt = now;
  // The notices go out in the background: a page load waits for the
  // statuses it shows, not for a mail server.
  state.inFlight = expireLapsedOrders(new Date(), { waitForNotices: false })
    .catch((error) => {
      // Housekeeping must never be the reason a page fails to load. Reset the
      // clock so the next request retries rather than waiting out the window.
      console.error('[membership] expiry sweep failed:', error.message);
      state.lastSweepAt = 0;
      return { expired: 0, failed: true };
    })
    .finally(() => {
      state.inFlight = null;
    });

  return state.inFlight;
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
  lapsedFilter,
  liveFilter,
  countLiveMembers,
  LIVE_STATUSES,
  THROTTLE_MS,
  STRIPE_SETTLE_DAYS,
  EXPIRED_NOTICE_DAYS
};
