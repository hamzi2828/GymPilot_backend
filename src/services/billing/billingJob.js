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
//      time (dueRenewals.ensureDueRenewals);
//   3. each open renewal order gets what today calls for:
//        - on (or after) the due date, when the gym charges saved cards and
//          its gateway can, the member's auto-pay card is charged first:
//          paid -> the order is activated and the receipt goes, nothing
//          else; declined -> the order says so (payment 'failed', still
//          open) and the member gets the link with "your card was declined";
//        - otherwise the message for the latest milestone reached: N days
//          before ("due on <date>"), the due day, the last day to pay.
//      Each milestone goes at most once per order (and due date), recorded
//      in metadata.billingNotices before it is sent, so two runs side by
//      side cannot both send it; a message no channel took is given back
//      to be tried on the next run. A milestone missed (the job did not run
//      that day) is not sent late if a later one has been reached; after
//      the last day nothing more is sent, and the membership lapses as it
//      always has.
//
// It does nothing new for a gym that cannot be paid at all -- no online
// gateway and no bank account -- or has every reminder and the automatic
// charge switched off; open orders are still tidied.

const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Settings = require('../../models/settings');
const T = require('../../attendance/services/timeUtils');
const { billingSettings, leadDays } = require('./settings');
const { activeProvider, canAutoCharge, canCheckout } = require('./provider');
const { activeBanks } = require('./banks');
const due = require('./dueRenewals');
const savedMethods = require('./savedMethods');

const DECLINED = 'Your card was declined';
const CARD_EXPIRED = 'Your saved card has expired';

/**
 * Whether this gym's billing reminders run, and if not, why not. A member
 * must be able to pay the link: through the gateway (one that takes payment
 * links -- not Stripe's), or by transfer to a bank account on file.
 */
function billingState({ billing, provider, banks }) {
  const canBePaid = canCheckout(provider) || banks.length > 0;
  const anyChannel = Object.values(billing.sendVia).some(Boolean);
  const remindersOn = anyChannel && (billing.reminderDaysBefore.length > 0 || billing.dueDayReminder || billing.lastDayAfterDue > 0);
  const autoChargeOn = billing.autoCharge.enabled && canAutoCharge(provider);
  if (!canBePaid) return { enabled: false, remindersOn: false, autoChargeOn: false, reason: 'no online payment gateway and no bank account: nothing a member could pay with' };
  if (!remindersOn && !autoChargeOn) return { enabled: false, remindersOn, autoChargeOn, reason: 'billing reminders and automatic charges are switched off' };
  return { enabled: true, remindersOn, autoChargeOn };
}

/**
 * The messages a renewal order gets, in date order: one per "days before"
 * (a 0 reads as the due day), the due day, and the last day to pay.
 */
function milestonesFor(dueDate, lastDay, billing) {
  const list = billing.reminderDaysBefore.map((days) => ({
    key: `before${days}`,
    kind: days === 0 ? 'due' : 'before',
    date: T.shiftDateKey(dueDate, -days),
    daysLeft: days
  }));
  if (billing.dueDayReminder) list.push({ key: 'due', kind: 'due', date: dueDate, daysLeft: 0 });
  if (billing.lastDayAfterDue > 0 && lastDay && lastDay > dueDate) list.push({ key: 'last', kind: 'last', date: lastDay });
  // By date; on the same day the later in this list (the due-day message
  // over a "0 days before") is the one that counts.
  return list.map((m, i) => ({ ...m, i })).sort((a, b) => (a.date === b.date ? a.i - b.i : a.date < b.date ? -1 : 1));
}

/** The milestone today calls for: the latest one reached, none after the last day. */
function currentMilestone(milestones, today, lastDay) {
  if (lastDay && today > lastDay) return null;
  let current = null;
  for (const m of milestones) if (m.date <= today) current = m;
  return current;
}

function noticesOf(order) {
  return new Set(String(due.metadataOf(order, 'billingNotices') || '').split(',').filter(Boolean));
}

/**
 * Records `keys` as sent on the order -- only if nobody else has written
 * its notices since it was read and it is still open. The record goes
 * first, so a second run sees it and does not send again.
 * @returns {Promise<string|null>} the notices as they were (for release), or null when lost
 */
async function claimNotices(order, keys, Model = PackageOrder) {
  const before = String(due.metadataOf(order, 'billingNotices') || '');
  const next = [...new Set([...before.split(',').filter(Boolean), ...keys])].join(',');
  const result = await Model.updateOne(
    { _id: order._id, ...due.OPEN, 'metadata.billingNotices': before ? before : { $in: [null, ''] } },
    { $set: { 'metadata.billingNotices': next } }
  );
  if (!result.modifiedCount) return null;
  if (order.metadata && typeof order.metadata.set === 'function') order.metadata.set('billingNotices', next);
  return before;
}

/** Gives a claim back after nothing was sent, so the next run tries again. */
async function releaseNotices(order, before) {
  const now = String(due.metadataOf(order, 'billingNotices') || '');
  await PackageOrder.updateOne({ _id: order._id, 'metadata.billingNotices': now }, { $set: { 'metadata.billingNotices': before } }).catch(() => {});
  if (order.metadata && typeof order.metadata.set === 'function') order.metadata.set('billingNotices', before);
}

/** The member's card for the gym's gateway, or why there is none. */
async function cardFor(order, provider) {
  if (!order.userId) return { method: null, reason: 'no member account' };
  const methods = await savedMethods.savedMethodsOf(order.userId);
  return savedMethods.autoPayMethod(methods, provider.id);
}

/**
 * The paid result of a charge, made sure of: a gateway that charged the
 * card has normally recorded the payment already (activation, invoice,
 * receipt); one that has not is recorded here, once, the same way the card
 * checkout records it -- activateOnce sends the receipt.
 */
async function settleCharge(order, reference) {
  const fresh = await PackageOrder.findById(order._id);
  if (!fresh || fresh.payment.status === 'paid') return { activated: false, order: fresh };
  const payments = require('../gymfolioPaymentService');
  return payments.activateOnce(fresh, async (o) => {
    o.payment.lastPaymentError = '';
    return { transactionId: reference || undefined };
  });
}

/** Marks a declined charge on the order, which stays open for the link. */
async function markDeclined(order, message, detail) {
  await PackageOrder.updateOne(
    { _id: order._id, ...due.OPEN },
    { $set: { 'payment.status': 'failed', 'payment.lastPaymentError': message, ...(detail ? { 'metadata.lastChargeError': String(detail).slice(0, 300) } : {}) } }
  );
  order.payment.status = 'failed';
  order.payment.lastPaymentError = message;
}

/**
 * Tries the due-date charge on one order. Returns what happened:
 * { outcome: 'paid' | 'pending' | 'declined' | 'skipped' | 'lost', ... }.
 */
async function chargeOnDueDate(order, ctx) {
  const dueDate = due.metadataOf(order, 'dueDate');
  const card = await cardFor(order, ctx.provider);
  if (!card.method && card.reason !== 'saved card expired') return { outcome: 'skipped', reason: card.reason };
  if (ctx.dryRun) return { outcome: 'dry run', card: card.method ? card.method.id : null, reason: card.reason || undefined };

  const claimed = await claimNotices(order, [`charge@${dueDate}`]);
  if (claimed === null) return { outcome: 'lost' };

  if (!card.method) {
    await markDeclined(order, CARD_EXPIRED);
    return { outcome: 'declined', reason: `${CARD_EXPIRED}.`, expired: true };
  }

  let result;
  try {
    result = await ctx.provider.chargeSavedMethod({
      order,
      amount: order.payment.amount,
      currency: String(order.payment.currency || '').toUpperCase(),
      savedMethod: card.method
    });
  } catch (error) {
    // A gateway that threw may or may not have charged: say pending, and
    // let its webhook settle it rather than send a link that could be paid twice.
    console.error(`[billing] charging ${order.orderNumber} failed:`, error.message);
    return { outcome: 'pending', reason: error.message };
  }
  const status = result && result.status;
  // The gateway's id for the charge: `reference` (services/payments), or a Safepay tracker.
  const reference = (result && (result.reference || result.tracker)) || null;
  if (status === 'paid') {
    await settleCharge(order, reference);
    return { outcome: 'paid', reference, card: card.method.id };
  }
  if (status === 'failed') {
    await markDeclined(order, DECLINED, result.reason);
    return { outcome: 'declined', reason: `${DECLINED}.`, detail: result.reason || '', card: card.method.id };
  }
  return { outcome: 'pending', reference, reason: (result && result.reason) || '' };
}

/** What today calls for on one open renewal order. */
async function processOrder(order, ctx) {
  const dueDate = due.metadataOf(order, 'dueDate');
  const lastDay = due.metadataOf(order, 'lastDay') || dueDate;
  const row = { order: order.orderNumber };
  if (!dueDate) return { ...row, skipped: 'no due date' };
  if (ctx.today > lastDay) return { ...row, skipped: 'past the last day to pay' };

  const member = order.userId ? await require('../../models/user').findById(order.userId).select('firstName lastName email phone isActive notificationPreferences').lean() : null;
  if (member && member.isActive === false) return { ...row, skipped: 'account disabled' };

  const notices = noticesOf(order);
  let declined = null;
  if (ctx.state.autoChargeOn && ctx.today >= dueDate && !notices.has(`charge@${dueDate}`)) {
    const charge = await chargeOnDueDate(order, ctx);
    row.charge = charge;
    if (charge.outcome === 'paid' || charge.outcome === 'pending' || charge.outcome === 'lost' || charge.outcome === 'dry run') return row;
    if (charge.outcome === 'declined') declined = charge;
  } else if (order.payment.status === 'failed' && notices.has(`charge@${dueDate}`) && !notices.has(`declined@${dueDate}`)) {
    // Declined on an earlier run whose message no channel took: still news.
    declined = { outcome: 'declined', reason: `${order.payment.lastPaymentError || DECLINED}.` };
  }

  const milestone = currentMilestone(milestonesFor(dueDate, lastDay, ctx.billing), ctx.today, lastDay);
  const kind = declined ? 'declined' : milestone && milestone.kind;
  const keys = [];
  if (declined) keys.push(`declined@${dueDate}`);
  if (milestone && !notices.has(`${milestone.key}@${dueDate}`)) keys.push(`${milestone.key}@${dueDate}`);
  if (!kind || !keys.length) return { ...row, skipped: milestone ? 'already sent' : 'nothing due today' };
  if (!declined && !ctx.state.remindersOn) return { ...row, skipped: 'reminders off' };

  // The member who will be charged on the due date is told so beforehand.
  let autoPayCard = '';
  if (kind === 'before' && ctx.state.autoChargeOn) {
    const card = await cardFor(order, ctx.provider);
    if (card.method) autoPayCard = require('./billingMessages').cardLabel(card.method);
  }

  if (ctx.dryRun) return { ...row, message: kind, milestone: milestone ? milestone.key : null, dryRun: true };
  // A declined charge has already written its own notice key.
  const before = await claimNotices(order, keys);
  if (before === null) return { ...row, skipped: 'sent by another run' };

  const { sendBillingMessage } = require('./billingMessages');
  const outcome = await sendBillingMessage(order, kind, {
    billing: ctx.billing,
    settings: ctx.settings,
    banks: ctx.banks,
    provider: ctx.provider,
    member,
    reason: declined ? declined.reason : '',
    autoPayCard
  });
  if (!outcome.any) {
    // Nothing went: tried again tomorrow (the charge itself is not retried).
    await releaseNotices(order, before);
    return { ...row, message: kind, sent: outcome.sent, skipped: outcome.skipped, failed: true };
  }
  return { ...row, message: kind, milestone: milestone ? milestone.key : null, sent: outcome.sent };
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
    remindersOn: state.remindersOn,
    autoChargeOn: state.autoChargeOn,
    provider: provider ? provider.id || 'online' : null,
    leadDays: leadDays(billing),
    closed: reviewed.closed,
    moved: reviewed.moved,
    created: [],
    skipped: [],
    sent: [],
    charged: [],
    declined: [],
    quiet: [],
    ...(dryRun ? { dryRun: true } : {})
  };
  if (!state.enabled) return withCounts(report);

  const made = await due.ensureDueRenewals({ billing, dryRun, now });
  report.created = made.created;
  report.skipped = made.skipped;

  // The orders made just now are due their first message today as well.
  const fresh = dryRun ? [] : await PackageOrder.find({ 'metadata.dueFor': { $type: 'string' }, ...due.OPEN, _id: { $nin: reviewed.open.map((o) => o.order._id) } });
  const ctx = { billing, settings, banks, provider, state, dryRun, now, today: T.dateKey(now) };
  for (const order of [...reviewed.open.map((o) => o.order), ...fresh]) {
    let row;
    try {
      row = await processOrder(order, ctx);
    } catch (error) {
      console.error(`[billing] ${order.orderNumber} failed:`, error);
      row = { order: order.orderNumber, error: error.message };
    }
    if (row.charge && row.charge.outcome === 'paid') report.charged.push(row);
    else if (row.charge && row.charge.outcome === 'declined') report.declined.push(row);
    if (row.message && !row.failed) report.sent.push(row);
    else if (!row.charge || row.charge.outcome !== 'paid') report.quiet.push(row);
  }
  return withCounts(report);
}

function withCounts(report) {
  report.counts = {
    created: report.created.length,
    closed: report.closed.length,
    skipped: report.skipped.length,
    sent: report.sent.length,
    charged: report.charged.length,
    declined: report.declined.length
  };
  return report;
}

module.exports = { runBillingJob, billingState, reviewOpenOrders, milestonesFor, currentMilestone, claimNotices, processOrder, DECLINED, CARD_EXPIRED };
