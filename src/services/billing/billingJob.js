// src/services/billing/billingJob.js
//
// The renewal-billing part of the daily job (reminderJobs.runDaily), for
// the gym in context:
//
//   1. every open renewal order is checked again -- closed when its term
//      renewed another way, was closed or set not to renew, or its link ran
//      out unpaid; its dates follow the term when a freeze or staff moved
//      the end date;
//   2. a renewal order is made for each term ending within the gym's lead
//      time (dueRenewals.ensureDueRenewals).
//
// It does nothing new for a gym that cannot be paid at all -- no online
// gateway and no bank account -- or has every reminder and the automatic
// charge switched off; open orders are still tidied.

const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Settings = require('../../models/settings');
const T = require('../../attendance/services/timeUtils');
const { billingSettings, leadDays } = require('./settings');
const { activeProvider, canAutoCharge } = require('./provider');
const { activeBanks } = require('./banks');
const due = require('./dueRenewals');

/** Whether this gym's billing reminders run, and if not, why not. */
function billingState({ billing, provider, banks }) {
  const canBePaid = !!provider || banks.length > 0;
  const anyChannel = Object.values(billing.sendVia).some(Boolean);
  const remindersOn = anyChannel && (billing.reminderDaysBefore.length > 0 || billing.dueDayReminder || billing.lastDayAfterDue > 0);
  const autoChargeOn = billing.autoCharge.enabled && canAutoCharge(provider);
  if (!canBePaid) return { enabled: false, reason: 'no online payment gateway and no bank account: nothing a member could pay with' };
  if (!remindersOn && !autoChargeOn) return { enabled: false, reason: 'billing reminders and automatic charges are switched off' };
  return { enabled: true, remindersOn, autoChargeOn };
}

/**
 * The open renewal orders, each checked against its term. Closed ones are
 * reported and dropped; the rest come back, with their dates brought up to
 * date, for the reminders to go through.
 */
async function reviewOpenOrders({ billing, dryRun, now }) {
  const today = T.dateKey(now);
  const closed = [];
  const moved = [];
  const open = [];

  const orders = await PackageOrder.find({ 'metadata.dueFor': { $type: 'string' }, ...due.OPEN });
  for (const order of orders) {
    const lastDay = due.metadataOf(order, 'lastDay');
    let reason = lastDay && due.linkLastDay(lastDay) < today ? 'expired' : null;
    let review = null;
    if (!reason) {
      review = await due.reviewDueOrder(order, billing);
      reason = review.close || null;
    }
    if (reason) {
      if (dryRun || (await due.closeDueOrder(order._id, reason, { now }))) closed.push({ order: order.orderNumber, reason, ...(dryRun ? { dryRun: true } : {}) });
      continue;
    }
    if (review.dates) {
      moved.push({ order: order.orderNumber, from: due.metadataOf(order, 'dueDate'), to: review.dates.dueDate });
      if (!dryRun) {
        await PackageOrder.updateOne(
          { _id: order._id, ...due.OPEN },
          { $set: { 'metadata.dueDate': review.dates.dueDate, 'metadata.lastDay': review.dates.lastDay } }
        );
        order.metadata.set('dueDate', review.dates.dueDate);
        order.metadata.set('lastDay', review.dates.lastDay);
      }
    }
    open.push({ order, term: review.term });
  }
  return { closed, moved, open };
}

async function runBillingJob({ dryRun = false, now = new Date() } = {}) {
  const settings = await Settings.getSettings().catch(() => null);
  const billing = billingSettings(settings);
  const [provider, banks] = await Promise.all([activeProvider(), activeBanks()]);
  const state = billingState({ billing, provider, banks });

  const reviewed = await reviewOpenOrders({ billing, dryRun, now });
  const report = {
    enabled: state.enabled,
    ...(state.reason ? { reason: state.reason } : {}),
    provider: provider ? provider.id || 'online' : null,
    leadDays: leadDays(billing),
    closed: reviewed.closed,
    moved: reviewed.moved,
    created: [],
    skipped: [],
    ...(dryRun ? { dryRun: true } : {})
  };
  if (!state.enabled) return withCounts(report);

  const made = await due.ensureDueRenewals({ billing, dryRun, now });
  report.created = made.created;
  report.skipped = made.skipped;
  return withCounts(report);
}

function withCounts(report) {
  report.counts = { created: report.created.length, closed: report.closed.length, skipped: report.skipped.length };
  return report;
}

module.exports = { runBillingJob, billingState, reviewOpenOrders };
