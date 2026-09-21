// src/gymfolio/services/membershipService.js
//
// Everything that happens to a membership after it is sold: activation with
// the right dates, freezing and resuming, cancelling, renewing, moving to a
// different package, using up sessions on a pack, and the bank-transfer
// approval path. The payment controllers and the Stripe webhook all come
// through here, so an order changes state in one place whatever paid for it.

const PackageOrder = require('../models/packageOrderModel');
const Package = require('../models/packageModel');
const Coupon = require('../models/couponModel');
const User = require('../../models/user');
const Settings = require('../../models/settings');
const { parseAmount, resolveCurrency, toMinorUnits } = require('../../helper/money');
const { getStripe } = require('../../services/stripeClient');
const { idOf, periodOf, paymentIntentOf } = require('./stripeShapes');
const T = require('../../attendance/services/timeUtils');

const DAY_MS = 86400000;
const MEMBERSHIP_KINDS = ['membership', 'session_pack', 'day_pass', 'trial', 'pt_pack'];

class MembershipError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function membershipSettings() {
  const settings = await Settings.getSettings().catch(() => null);
  const m = (settings && settings.membership) || {};
  return {
    allowMemberFreeze: m.allowMemberFreeze !== false,
    maxFreezeDays: Math.max(1, Number(m.maxFreezeDays) || 30),
    allowMemberCancel: m.allowMemberCancel !== false,
    settings
  };
}

/* ------------------------------ packages ------------------------------- */

/** The snapshot of a package that lives on the order for the rest of its life. */
function packageSnapshot(pkg) {
  const billing = pkg.billing || {};
  return {
    name: pkg.name,
    price: String(pkg.price),
    currency: pkg.currency,
    period: pkg.period || (billing.mode === 'recurring' ? billing.interval : 'month'),
    features: Array.isArray(pkg.features) ? pkg.features : [],
    kind: pkg.kind || 'membership',
    durationDays: Number(pkg.durationDays) || 0,
    sessions: Number(pkg.sessions) || 0,
    joiningFee: round2(pkg.joiningFee),
    billing: {
      mode: billing.mode || 'one_time',
      interval: billing.interval || 'month',
      intervalCount: Number(billing.intervalCount) || 1,
      trialDays: Number(billing.trialDays) || 0
    }
  };
}

/**
 * `months` calendar months after a date, on the gym's calendar and at the
 * same wall-clock time. A day the target month does not have is clamped to
 * its last day: a month from 31 January is 28 (or 29) February, not the 3rd
 * of March that Date#setMonth rolls over to.
 */
function addMonths(date, months) {
  const at = new Date(date);
  const p = T.localParts(at);
  const index = p.year * 12 + (p.month - 1) + Math.trunc(Number(months) || 0);
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const key = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(p.day, lastDay)).padStart(2, '0')}`;
  return T.localInstant(key, p.hour, p.minute, p.second, at.getUTCMilliseconds());
}

/** How long one term of this package lasts, from a start date. */
function termEnd(start, snapshot) {
  const end = new Date(start);
  const days = Number(snapshot.durationDays) || 0;
  if (days > 0) {
    end.setDate(end.getDate() + days);
    return end;
  }
  const billing = snapshot.billing || {};
  if (billing.mode === 'recurring') {
    const count = Number(billing.intervalCount) || 1;
    if (billing.interval === 'day') end.setDate(end.getDate() + count);
    else if (billing.interval === 'week') end.setDate(end.getDate() + 7 * count);
    else if (billing.interval === 'year') return addMonths(start, 12 * count);
    else return addMonths(start, count);
    return end;
  }
  const period = String(snapshot.period || 'month').toLowerCase();
  const n = parseInt(period, 10) || 1;
  if (period.includes('year')) return addMonths(start, 12 * n);
  else if (period.includes('week')) end.setDate(end.getDate() + 7 * n);
  else if (period.includes('day')) end.setDate(end.getDate() + n);
  else if (period.includes('month')) return addMonths(start, n);
  else end.setDate(end.getDate() + 30);
  return end;
}

/**
 * When a new membership for this person should start: after their current
 * one ends, if they have one. Renewing a week early must not throw the week
 * away. Packs and passes start straight away -- they sit alongside.
 */
async function startDateFor({ userId, email, kind = 'membership', now = new Date() }) {
  if (kind !== 'membership') return now;
  const owner = [];
  if (userId) owner.push({ userId });
  if (email) owner.push({ 'customerInfo.email': String(email).toLowerCase().trim() });
  if (!owner.length) return now;

  const latest = await PackageOrder.findOne({
    $or: owner,
    'payment.status': 'paid',
    status: { $in: ['active', 'frozen'] },
    $and: [{ $or: [{ 'packageDetails.kind': 'membership' }, { 'packageDetails.kind': { $exists: false } }] }],
    'subscription.endDate': { $gt: now }
  })
    .sort({ 'subscription.endDate': -1 })
    .select('subscription.endDate')
    .lean();

  return latest ? new Date(latest.subscription.endDate) : now;
}

/* ------------------------------- coupons ------------------------------- */

/**
 * Checks a code against a package and returns what it takes off.
 * @returns {Promise<{coupon, discount, total}>}  throws MembershipError when unusable
 */
async function applyCoupon(code, pkg, amount) {
  const clean = String(code || '').toUpperCase().trim();
  if (!clean) return { coupon: null, discount: 0, total: round2(amount) };

  const coupon = await Coupon.findOne({ code: clean });
  if (!coupon) throw new MembershipError('That code is not valid', 400, 'COUPON_INVALID');
  const problem = coupon.problem(pkg._id);
  if (problem) throw new MembershipError(problem, 400, 'COUPON_INVALID');
  if (coupon.type === 'amount' && coupon.currency && pkg.currency && coupon.currency !== String(pkg.currency).toUpperCase()) {
    throw new MembershipError('That code is for a different currency', 400, 'COUPON_INVALID');
  }

  const discount = round2(coupon.discountOn(amount));
  return { coupon, discount, total: round2(Math.max(0, amount - discount)) };
}

/**
 * Counts one use of a coupon, but never past its limit: the increment is
 * conditional on the count still being below maxRedemptions, so two orders
 * activating together cannot take the counter over the top.
 * @returns {Promise<boolean>} whether a redemption was recorded
 */
async function redeemCoupon(coupon) {
  if (!coupon) return false;
  const filter = { _id: coupon._id };
  if (Number(coupon.maxRedemptions) > 0) {
    // Older rows may have no counter yet; a missing one is zero.
    filter.$or = [{ redemptions: { $lt: Number(coupon.maxRedemptions) } }, { redemptions: { $exists: false } }];
  }
  const result = await Coupon.updateOne(filter, { $inc: { redemptions: 1 } });
  return (result.modifiedCount || 0) > 0;
}

/**
 * Refuses a second subscription for somebody who already has one running.
 * Only recurring memberships are checked: a session pack, day pass or trial
 * sits alongside whatever else the member has.
 *
 * "Recurring" on an existing order means a Stripe subscription behind it, or
 * autoRenew set -- a recurring package paid once by bank transfer is a term,
 * not a subscription, and does not block anything.
 */
async function assertNoActiveSubscription({ userId, email, snapshot } = {}) {
  const billing = (snapshot && snapshot.billing) || {};
  if (billing.mode !== 'recurring') return null;
  if (((snapshot && snapshot.kind) || 'membership') !== 'membership') return null;

  const owner = [];
  if (userId) owner.push({ userId });
  if (email) owner.push({ 'customerInfo.email': String(email).toLowerCase().trim() });
  if (!owner.length) return null;

  const existing = await PackageOrder.findOne({
    $or: owner,
    'payment.status': 'paid',
    status: { $in: ['active', 'frozen', 'past_due'] },
    $and: [{ $or: [{ 'payment.stripeSubscriptionId': { $nin: [null, ''] } }, { 'subscription.autoRenew': true }] }]
  })
    .select('orderNumber')
    .lean();

  if (existing) {
    throw new MembershipError('You already have an active subscription. Manage it from your account page.', 409, 'SUBSCRIPTION_EXISTS');
  }
  return null;
}

/* ----------------------------- activation ------------------------------ */

/**
 * Marks an order paid and activates it. Used by every payment path once the
 * money is confirmed: Stripe, an approved bank transfer, cash at the desk.
 */
async function markPaidAndActivate(order, { paidAt = new Date(), transactionId, startDate, endDate, method } = {}) {
  order.payment.status = 'paid';
  order.payment.paidAt = paidAt;
  order.payment.lastPaidAt = paidAt;
  if (transactionId) order.payment.transactionId = transactionId;
  if (method) order.payment.method = method;

  const snapshot = order.packageDetails || {};
  const start = startDate
    ? new Date(startDate)
    : await startDateFor({ userId: order.userId, email: order.customerInfo && order.customerInfo.email, kind: snapshot.kind || 'membership', now: paidAt });
  const end = endDate ? new Date(endDate) : termEnd(start, snapshot);

  order.subscription.startDate = start;
  order.subscription.endDate = end;
  order.subscription.renewalDate = end;
  order.subscription.isActive = true;
  order.status = 'active';

  if (snapshot.sessions > 0) {
    order.sessions = order.sessions || {};
    order.sessions.total = snapshot.sessions;
    order.sessions.used = order.sessions.used || 0;
  }

  if (order.payment.couponCode && !order.payment.couponRedeemed) {
    const coupon = await Coupon.findOne({ code: order.payment.couponCode });
    const counted = await redeemCoupon(coupon);
    if (coupon && !counted) {
      // The money is taken either way; the counter simply stops at the cap.
      console.warn(`[membership] coupon ${coupon.code} reached its redemption limit before ${order.orderNumber} activated`);
    }
    order.payment.couponRedeemed = true;
  }

  await order.save();

  try {
    const { ensureInvoice } = require('../../services/invoiceService');
    await ensureInvoice(order);
  } catch (error) {
    console.error('[membership] invoice number failed:', error.message);
  }
  return order;
}

/* ---------------------------- manual orders ---------------------------- */

/**
 * An order created by staff: cash or bank at the desk, a comped package, a
 * renewal, or an upgrade. Returns the saved order.
 */
async function createManualOrder({
  user,
  pkg,
  paymentMethod = 'cash',
  markPaid = true,
  notes = '',
  durationMonths,
  startDate,
  endDate,
  couponCode,
  amountOverride,
  discountAmount = 0,
  discountNote = '',
  renewedFrom = null,
  by = null
}) {
  const settings = await Settings.getSettings().catch(() => null);
  const listPrice = parseAmount(pkg.price);
  if (listPrice === null) {
    throw new MembershipError(
      `Package "${pkg.name}" has an unreadable price (${JSON.stringify(pkg.price)}). Fix it on the Packages screen first.`,
      422
    );
  }
  const currency = resolveCurrency(pkg.currency, settings && settings.currency);
  const snapshot = packageSnapshot(pkg);

  let amount = listPrice + (snapshot.joiningFee || 0);
  let coupon = null;
  let discount = round2(discountAmount);
  if (couponCode) {
    const applied = await applyCoupon(couponCode, pkg, listPrice);
    coupon = applied.coupon;
    discount = round2(discount + applied.discount);
  }
  amount = round2(Math.max(0, amount - discount));
  if (amountOverride !== undefined && amountOverride !== null && amountOverride !== '') {
    const override = parseAmount(amountOverride);
    if (override === null) throw new MembershipError('Amount must be a number', 400);
    amount = override;
  }

  const paid = markPaid !== false;
  const now = new Date();
  const start = startDate ? new Date(startDate) : await startDateFor({ userId: user._id, email: user.email, kind: snapshot.kind, now });
  let end = termEnd(start, snapshot);
  const months = Number(durationMonths);
  if (Number.isFinite(months) && months > 0) {
    end = addMonths(start, months);
  }
  // An explicit end wins over both -- imports carry the real expiry date.
  if (endDate) end = new Date(endDate);

  const addresses = Array.isArray(user.addresses) ? user.addresses : [];
  const address = addresses.find((a) => a.isDefault) || addresses[0];

  const order = new PackageOrder({
    orderNumber: await PackageOrder.generateOrderNumber(),
    userId: user._id,
    packageId: pkg._id,
    packageDetails: snapshot,
    customerInfo: {
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      email: user.email,
      phone: user.phone || '',
      country: (address && address.country) || ''
    },
    payment: {
      method: ['stripe', 'card', 'bank_transfer', 'cash'].includes(paymentMethod) ? paymentMethod : 'cash',
      amount,
      subtotal: round2(listPrice + (snapshot.joiningFee || 0)),
      discountAmount: discount,
      discountNote,
      couponCode: coupon ? coupon.code : '',
      currency: currency.toLowerCase(),
      status: paid ? 'paid' : 'pending',
      paidAt: paid ? now : undefined
    },
    subscription: {
      startDate: start,
      endDate: end,
      isActive: paid,
      autoRenew: false,
      renewalDate: end
    },
    sessions: snapshot.sessions > 0 ? { total: snapshot.sessions, used: 0 } : undefined,
    renewedFrom,
    status: paid ? 'active' : 'pending',
    notes: notes || `Created from the admin panel by ${by || 'an administrator'}`,
    createdBy: null
  });

  if (paid) {
    await markPaidAndActivate(order, { paidAt: now, startDate: start, endDate: end });
  } else {
    await order.save();
  }
  return order;
}

/* --------------------------- bank transfers ---------------------------- */

async function createBankTransferOrder({ user, pkg, customerInfo = {}, couponCode }) {
  const settings = await Settings.getSettings().catch(() => null);
  const listPrice = parseAmount(pkg.price);
  if (listPrice === null || listPrice <= 0) throw new MembershipError('This package cannot be bought online', 422);
  const currency = resolveCurrency(pkg.currency, settings && settings.currency);
  const snapshot = packageSnapshot(pkg);

  const { coupon, discount } = await applyCoupon(couponCode, pkg, listPrice);
  const amount = round2(Math.max(0, listPrice + (snapshot.joiningFee || 0) - discount));

  // The same rule as card checkout: one running subscription per member.
  await assertNoActiveSubscription({ userId: user._id, email: user.email, snapshot });

  const order = await PackageOrder.create({
    orderNumber: await PackageOrder.generateOrderNumber(),
    userId: user._id,
    packageId: pkg._id,
    packageDetails: snapshot,
    customerInfo: {
      fullName: customerInfo.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      email: user.email,
      phone: customerInfo.phone || user.phone || '',
      country: customerInfo.country || '',
      address: customerInfo.address || '',
      city: customerInfo.city || '',
      state: customerInfo.state || '',
      zipCode: customerInfo.zipCode || ''
    },
    payment: {
      method: 'bank_transfer',
      amount,
      subtotal: round2(listPrice + (snapshot.joiningFee || 0)),
      discountAmount: discount,
      couponCode: coupon ? coupon.code : '',
      currency: currency.toLowerCase(),
      status: 'pending'
    },
    status: 'pending'
  });
  return order;
}

async function submitTransferProof(order, { url, note, reference }) {
  if (order.payment.method !== 'bank_transfer') throw new MembershipError('This order was not paid by bank transfer', 400);
  if (order.payment.status === 'paid') throw new MembershipError('This order is already paid', 400);
  order.payment.proof = {
    url: url || (order.payment.proof && order.payment.proof.url) || '',
    note: note || '',
    reference: reference || '',
    uploadedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: ''
  };
  order.payment.status = 'processing';
  order.status = 'pending';
  await order.save();
  return order;
}

async function approveTransfer(order, { by }) {
  if (order.payment.status === 'paid') throw new MembershipError('This order is already paid', 400);
  order.payment.proof = { ...(order.payment.proof || {}), reviewedAt: new Date(), reviewedBy: by || null, rejectionReason: '' };
  await markPaidAndActivate(order, { paidAt: new Date() });
  return order;
}

async function rejectTransfer(order, { by, reason }) {
  if (order.payment.status === 'paid') throw new MembershipError('This order is already paid', 400);
  order.payment.proof = { ...(order.payment.proof || {}), reviewedAt: new Date(), reviewedBy: by || null, rejectionReason: reason || '' };
  order.payment.status = 'failed';
  order.status = 'cancelled';
  order.cancellation = { cancelledAt: new Date(), reason: reason || 'Bank transfer rejected', by: by || null, source: 'staff' };
  await order.save();
  return order;
}

/* ------------------------------ lifecycle ------------------------------ */

function assertActive(order) {
  if (order.payment.status !== 'paid') throw new MembershipError('This membership has not been paid for', 400);
  if (!['active', 'frozen', 'past_due'].includes(order.status)) {
    throw new MembershipError(`This membership is ${order.status}`, 400);
  }
}

/* ------------------------------- freezing ------------------------------ */
//
// A freeze pauses a membership for n days and gives the n days back: the
// end date moves out by n.
//
// On a Stripe subscription the next CHARGE has to move with it, or the two
// disagree. Pausing collection (pause_collection 'void', which this used to
// do) leaves Stripe's billing dates where they were and throws away any
// invoice falling inside the pause. A freeze inside one billing period lost
// the member their days -- the next invoice.paid overwrote the end date with
// Stripe's unmoved period end -- and one spanning a renewal voided that
// renewal: a period the gym never collected, with the member showing
// expired until Stripe's next charge.
//
// Instead the next charge is pushed back by n days, the way Stripe documents
// for moving a billing date: trial_end = the current period's end + n days,
// with proration_behavior 'none'. The member has paid up to the period's
// end; the n days after it are free, which is what the freeze gives them;
// Stripe then bills a full period from the new date, and every period after
// that from there. (Stripe issues, and settles, a 0 invoice for the free
// days straight away.) The end date here is set to that same instant, so
// every invoice.paid that follows agrees with it.
//
// Resuming early takes the unused whole days back off both: the charge moves
// earlier by the same number of days -- and if that is already past (the
// paid-for time ran out during the freeze) the trial ends now and Stripe
// bills the next period at once. Resuming on schedule changes nothing at
// Stripe: it already charges on the end date.
//
// This relies on classic billing mode, the default for the API version
// stripeClient pins. Under flexible mode a trial does not move the billing
// anchor, so the push would be followed by a part-period charge; such a
// subscription is refused rather than guessed at.

const FREEZE_STRIPE = 'stripe_trial';
const FREEZE_LOCAL = 'local';

// Subscriptions whose next charge can be moved, and those Stripe will never
// charge again (a freeze of those is only a date here, as for cash).
const STRIPE_MOVABLE = new Set(['active', 'trialing']);
const STRIPE_ENDED = new Set(['canceled', 'incomplete_expired']);

// Kept on the subscription's metadata: `${freeze number}:${days}:${trial_end}`.
// A freeze whose Stripe half went through but whose record here failed to
// save is tried again from the same starting point, rather than pushed twice.
const FREEZE_MARKER = 'gympilot_freeze';

// A billing date this close is not worth a trial: Stripe bills now instead.
const TRIAL_END_MARGIN_MS = 5 * 60 * 1000;
const DAY_S = DAY_MS / 1000;

/** The freeze marker on a subscription's metadata, or null. */
function readFreezeMarker(metadata) {
  const match = /^(\d+):(\d+):(\d+)$/.exec(String((metadata && metadata[FREEZE_MARKER]) || ''));
  return match ? { seq: Number(match[1]), days: Number(match[2]), trialEnd: Number(match[3]) } : null;
}

/**
 * Where freezing for `days` moves Stripe's next charge, in Unix seconds:
 * `days` after `periodEnd`, when Stripe would otherwise charge. When this
 * same freeze (`seq`, its number on the order) already reached Stripe, the
 * push starts from where that attempt started.
 */
function freezeTrialEnd({ periodEnd, days, seq, marker = null }) {
  const base = marker && marker.seq === seq ? marker.trialEnd - marker.days * DAY_S : Math.floor(new Date(periodEnd).getTime() / 1000);
  return base + days * DAY_S;
}

/**
 * Where resuming early moves Stripe's next charge: `unusedDays` before
 * `pushedTo` (Unix seconds), or 'now' when that is past or all but.
 */
function resumeTrialEnd({ pushedTo, unusedDays, now = new Date() }) {
  const target = pushedTo - unusedDays * DAY_S;
  return target * 1000 > now.getTime() + TRIAL_END_MARGIN_MS ? target : 'now';
}

/**
 * Moving the billing date makes Stripe issue a 0 invoice for the free days.
 * It is not a renewal: recorded as the order's latest invoice, the
 * invoice.paid for it is recognised as already seen, rather than filed as a
 * renewal of nothing with the member told their membership renewed. Only an
 * invoice that is new and for nothing is taken -- a real renewal whose
 * webhook is still on its way must not be marked as seen.
 */
function adoptZeroInvoice(order, updated, previousInvoiceId) {
  const invoice = updated && updated.latest_invoice;
  if (!invoice || typeof invoice !== 'object' || !invoice.id) return;
  if (invoice.id === previousInvoiceId || invoice.id === order.payment.stripeInvoiceId) return;
  if (Number(invoice.total) !== 0 || Number(invoice.amount_paid || 0) !== 0) return;
  order.payment.stripeInvoiceId = invoice.id;
}

function stripeEndOf(updated, trialEnd) {
  const seconds = (updated && Number(updated.trial_end)) || trialEnd;
  return new Date(seconds * 1000);
}

/**
 * Pushes a Stripe subscription's next charge back by `days` for a freeze.
 * @returns {Promise<Date|null>} the new billing date, which is the
 *   membership's new end date; null when Stripe will not charge this
 *   subscription again
 * @throws {MembershipError} 409 when the subscription's billing cannot be moved
 */
async function pushStripeCharge(order, { days, seq }) {
  const subId = order.payment.stripeSubscriptionId;
  const stripe = await getStripe();
  const sub = await stripe.subscriptions.retrieve(subId);

  if (STRIPE_ENDED.has(sub.status)) return null;
  if (!STRIPE_MOVABLE.has(sub.status)) {
    throw new MembershipError(
      'There is a card payment outstanding on this membership. It can be frozen once that payment has gone through.',
      409,
      'FREEZE_PAYMENT_OUTSTANDING'
    );
  }
  if (sub.pause_collection) {
    throw new MembershipError('Card payments for this membership are paused in Stripe. Resume them there before freezing it here.', 409, 'FREEZE_STRIPE_PAUSED');
  }
  if (sub.billing_mode && sub.billing_mode.type === 'flexible') {
    throw new MembershipError(
      "This card subscription uses Stripe's flexible billing mode, where a freeze cannot move the billing date. Change the billing date in the Stripe dashboard instead.",
      409,
      'FREEZE_STRIPE_UNSUPPORTED'
    );
  }
  const periodEnd = periodOf(sub).end;
  if (!periodEnd) {
    throw new MembershipError('Stripe did not say when this membership is next billed, so it has not been frozen. Try again in a moment.', 502, 'FREEZE_STRIPE_UNREADABLE');
  }

  const trialEnd = freezeTrialEnd({ periodEnd, days, seq, marker: readFreezeMarker(sub.metadata) });
  const updated = await stripe.subscriptions.update(subId, {
    trial_end: trialEnd,
    proration_behavior: 'none',
    metadata: { [FREEZE_MARKER]: `${seq}:${days}:${trialEnd}` },
    expand: ['latest_invoice']
  });
  adoptZeroInvoice(order, updated, idOf(sub.latest_invoice));
  order.subscription.stripeStatus = (updated && updated.status) || 'trialing';
  return stripeEndOf(updated, trialEnd);
}

/**
 * Resuming a Stripe freeze early: the next charge comes back by the unused
 * days.
 * @returns {Promise<{ endDate: Date, billedNow: boolean }|null>} null when
 *   Stripe will not charge again (the local rule applies)
 */
async function pullStripeCharge(order, { unusedDays, now }) {
  const subId = order.payment.stripeSubscriptionId;
  const stripe = await getStripe();
  const sub = await stripe.subscriptions.retrieve(subId);

  if (STRIPE_ENDED.has(sub.status)) return null;
  if (sub.status !== 'trialing') {
    // The pushed date was ended at Stripe and it has billed again: its
    // billing date stands.
    const end = periodOf(sub).end;
    return end ? { endDate: end, billedNow: false } : null;
  }

  // Where this freeze pushed the charge -- read from the marker, so a resume
  // retried after its record failed to save does not pull it back twice.
  const history = (order.freeze && order.freeze.history) || [];
  const marker = readFreezeMarker(sub.metadata);
  const pushedTo =
    marker && marker.seq === history.length - 1 ? marker.trialEnd : Math.floor(new Date(order.subscription.endDate).getTime() / 1000);
  const trialEnd = resumeTrialEnd({ pushedTo, unusedDays, now });

  if (trialEnd === 'now') {
    // The time paid for ran out while frozen: Stripe bills the next period
    // now, and its invoice.paid moves the end date on.
    const updated = await stripe.subscriptions.update(subId, { trial_end: 'now', proration_behavior: 'none' });
    order.subscription.stripeStatus = (updated && updated.status) || 'active';
    return { endDate: now, billedNow: true };
  }

  const updated = await stripe.subscriptions.update(subId, { trial_end: trialEnd, proration_behavior: 'none', expand: ['latest_invoice'] });
  adoptZeroInvoice(order, updated, idOf(sub.latest_invoice));
  order.subscription.stripeStatus = (updated && updated.status) || 'trialing';
  return { endDate: stripeEndOf(updated, trialEnd), billedNow: false };
}

async function freeze(order, { days, reason = '', by = null, source = 'staff' }) {
  assertActive(order);
  if (order.status === 'frozen') throw new MembershipError('This membership is already frozen', 400);
  const { allowMemberFreeze, maxFreezeDays } = await membershipSettings();
  if (source === 'member' && !allowMemberFreeze) throw new MembershipError('Freezing is not available online. Please ask at reception.', 403);

  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) throw new MembershipError('Freeze for at least one day', 400);
  if (source === 'member' && n > maxFreezeDays) throw new MembershipError(`Memberships can be frozen for up to ${maxFreezeDays} days`, 400);

  const now = new Date();
  const resumeAt = new Date(now.getTime() + n * DAY_MS);
  order.freeze = order.freeze || {};
  order.freeze.history = order.freeze.history || [];

  // Cash and bank terms -- and a subscription Stripe will not charge again
  // -- simply end n days later. A live Stripe subscription ends when Stripe
  // next charges, which the freeze has just pushed back.
  let endDate = new Date(new Date(order.subscription.endDate).getTime() + n * DAY_MS);
  let billing = FREEZE_LOCAL;
  if (order.payment.stripeSubscriptionId) {
    const pushedTo = await pushStripeCharge(order, { days: n, seq: order.freeze.history.length });
    if (pushedTo) {
      endDate = pushedTo;
      billing = FREEZE_STRIPE;
    }
  }

  order.freeze.isFrozen = true;
  order.freeze.frozenAt = now;
  order.freeze.resumeAt = resumeAt;
  order.freeze.reason = reason;
  order.freeze.billing = billing;
  order.freeze.totalFrozenDays = (order.freeze.totalFrozenDays || 0) + n;
  order.freeze.history.push({ from: now, to: resumeAt, days: n, reason, by, source });
  order.subscription.endDate = endDate;
  order.subscription.renewalDate = endDate;
  order.status = 'frozen';
  await order.save();
  return order;
}

async function unfreeze(order, { by = null, source = 'staff' } = {}) {
  if (order.status !== 'frozen') throw new MembershipError('This membership is not frozen', 400);

  const now = new Date();
  const resumeAt = order.freeze && order.freeze.resumeAt ? new Date(order.freeze.resumeAt) : now;
  // Days handed back for resuming early: the end date moves back by the
  // part of the freeze that was not used.
  const unused = resumeAt > now ? Math.ceil((resumeAt.getTime() - now.getTime()) / DAY_MS) : 0;
  const billing = (order.freeze && order.freeze.billing) || '';
  const subId = order.payment.stripeSubscriptionId;

  let endDate = new Date(new Date(order.subscription.endDate).getTime() - unused * DAY_MS);
  let billedNow = false;
  if (subId && billing === FREEZE_STRIPE) {
    // ... and so does the next charge. On schedule there is nothing to do:
    // Stripe already charges on the end date.
    if (unused > 0) {
      const moved = await pullStripeCharge(order, { unusedDays: unused, now });
      if (moved) ({ endDate, billedNow } = moved);
    }
  } else if (subId && !billing) {
    // A freeze from before charges were moved: Stripe collection was paused.
    const stripe = await getStripe();
    await stripe.subscriptions.update(subId, { pause_collection: '' });
  }

  if (unused > 0) {
    order.subscription.endDate = endDate;
    order.subscription.renewalDate = endDate;
    order.freeze.totalFrozenDays = Math.max(0, (order.freeze.totalFrozenDays || 0) - unused);
  }
  order.freeze.isFrozen = false;
  order.freeze.resumeAt = null;
  const last = order.freeze.history && order.freeze.history[order.freeze.history.length - 1];
  if (last) {
    last.to = now;
    last.days = Math.max(0, (last.days || 0) - unused);
    last.resumedBy = by;
  }
  // Billed now: live, as at any renewal, until Stripe says how the charge went.
  order.status = billedNow || new Date(order.subscription.endDate) > now ? 'active' : 'expired';
  order.subscription.isActive = order.status === 'active';
  await order.save();
  return order;
}

/** Freezes whose planned end has passed are switched back on. Run daily. */
async function resumeDueFreezes(now = new Date()) {
  const due = await PackageOrder.find({ status: 'frozen', 'freeze.resumeAt': { $ne: null, $lte: now } });
  let resumed = 0;
  for (const order of due) {
    try {
      await unfreeze(order, { source: 'system' });
      resumed += 1;
    } catch (error) {
      console.error(`[membership] auto-resume ${order.orderNumber} failed:`, error.message);
    }
  }
  return { resumed };
}

/**
 * Cancels a membership.
 *
 * `immediate` ends access now. Otherwise the member keeps what they paid for
 * until the end date and simply is not renewed -- on Stripe, cancel at
 * period end; otherwise a flag and the expiry job does the rest.
 */
async function cancel(order, { reason = '', by = null, source = 'staff', immediate = false }) {
  if (order.status === 'cancelled') throw new MembershipError('This membership is already cancelled', 400);
  const { allowMemberCancel } = await membershipSettings();
  if (source === 'member' && !allowMemberCancel) throw new MembershipError('Cancellation is handled at reception. Please contact the gym.', 403);
  if (source === 'member' && immediate) immediate = false;

  const now = new Date();
  const subId = order.payment.stripeSubscriptionId;

  if (subId) {
    const stripe = await getStripe();
    if (immediate) {
      await stripe.subscriptions.cancel(subId).catch((error) => {
        if (!/No such subscription|already been canceled/i.test(error.message)) throw error;
      });
    } else {
      await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    }
  }

  order.cancellation = { cancelledAt: now, reason, by, source, immediate };
  order.subscription.autoRenew = false;
  order.subscription.cancelAtPeriodEnd = !immediate;

  if (immediate || order.payment.status !== 'paid' || !order.subscription.endDate || new Date(order.subscription.endDate) <= now) {
    order.status = 'cancelled';
    order.subscription.isActive = false;
    if (immediate && order.payment.status === 'paid') order.subscription.endDate = now;
  }
  await order.save();
  return order;
}

/** Undoes a cancel-at-period-end before the period has ended. */
async function resume(order, { by = null } = {}) {
  if (!order.subscription.cancelAtPeriodEnd || order.status === 'cancelled') {
    throw new MembershipError('This membership is not scheduled to cancel', 400);
  }
  if (order.payment.stripeSubscriptionId) {
    const stripe = await getStripe();
    await stripe.subscriptions.update(order.payment.stripeSubscriptionId, { cancel_at_period_end: false });
  }
  order.subscription.cancelAtPeriodEnd = false;
  order.subscription.autoRenew = !!order.payment.stripeSubscriptionId;
  order.cancellation = { cancelledAt: null, reason: '', by, source: 'staff', immediate: false, resumedAt: new Date() };
  await order.save();
  return order;
}

/** A fresh term of the same package, starting when the current one ends. */
async function renew(order, { paymentMethod = 'cash', markPaid = true, months, notes, by } = {}) {
  const [user, pkg] = await Promise.all([User.findById(order.userId), Package.findById(order.packageId)]);
  if (!user) throw new MembershipError('The member account no longer exists', 404);
  if (!pkg) throw new MembershipError('The package no longer exists; assign a current one instead', 404);

  const now = new Date();
  const currentEnd = order.subscription && order.subscription.endDate ? new Date(order.subscription.endDate) : null;
  const start = currentEnd && currentEnd > now && ['active', 'frozen'].includes(order.status) ? currentEnd : now;

  return createManualOrder({
    user,
    pkg,
    paymentMethod,
    markPaid,
    durationMonths: months,
    startDate: start,
    notes: notes || `Renewal of ${order.orderNumber}`,
    renewedFrom: order._id,
    by
  });
}

/**
 * Moves a member to a different package. The unused part of what they paid
 * comes off the new price (pro rata by days). On a Stripe subscription the
 * subscription itself is switched and Stripe prorates.
 */
async function changePackage(order, { packageId, paymentMethod = 'cash', markPaid = true, notes, by } = {}) {
  assertActive(order);
  const [user, pkg] = await Promise.all([User.findById(order.userId), Package.findById(packageId)]);
  if (!user) throw new MembershipError('The member account no longer exists', 404);
  if (!pkg) throw new MembershipError('Package not found', 404);
  if (String(pkg._id) === String(order.packageId)) throw new MembershipError('That is the package they already have', 400);

  const now = new Date();
  const start = new Date(order.subscription.startDate || order.createdAt);
  const end = new Date(order.subscription.endDate);
  const totalDays = Math.max(1, (end - start) / DAY_MS);
  const remainingDays = Math.max(0, (end - now) / DAY_MS);
  const credit = round2((order.payment.amount || 0) * (remainingDays / totalDays));

  if (order.payment.stripeSubscriptionId) {
    const stripe = await getStripe();
    const sub = await stripe.subscriptions.retrieve(order.payment.stripeSubscriptionId);
    const item = sub.items.data[0];
    const snapshot = packageSnapshot(pkg);
    const { toMinorUnits } = require('../../helper/money');
    const settings = await Settings.getSettings().catch(() => null);
    const currency = resolveCurrency(pkg.currency, settings && settings.currency).toLowerCase();
    const updated = await stripe.subscriptions.update(sub.id, {
      items: [
        {
          id: item.id,
          price_data: {
            currency,
            product_data: { name: `${pkg.name} Package` },
            unit_amount: toMinorUnits(parseAmount(pkg.price), currency),
            recurring: { interval: snapshot.billing.interval, interval_count: snapshot.billing.intervalCount }
          }
        }
      ],
      proration_behavior: 'create_prorations'
    });
    order.packageId = pkg._id;
    // The new price lives in the snapshot, and Stripe charges it from here
    // on; each of those charges is recorded as a renewal with its own amount.
    // payment.amount is what was actually paid at the start and stays put --
    // overwriting it rewrote revenue already reported.
    order.packageDetails = snapshot;
    // periodOf reads the period from wherever the API version put it.
    order.subscription.endDate = periodOf(updated).end || order.subscription.endDate;
    order.subscription.renewalDate = order.subscription.endDate;
    order.notes = `${order.notes || ''}\nSwitched package on ${now.toISOString().slice(0, 10)} by ${by || 'staff'}`.trim();
    await order.save();
    return { order, previous: null, credit: null };
  }

  const replacement = await createManualOrder({
    user,
    pkg,
    paymentMethod,
    markPaid,
    startDate: now,
    discountAmount: credit,
    discountNote: `Credit for ${Math.floor(remainingDays)} unused day(s) of ${order.packageDetails && order.packageDetails.name}`,
    notes: notes || `Changed from ${order.orderNumber} (${order.packageDetails && order.packageDetails.name})`,
    renewedFrom: order._id,
    by
  });

  order.status = 'cancelled';
  order.subscription.isActive = false;
  order.subscription.endDate = now;
  order.cancellation = { cancelledAt: now, reason: `Changed to ${pkg.name} (${replacement.orderNumber})`, by, source: 'staff', immediate: true };
  await order.save();

  return { order: replacement, previous: order, credit };
}

/* ------------------------------- sessions ------------------------------ */

/**
 * Uses one session of a pack. Returns the updated order, or null when the
 * order is not a pack.
 *
 * The credit is taken with one conditional update -- "increment used, but
 * only while used is still below total" -- rather than read, add one, save.
 * Two bookings for the last session arriving together used to both succeed
 * on a pack that had one left; now the second one finds nothing to take.
 */
async function consumeSession(order, { by = null, note = '' } = {}) {
  if (!order.sessions || !order.sessions.total) return null;
  assertActive(order);
  const total = Number(order.sessions.total) || 0;
  if ((order.sessions.used || 0) >= total) throw new MembershipError('No sessions left on this pack', 400);

  const now = new Date();
  const updated = await PackageOrder.findOneAndUpdate(
    {
      _id: order._id,
      'payment.status': 'paid',
      status: { $in: ['active', 'frozen', 'past_due'] },
      'sessions.total': total,
      'sessions.used': { $lt: total }
    },
    { $inc: { 'sessions.used': 1 }, $push: { 'sessions.log': { at: now, by, note } } },
    { new: true }
  );

  if (!updated) {
    // Somebody got there first: re-read to say exactly why.
    const fresh = await PackageOrder.findById(order._id);
    if (!fresh || !fresh.sessions || !fresh.sessions.total) return null;
    assertActive(fresh);
    throw new MembershipError('No sessions left on this pack', 400);
  }

  if ((updated.sessions.used || 0) >= (updated.sessions.total || 0)) {
    // The last one: the pack is spent. Conditional again, so only the taker
    // of the final session closes it.
    await PackageOrder.updateOne(
      { _id: order._id, 'sessions.exhaustedAt': null, 'sessions.used': { $gte: updated.sessions.total } },
      { $set: { 'sessions.exhaustedAt': now, status: 'expired', 'subscription.isActive': false } }
    );
    updated.sessions.exhaustedAt = now;
    updated.status = 'expired';
    updated.subscription.isActive = false;
  }

  // Keep the caller's document in step with what was written, since most
  // callers go on reading the one they passed in.
  order.sessions = updated.sessions;
  order.status = updated.status;
  order.subscription.isActive = updated.subscription.isActive;
  return updated;
}

/**
 * Gives a session back -- a booking cancelled in time, a class the gym called
 * off. Returns the updated order (the one passed in when there was nothing to
 * give back), or null when the order is not a pack.
 *
 * One conditional update, like consumeSession: "decrement used, but only
 * while it is above zero". Subtracting one from the copy the caller read and
 * saving it wrote that copy's count back, wiping out a session a booking had
 * taken from the same pack in between.
 */
async function refundSession(order) {
  if (!order.sessions || !order.sessions.total) return null;

  const now = new Date();
  let updated = await PackageOrder.findOneAndUpdate(
    { _id: order._id, 'sessions.used': { $gt: 0 } },
    { $inc: { 'sessions.used': -1 }, $push: { 'sessions.log': { at: now, by: null, note: 'refunded' } } },
    { new: true }
  );
  if (!updated) return order;

  // A pack that had just run out is live again. Conditional too: if a
  // booking has already taken the session straight back, it stays spent.
  const total = Number(updated.sessions.total) || 0;
  if (updated.sessions.exhaustedAt && (updated.sessions.used || 0) < total) {
    const set = { 'sessions.exhaustedAt': null };
    const endDate = updated.subscription && updated.subscription.endDate;
    if (updated.status === 'expired' && endDate && new Date(endDate) >= now) {
      set.status = 'active';
      set['subscription.isActive'] = true;
    }
    const reopened = await PackageOrder.findOneAndUpdate(
      { _id: order._id, status: updated.status, 'sessions.exhaustedAt': { $ne: null }, 'sessions.used': { $lt: total } },
      { $set: set },
      { new: true }
    );
    if (reopened) updated = reopened;
  }

  // Keep the caller's document in step with what was written.
  order.sessions = updated.sessions;
  order.status = updated.status;
  if (order.subscription && updated.subscription) order.subscription.isActive = updated.subscription.isActive;
  return updated;
}

/* -------------------------------- refunds ------------------------------ */

function fromMinorUnits(amount, currency) {
  // toMinorUnits(1) is 100 for a two-decimal currency and 1 for a
  // zero-decimal one, which is exactly the scale to divide by.
  const scale = toMinorUnits(1, currency) || 100;
  return round2((Number(amount) || 0) / scale);
}

// The PaymentIntent that took the money for this order, found wherever the
// order's Stripe trail leads: the intent itself for a one-off sale; the
// invoice, the Checkout session or the subscription for a recurring one.
async function refundablePaymentIntent(stripe, order) {
  const p = order.payment || {};
  if (p.stripePaymentIntentId) return p.stripePaymentIntentId;

  if (p.stripeInvoiceId) {
    const invoice = await stripe.invoices.retrieve(p.stripeInvoiceId).catch(() => null);
    const intent = paymentIntentOf(invoice);
    if (intent) return intent;
  }

  if (p.stripeSessionId) {
    const session = await stripe.checkout.sessions
      .retrieve(p.stripeSessionId, { expand: ['subscription.latest_invoice'] })
      .catch(() => null);
    if (session) {
      const direct = idOf(session.payment_intent);
      if (direct) return direct;
      const sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
      const invoice = sub && sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
      const intent = paymentIntentOf(invoice);
      if (intent) return intent;
    }
  }

  if (p.stripeSubscriptionId) {
    const sub = await stripe.subscriptions.retrieve(p.stripeSubscriptionId, { expand: ['latest_invoice'] }).catch(() => null);
    const invoice = sub && sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
    const intent = paymentIntentOf(invoice);
    if (intent) return intent;

    // The latest invoice can be one that charged nothing -- the 0 invoice a
    // freeze leaves when it moves the billing date -- so look back for the
    // subscription's last real charge.
    let paid = null;
    try {
      paid = await stripe.invoices.list({ subscription: p.stripeSubscriptionId, status: 'paid', limit: 10 });
    } catch {
      paid = null;
    }
    for (const candidate of (paid && paid.data) || []) {
      if (!(Number(candidate.amount_paid) > 0)) continue;
      const charged = paymentIntentOf(candidate);
      if (charged) return charged;
    }
  }

  return null;
}

// How long a refund under way holds its order. Far longer than the Stripe
// calls behind it can take: a claim older than this was left by a process
// that stopped part-way, and the next attempt may take it over.
const REFUND_CLAIM_MS = 15 * 60 * 1000;

/**
 * Refunds a paid order and ends the membership it bought.
 *
 * Card payments are refunded at Stripe (the whole charge unless `amount`
 * says otherwise); cash, bank and terminal payments are simply recorded as
 * refunded -- the money moves by hand. Either way the order's subscription,
 * if it has one at Stripe, is cancelled, and the refund is kept on the order.
 *
 * An order is refunded once: afterwards it is 'refunded', partial or not.
 */
async function refund(order, { amount, reason = '', by = null } = {}) {
  if (order.payment.status === 'refunded') throw new MembershipError('This order has already been refunded', 400);
  if (order.payment.status !== 'paid') throw new MembershipError('Only a paid order can be refunded', 400);

  const paidAmount = round2(order.payment.amount);
  let wanted = null;
  if (amount !== undefined && amount !== null && amount !== '') {
    wanted = parseAmount(amount);
    if (wanted === null || wanted <= 0) throw new MembershipError('The refund amount must be a positive number', 400);
    if (wanted > paidAmount) throw new MembershipError(`The refund cannot exceed the ${paidAmount} that was paid`, 400);
  }

  const currency = String(order.payment.currency || '').toLowerCase();
  const now = new Date();
  const record = {
    amount: wanted === null ? paidAmount : round2(wanted),
    reason: String(reason || '').trim(),
    at: now,
    byUserId: by || null,
    stripeRefundId: null
  };

  const viaStripe =
    order.payment.method === 'stripe' || !!order.payment.stripePaymentIntentId || !!order.payment.stripeSessionId;

  // Claim the order before any money moves. The checks above read the copy
  // the caller loaded, and two refunds sent together (a double click, two
  // members of staff) both passed them and both refunded at Stripe. Only
  // the request that sets the claim goes on.
  const claimedAt = new Date();
  const claim = await PackageOrder.updateOne(
    {
      _id: order._id,
      'payment.status': 'paid',
      $or: [{ 'refund.claimedAt': null }, { 'refund.claimedAt': { $lt: new Date(claimedAt.getTime() - REFUND_CLAIM_MS) } }]
    },
    { $set: { 'refund.claimedAt': claimedAt } }
  );
  if (!claim.matchedCount) {
    const fresh = await PackageOrder.findById(order._id).select('payment.status').lean();
    const status = fresh && fresh.payment ? fresh.payment.status : null;
    if (status === 'refunded') throw new MembershipError('This order has already been refunded', 400);
    if (status !== 'paid') throw new MembershipError('Only a paid order can be refunded', 400);
    throw new MembershipError('This order is already being refunded', 409);
  }

  try {
    if (viaStripe) {
      const stripe = await getStripe();
      const intentId = await refundablePaymentIntent(stripe, order);
      if (!intentId) {
        throw new MembershipError('Could not find the Stripe payment behind this order. Refund it from the Stripe dashboard.', 409);
      }
      const params = { payment_intent: intentId };
      // A full refund is left to Stripe to size: the charge may have been
      // smaller than payment.amount if a Stripe promotion code was used.
      if (wanted !== null) params.amount = toMinorUnits(wanted, currency);
      // Asking again for the same refund of the same order -- a retry after
      // a timeout, or after a claim a stopped process left behind -- gets
      // back the refund Stripe already made instead of making a second.
      const idempotencyKey = `refund-${order._id}-${params.amount === undefined ? 'full' : params.amount}`;
      const stripeRefund = await stripe.refunds.create(params, { idempotencyKey });
      record.stripeRefundId = stripeRefund.id;
      if (stripeRefund.amount !== undefined && stripeRefund.amount !== null) {
        record.amount = fromMinorUnits(stripeRefund.amount, stripeRefund.currency || currency);
      }
    }

    // A refunded term is not one the member keeps: end it now, and stop the
    // subscription behind it renewing.
    if (order.status !== 'cancelled') {
      await cancel(order, { reason: record.reason || 'Refunded', by, source: 'staff', immediate: true });
    } else if (order.payment.stripeSubscriptionId) {
      // Cancelled at period end earlier, so the subscription at Stripe is
      // still running until then.
      const stripe = await getStripe();
      await stripe.subscriptions.cancel(order.payment.stripeSubscriptionId).catch((error) => {
        if (!/No such subscription|already been canceled/i.test(error.message)) throw error;
      });
      order.subscription.autoRenew = false;
      order.subscription.cancelAtPeriodEnd = false;
    }

    // Finished only while the claim is still this request's; writing the
    // whole refund block also clears the claim.
    const finished = await PackageOrder.updateOne(
      { _id: order._id, 'payment.status': 'paid', 'refund.claimedAt': claimedAt },
      {
        $set: {
          'payment.status': 'refunded',
          status: 'cancelled',
          'subscription.isActive': false,
          'subscription.autoRenew': order.subscription.autoRenew,
          'subscription.cancelAtPeriodEnd': order.subscription.cancelAtPeriodEnd,
          refund: record
        }
      }
    );
    if (!finished.matchedCount) {
      // Only when this refund outlived its claim and another attempt took
      // the order over; that attempt records the refund.
      console.error(`[membership] refund of ${order.orderNumber} finished after its claim was taken over; check it against Stripe`);
    }
  } catch (error) {
    // Let go, so the refund can be tried again rather than the order being
    // stuck as under way. If the money did go back at Stripe before the
    // failure, the idempotency key turns the retry into the same refund.
    await PackageOrder.updateOne(
      { _id: order._id, 'refund.claimedAt': claimedAt },
      { $unset: { 'refund.claimedAt': 1 } }
    ).catch(() => {});
    throw error;
  }

  order.payment.status = 'refunded';
  order.status = 'cancelled';
  order.subscription.isActive = false;
  order.refund = record;
  return order;
}

/* ---------------------------- stripe portal ---------------------------- */

async function billingPortalUrl(order, returnUrl) {
  if (!order.payment.stripeCustomerId) throw new MembershipError('There is no card on file for this membership', 400);
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: order.payment.stripeCustomerId,
    return_url: returnUrl
  });
  return session.url;
}

module.exports = {
  MembershipError,
  MEMBERSHIP_KINDS,
  packageSnapshot,
  addMonths,
  termEnd,
  startDateFor,
  applyCoupon,
  redeemCoupon,
  assertNoActiveSubscription,
  markPaidAndActivate,
  createManualOrder,
  createBankTransferOrder,
  submitTransferProof,
  approveTransfer,
  rejectTransfer,
  freeze,
  unfreeze,
  resumeDueFreezes,
  FREEZE_STRIPE,
  FREEZE_LOCAL,
  FREEZE_MARKER,
  readFreezeMarker,
  freezeTrialEnd,
  resumeTrialEnd,
  cancel,
  resume,
  renew,
  changePackage,
  consumeSession,
  refundSession,
  refund,
  billingPortalUrl,
  membershipSettings
};
