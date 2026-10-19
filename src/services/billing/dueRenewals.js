// src/services/billing/dueRenewals.js
//
// The renewal order a member is asked to pay by payment link.
//
// A few days before a member's term ends (the gym's longest "days before"
// reminder, Settings → Payments → Billing reminders) the daily job makes ONE
// pending order for the next term: the same package at its price today,
// `payment.method: 'online'`. It is what the payment link, the reminders and
// the due-date card charge all point at. Its metadata says what it is for:
//
//   dueFor          the id of the paid order whose term it renews -- one
//                   renewal order per term (unique index on the order model)
//   dueDate         the day that term ends, 'YYYY-MM-DD' on the gym's clock
//   lastDay         the last day to pay: dueDate + billing.lastDayAfterDue
//   billingNotices  which messages have gone, "<milestone>@<dueDate>,..."
//                   (billingJob.js)
//   closedReason    why it was closed, when it was: 'superseded' (the
//                   member renewed another way), 'expired' (the link ran
//                   out unpaid), 'not renewing', 'term closed'
//
// Once a following term exists by any route -- renewed at the desk, bought
// online, a bank transfer approved -- the renewal order is stale and is
// closed, which also stops its reminders: markPaidAndActivate calls
// supersedeFor() for every order it activates, and the daily job checks
// again before it sends anything.
//
// Closed orders read payment 'failed', status 'cancelled' -- the same end
// state as a card checkout that expired unpaid. A payment that still
// arrives for one (a checkout opened just before the member paid at the
// desk) activates it all the same (activationClaim): the member paid, so
// they get the term they paid for.

const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Package = require('../../gymfolio/models/packageModel');
const User = require('../../models/user');
const Settings = require('../../models/settings');
const T = require('../../attendance/services/timeUtils');
const { parseAmount, resolveCurrency } = require('../../helper/money');
const { leadDays } = require('./settings');

const IS_MEMBERSHIP = { $or: [{ 'packageDetails.kind': 'membership' }, { 'packageDetails.kind': { $exists: false } }] };

// A renewal order still waiting for its money. 'failed' is a checkout
// attempt that did not go through; the order itself is still open.
const OPEN = { status: 'pending', 'payment.status': { $in: ['pending', 'failed'] } };

// How long a link (and so its order) outlives the last day to pay.
const LINK_GRACE_DAYS = 7;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isMembership(order) {
  const kind = order && order.packageDetails && order.packageDetails.kind;
  return !kind || kind === 'membership';
}

/** What an order's metadata holds under `key` (a Map on a document, an object when lean). */
function metadataOf(order, key) {
  const metadata = order && order.metadata;
  if (!metadata) return undefined;
  return typeof metadata.get === 'function' ? metadata.get(key) : metadata[key];
}

/** Whether an order is a renewal waiting on a payment link. */
function isDueRenewal(order) {
  return !!metadataOf(order, 'dueFor');
}

function isOpen(order) {
  const payment = (order && order.payment) || {};
  return !!order && order.status === 'pending' && ['pending', 'failed'].includes(payment.status);
}

/** The due date and last day for a term ending at `endDate`, on the gym's calendar. */
function datesFor(endDate, billing) {
  const dueDate = T.dateKey(new Date(endDate));
  return { dueDate, lastDay: T.shiftDateKey(dueDate, billing.lastDayAfterDue) };
}

/** The last day a renewal order's link works: its last day to pay plus the grace. */
function linkLastDay(lastDay) {
  return T.shiftDateKey(lastDay, LINK_GRACE_DAYS);
}

function memberName(member) {
  return [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || member.phone || 'Member';
}

function row(term, extra = {}) {
  return { order: term.orderNumber, userId: term.userId ? String(term.userId) : null, ...extra };
}

// Lazy: reminderJobs reaches this module's callers through runDaily.
function reminders() {
  return require('../reminderJobs');
}

/**
 * Closes an open renewal order, once: only an order still open is changed,
 * so a payment that has just started recording it is never undone.
 * @returns {Promise<boolean>} whether this call closed it
 */
async function closeDueOrder(orderId, reason, { by = null, note = '', now = new Date() } = {}) {
  const messages = {
    superseded: 'Renewed another way',
    expired: 'The payment link expired unpaid',
    'not renewing': 'The membership is set not to renew',
    'term closed': 'The membership it renews was closed'
  };
  const result = await PackageOrder.updateOne(
    { _id: orderId, ...OPEN },
    {
      $set: {
        status: 'cancelled',
        'payment.status': 'failed',
        'payment.lastPaymentError': messages[reason] || reason,
        'subscription.isActive': false,
        cancellation: { cancelledAt: now, reason: note || messages[reason] || reason, by: null, source: 'billing', immediate: false },
        'metadata.closedReason': reason,
        ...(by ? { 'metadata.supersededBy': String(by) } : {})
      }
    }
  );
  return (result.modifiedCount || 0) > 0;
}

/**
 * Closes the member's open renewal orders whose term now has a following
 * one -- called for every order markPaidAndActivate activates. The order
 * just paid is never one of them: it is paid, not open.
 * @returns {Promise<{ closed: string[] }>} the order numbers closed
 */
async function supersedeFor(paidOrder) {
  const closed = [];
  if (!paidOrder || !paidOrder.userId || !isMembership(paidOrder)) return { closed };
  if (!paidOrder.payment || paidOrder.payment.status !== 'paid') return { closed };

  const open = await PackageOrder.find({ userId: paidOrder.userId, _id: { $ne: paidOrder._id }, 'metadata.dueFor': { $type: 'string' }, ...OPEN })
    .select('orderNumber metadata')
    .lean();
  for (const due of open) {
    const term = await PackageOrder.findById(metadataOf(due, 'dueFor')).select('orderNumber userId customerInfo subscription').lean();
    if (term && !(await reminders().hasFollowingTerm(term))) continue;
    if (await closeDueOrder(due._id, 'superseded', { by: paidOrder._id, note: `Renewed by ${paidOrder.orderNumber || 'another order'}` })) {
      closed.push(due.orderNumber);
    }
  }
  return { closed };
}

/**
 * Why an open renewal order should no longer be chased, or null: its term
 * renewed another way, was closed, or was set not to renew. Its dates are
 * re-read from the term as well, since a freeze or staff moving the end
 * date moves the due date with it (`dates` in the answer when they moved).
 */
async function reviewDueOrder(due, billing) {
  const term = await PackageOrder.findById(metadataOf(due, 'dueFor'))
    .select('orderNumber userId customerInfo subscription status payment.status payment.stripeSubscriptionId cancellation')
    .lean();
  if (!term) return { close: 'term closed' };
  if (term.payment && term.payment.status === 'refunded') return { close: 'term closed' };
  if (term.status === 'cancelled' && term.cancellation && term.cancellation.immediate) return { close: 'term closed' };
  if (term.subscription && term.subscription.cancelAtPeriodEnd === true) return { close: 'not renewing' };
  if (await reminders().hasFollowingTerm(term)) return { close: 'superseded' };

  const end = term.subscription && term.subscription.endDate;
  if (!end) return { term };
  const dates = datesFor(end, billing);
  const moved = dates.dueDate !== metadataOf(due, 'dueDate') || dates.lastDay !== metadataOf(due, 'lastDay');
  return { term, dates: moved ? dates : null };
}

/**
 * Makes the renewal order for every term that ends within the gym's lead
 * time and has nothing after it -- once per term, however often it runs.
 *
 * A term is left alone (and said so in the report) when it renews itself (a
 * card subscription), is set not to renew, already has a following term,
 * belongs to no member account (a guest order) or a disabled one, or its
 * package is no longer on sale at a price that can be paid online.
 *
 * @returns {Promise<{ created: object[], skipped: object[] }>}
 */
async function ensureDueRenewals({ billing, dryRun = false, now = new Date() } = {}) {
  const created = [];
  const skipped = [];
  const today = T.dateKey(now);
  const horizon = T.lastMomentOfLocalDay(T.shiftDateKey(today, leadDays(billing)));

  const terms = await PackageOrder.find({
    'payment.status': 'paid',
    status: 'active',
    'subscription.endDate': { $gt: now, $lte: horizon },
    $and: [IS_MEMBERSHIP]
  })
    .select('orderNumber userId packageId customerInfo packageDetails subscription status payment.stripeSubscriptionId')
    .lean();

  let settings = null;
  for (const term of terms) {
    if (!term.userId) {
      skipped.push(row(term, { reason: 'guest order (no member account)' }));
      continue;
    }
    if (reminders().willAutoRenew(term)) {
      skipped.push(row(term, { reason: 'renews automatically' }));
      continue;
    }
    if (term.subscription && term.subscription.cancelAtPeriodEnd === true) {
      skipped.push(row(term, { reason: 'set not to renew' }));
      continue;
    }
    const existing = await PackageOrder.findOne({ 'metadata.dueFor': String(term._id) }).select('orderNumber status').lean();
    if (existing) {
      skipped.push(row(term, { reason: existing.status === 'cancelled' ? 'renewal order closed' : 'renewal order exists', renewal: existing.orderNumber }));
      continue;
    }
    if (await reminders().hasFollowingTerm(term)) {
      skipped.push(row(term, { reason: 'already renewed' }));
      continue;
    }

    const member = await User.findById(term.userId).select('firstName lastName email phone isActive addresses').lean();
    if (!member) {
      skipped.push(row(term, { reason: 'member account missing' }));
      continue;
    }
    if (member.isActive === false) {
      skipped.push(row(term, { reason: 'account disabled' }));
      continue;
    }

    const pkg = term.packageId ? await Package.findById(term.packageId).lean() : null;
    if (!pkg || pkg.isActive === false) {
      skipped.push(row(term, { reason: 'package no longer on sale', package: (term.packageDetails && term.packageDetails.name) || '' }));
      continue;
    }
    const price = parseAmount(pkg.price);
    if (price === null || price <= 0 || (pkg.kind && pkg.kind !== 'membership')) {
      skipped.push(row(term, { reason: 'package has no price to pay online', package: pkg.name }));
      continue;
    }

    const { dueDate, lastDay } = datesFor(term.subscription.endDate, billing);
    if (dryRun) {
      created.push(row(term, { package: pkg.name, amount: round2(price), dueDate, lastDay, dryRun: true }));
      continue;
    }

    if (!settings) settings = await Settings.getSettings().catch(() => null);
    const membership = require('../../gymfolio/services/membershipService');
    const currency = resolveCurrency(pkg.currency, settings && settings.currency);
    const addresses = Array.isArray(member.addresses) ? member.addresses : [];
    const address = addresses.find((a) => a.isDefault) || addresses[0];
    const amount = round2(price);

    try {
      const order = await PackageOrder.create({
        orderNumber: await PackageOrder.generateOrderNumber(),
        userId: term.userId,
        packageId: pkg._id,
        packageDetails: membership.packageSnapshot(pkg, currency),
        customerInfo: {
          fullName: memberName(member),
          email: member.email || '',
          phone: member.phone || '',
          country: (address && address.country) || ''
        },
        payment: {
          method: 'online',
          amount,
          // A renewal is not joining, and carries no trainer: the package alone.
          joiningFee: 0,
          trainerFee: 0,
          subtotal: amount,
          discountAmount: 0,
          currency: currency.toLowerCase(),
          status: 'pending'
        },
        subscription: { autoRenew: false },
        renewedFrom: term._id,
        status: 'pending',
        notes: `Renewal of ${term.orderNumber}, due ${dueDate}`,
        metadata: { dueFor: String(term._id), dueDate, lastDay, source: 'billing' }
      });
      created.push(row(term, { renewal: order.orderNumber, package: pkg.name, amount, dueDate, lastDay }));
    } catch (error) {
      // Another run made it a moment ago: one renewal order per term.
      if (error && error.code === 11000) {
        skipped.push(row(term, { reason: 'renewal order exists' }));
        continue;
      }
      throw error;
    }
  }
  return { created, skipped };
}

module.exports = {
  OPEN,
  LINK_GRACE_DAYS,
  metadataOf,
  isDueRenewal,
  isOpen,
  datesFor,
  linkLastDay,
  closeDueOrder,
  supersedeFor,
  reviewDueOrder,
  ensureDueRenewals
};
