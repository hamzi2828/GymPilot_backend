// src/gymfolio/services/membershipService.js
//
// Everything that happens to a membership after it is sold: activation with
// the right dates, freezing and resuming, cancelling, renewing, moving to a
// different package, using up sessions on a pack, and the bank-transfer
// approval path. The payment controllers and the Stripe webhook all come
// through here, so an order changes state in one place whatever paid for it.

const mongoose = require('mongoose');
const PackageOrder = require('../models/packageOrderModel');
const Package = require('../models/packageModel');
const Coupon = require('../models/couponModel');
const Trainer = require('../models/trainerModel');
const User = require('../../models/user');
const Settings = require('../../models/settings');
const { parseAmount, resolveCurrency, toMinorUnits, fromMinorUnits } = require('../../helper/money');
const { getStripe } = require('../../services/stripeClient');
const { idOf, periodOf, paymentIntentOf } = require('./stripeShapes');
const { readDeskMethod } = require('../../services/paymentMethods');
const { allocate, paidSoFar, partsSoFar, nextPart } = require('./orderMoney');
const T = require('../../attendance/services/timeUtils');

const DAY_MS = 86400000;
const MEMBERSHIP_KINDS = ['membership', 'session_pack', 'day_pass', 'trial', 'pt_pack'];

class MembershipError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    // Handlers outside this module tell these apart by name (the class
    // booking and personal training controllers), not by instanceof.
    this.name = 'MembershipError';
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

/**
 * The snapshot of a package that lives on the order for the rest of its life.
 * `currency` is the one the order is booked in (resolveCurrency: the gym's),
 * so the snapshot never carries a package's stale label.
 */
function packageSnapshot(pkg, currency) {
  const billing = pkg.billing || {};
  return {
    name: pkg.name,
    price: String(pkg.price),
    currency: currency || pkg.currency,
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

// A one-off package says how long it lasts in words -- its `period` label.
// These are the words understood, each with an optional count in front
// ("3 months", "six months", "12-month"); anything around them is ignored
// ("per month", "12 Months Membership"). The first one found in the label
// is the length.
const PERIOD_COUNT = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+(?:\\.\\d+)?';
const PERIOD_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const counted = (unit) => new RegExp(`\\b(?:(${PERIOD_COUNT})\\s*)?(?:${unit})\\b`);
const PERIOD_UNITS = [
  { pattern: /\b(?:half\s*(?:a\s*)?year(?:ly)?|semi\s*annual(?:ly)?)\b/, months: 6 },
  { pattern: /\b(?:fortnight(?:ly)?|bi\s*weekly)\b/, days: 14 },
  { pattern: counted('quarter(?:s|ly)?'), months: 3 },
  { pattern: counted('year(?:s|ly)?|annual(?:ly)?'), months: 12 },
  { pattern: counted('month(?:s|ly)?'), months: 1 },
  { pattern: counted('week(?:s|ly)?'), days: 7 },
  { pattern: counted('days?|daily'), days: 1 }
];
// Twice a month or every two months, twice a year or every two years:
// these read both ways, so they are not guessed at.
const PERIOD_AMBIGUOUS = /\bbi\s*(?:month|annual|year|ennial)/;
// Longer than a century is a typo, or a number that was never a count
// ("2026 year plan").
const PERIOD_MAX = { months: 1200, days: 36600 };

/** What an admin is told when a period label cannot be read. */
const PERIOD_HELP =
  'Use day, week, fortnight, month, quarter, half year or year, with a number in front if you need one ("3 months"), or set how many days it is valid for.';

/**
 * The length a period label names: `{ months }` or `{ days }`, or null when
 * it names none ("Custom", "Lifetime", "10 sessions").
 */
function periodLength(label) {
  const text = String(label || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  if (!text || PERIOD_AMBIGUOUS.test(text)) return null;

  let found = null;
  for (const unit of PERIOD_UNITS) {
    const match = unit.pattern.exec(text);
    if (match && (!found || match.index < found.match.index)) found = { unit, match };
  }
  if (!found) return null;

  // The count beside the unit, else a number the label opens with
  // ("3 x month"), else one.
  const beside = found.match[1];
  const count = beside ? PERIOD_WORDS[beside] || Number(beside) : parseInt(text, 10) || 1;
  if (!Number.isInteger(count) || count < 1) return null;
  const length = found.unit.months ? { months: found.unit.months * count } : { days: found.unit.days * count };
  return (length.months || 0) > PERIOD_MAX.months || (length.days || 0) > PERIOD_MAX.days ? null : length;
}

/**
 * Why a package cannot be saved as it is, or null. A one-off package with
 * no validity in days takes its length from the period label; one that
 * names no length used to be sold as 30 days whatever it cost.
 */
function periodProblem(pkg) {
  const billing = (pkg && pkg.billing) || {};
  if (billing.mode === 'recurring' || Number(pkg && pkg.durationDays) > 0) return null;
  if (periodLength(pkg && pkg.period)) return null;
  return `The period "${String((pkg && pkg.period) || '').trim()}" does not say how long this package lasts. ${PERIOD_HELP}`;
}

/**
 * How long one term of this package lasts, from a start date: its validity
 * in days when it has one, else its billing interval when it is recurring,
 * else what its period label names (periodLength). A stored package whose
 * label names no length still gets 30 days, as it always has; saving one
 * like that is refused (periodProblem).
 */
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
  const length = periodLength(snapshot.period || 'month');
  if (length && length.months) return addMonths(start, length.months);
  end.setDate(end.getDate() + (length ? length.days : 30));
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

/* ----------------------------- joining fee ----------------------------- */

/**
 * Whether this person still owes a package's joining fee. It is charged
 * once, with the first membership: anybody who has ever paid for one --
 * refunded since or not -- has joined, and is not charged it again when
 * they come back. A day pass, trial or pack bought before does not count as
 * joining, so the membership that follows it still carries the fee.
 *
 * Renewals and package changes never ask: they are not joining at all
 * (createManualOrder's `chargeJoiningFee: false`).
 */
async function joiningFeeDue({ userId, email } = {}) {
  const owner = [];
  if (userId) owner.push({ userId });
  if (email) owner.push({ 'customerInfo.email': String(email).toLowerCase().trim() });
  if (!owner.length) return true;

  const joined = await PackageOrder.exists({
    $or: owner,
    'payment.status': { $in: ['paid', 'refunded'] },
    $and: [{ $or: [{ 'packageDetails.kind': 'membership' }, { 'packageDetails.kind': { $exists: false } }] }]
  });
  return !joined;
}

/**
 * An account's email, for the rules that follow a person by the address on
 * their orders (the joining fee, when a new term starts, one subscription
 * each): empty until the address is confirmed (emailVerification.js). A
 * sign-up can type anybody's address, and until it is shown to be theirs it
 * must not pass for the guest who paid with it -- no fee taken off, no term
 * stacked on that guest's, no word on whether they have a subscription.
 * Orders under the account's own id count either way.
 *
 * Mind a projection: load the account with `emailVerified`, or an
 * unconfirmed address reads as confirmed here.
 */
function provenEmail(account) {
  return account && account.email && account.emailVerified !== false ? account.email : '';
}

/**
 * Who an online checkout is from, for the rules that follow a person (the
 * joining fee, one subscription each): the signed-in account -- its id and
 * its own email, once confirmed (provenEmail) -- or null for a guest.
 *
 * Never the email typed into the checkout form. Anybody can type a paying
 * member's address there: it used to take the joining fee off for them, and
 * answered whether that address has a subscription. A guest is nobody the
 * gym knows yet, so a guest pays the fee; signing in is how a returning
 * member is recognised.
 */
async function checkoutIdentity(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
  const account = await User.findById(userId).select('email emailVerified').lean();
  return account ? { userId: account._id, email: provenEmail(account) } : null;
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
  // Paid in full -- unless the desk took only part of it, in which case
  // createManualOrder has already said how much and what is left.
  if (order.payment.amountPaid === null || order.payment.amountPaid === undefined) {
    order.payment.amountPaid = order.payment.amount;
    order.payment.balanceDue = 0;
  }

  const snapshot = order.packageDetails || {};
  // After the terms of the account it was bought under, and no one else's:
  // the address on the order is typed at checkout, and typing a member's
  // used to start the buyer's term on the day that member's ends. A guest
  // order has no account, so it starts when it is paid.
  const start = startDate
    ? new Date(startDate)
    : await startDateFor({ userId: order.userId, kind: snapshot.kind || 'membership', now: paidAt });
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
    // Which coupon this call counted, so a save that is then refused (the
    // same desk request already made its order) can take the use back.
    if (counted && order.$locals) order.$locals.couponCounted = coupon._id;
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

/* ------------------------------ desk terms ----------------------------- */
//
// What staff may set when they sell or renew a membership at the desk, read
// from the request and checked before anything is written. A value that
// cannot be used is a 400 naming the field -- never quietly dropped, which
// would sell the member something other than what the desk agreed.

const MAX_START_AHEAD_DAYS = 365;

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function money(value, field) {
  if (!present(value)) return undefined;
  const amount = typeof value === 'number' ? value : parseAmount(value);
  if (amount === null || !Number.isFinite(amount) || amount < 0) {
    throw new MembershipError(`${field} must be an amount of 0 or more`, 400, 'INVALID_TERMS');
  }
  return round2(amount);
}

/* ---------------------------- desk repeats ----------------------------- */
//
// A desk request sent again because its answer never arrived -- a timeout, a
// dropped connection -- must not sell a second term or record a second
// installment. The desk may send `requestId` with a sale, a renewal or a part
// payment: any id it makes up for that one action (a UUID will do), sent
// again unchanged when it retries. A request whose id is already recorded
// is answered with the first result and changes nothing. Left out, every
// request is new, as before.
//
// The id is kept on what the request made: `metadata.requestId` on the order
// a sale or renewal made, and `requestId` on the installment a part payment
// recorded (every one of them, so an old payment's id sent again late is
// still known). Orders from before that keep their latest payment's id in
// `metadata.lastPaymentRequestId`, and it still counts.
//
// Two copies arriving at the very same moment -- a retry while the first is
// still being saved -- are told apart too: a unique index on the order's
// request id lets one sale be written, and a part payment is one
// conditional update on the balance, so the second finds the first's
// result and answers with it.

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

/** The `requestId` a desk request carries, or undefined when it has none. */
function readRequestId(value) {
  if (!present(value)) return undefined;
  const id = String(value).trim();
  if (!REQUEST_ID.test(id)) {
    throw new MembershipError('requestId must be 8 to 100 letters, digits, hyphens or underscores (a UUID will do)', 400, 'INVALID_TERMS');
  }
  return id;
}

/** What an order's metadata holds under `key` (a Map on a loaded order). */
function metadataOf(order, key) {
  const metadata = order && order.metadata;
  if (!metadata) return undefined;
  return typeof metadata.get === 'function' ? metadata.get(key) : metadata[key];
}

/** Marks an order handed back as the first result of a request sent again. */
function asRepeat(order) {
  if (order.$locals) order.$locals.repeated = true;
  return order;
}

/** Whether an order was handed back as the answer to a repeated request. */
function isRepeat(order) {
  return !!(order && order.$locals && order.$locals.repeated);
}

/** The order a desk request already made for this member, or null. */
function orderMadeBy(userId, requestId) {
  return PackageOrder.findOne({ userId, 'metadata.requestId': requestId });
}

/** Whether a write failed only because another order holds this request id. */
function isRequestIdClash(error) {
  if (!error || error.code !== 11000) return false;
  const keys = Object.keys(error.keyPattern || error.keyValue || {});
  return keys.includes('metadata.requestId') || /metadata\.requestId|one_order_per_desk_request/.test(String(error.message || ''));
}

/** Whether this desk part payment is already on the order. */
function paymentRecorded(order, requestId) {
  if (!requestId || !order) return false;
  if (metadataOf(order, 'lastPaymentRequestId') === requestId) return true;
  const parts = (order.payment && order.payment.installments) || [];
  return parts.some((part) => part && part.requestId === requestId);
}

/**
 * A date the desk sent. A bare 'YYYY-MM-DD' (a date input) names a whole
 * day at the gym: its first moment for a start, its last for an end (a
 * membership "until 30 Sep" still works at 23:59 that day). Anything else
 * must read as an instant.
 */
function readDeskDate(value, edge, field) {
  let at = null;
  if (T.isDateOnly(value)) {
    const key = String(value).trim();
    at = edge === 'end' ? T.lastMomentOfLocalDay(key) : T.startOfLocalDay(key);
  } else if (typeof value === 'string' || value instanceof Date) {
    at = new Date(value);
  }
  if (!at || Number.isNaN(at.getTime())) throw new MembershipError(`${field} is not a date`, 400, 'INVALID_TERMS');
  return at;
}

/**
 * A start date the desk sent (readDeskDate, from the start of a bare day).
 * Starting more than a year ahead is refused as the typo it almost
 * certainly is.
 */
function readStartDate(value, now = new Date()) {
  const at = readDeskDate(value, 'start', 'startDate');
  if (at.getTime() > now.getTime() + MAX_START_AHEAD_DAYS * DAY_MS) {
    throw new MembershipError(`A membership can start at most ${MAX_START_AHEAD_DAYS} days ahead`, 400, 'INVALID_TERMS');
  }
  return at;
}

/**
 * The desk's terms from a request body, for createManualOrder.
 *
 *   startDate | startAfterDays   when the term starts: a date, or so many
 *                                days from today (the start of that day at
 *                                the gym; 0 = now). Not both. Left out, a
 *                                membership starts when the current one
 *                                ends. The end date follows from the start.
 *   discountAmount, discountNote off the package price
 *   amountOverride (or amount)   charge this total instead
 *   waiveJoiningFee              no admission fee on this order
 *   amountPaid                   paid now, when less than the total: the
 *                                membership is granted and the rest is a
 *                                balance due (recordPayment settles it)
 *   paymentMethod                checked by createManualOrder
 *   trainerId, trainerFee,       a personal trainer sold with it (sale only,
 *   trainerCommissionType,       not renewals): 'percent' of the fee, or a
 *   trainerCommissionValue       fixed 'amount'
 *   notes
 *   requestId                    this action's own id, so that sending it
 *                                again makes no second order (desk repeats)
 *
 * @param {object} body
 * @param {{ trainer?: boolean, now?: Date }} [options] trainer: whether
 *   trainer fields are accepted at all
 * @throws {MembershipError} 400 INVALID_TERMS naming the field
 */
function readDeskTerms(body = {}, { trainer: allowTrainer = true, now = new Date() } = {}) {
  const terms = {};

  if (present(body.startDate) && present(body.startAfterDays)) {
    throw new MembershipError('Send startDate or startAfterDays, not both', 400, 'INVALID_TERMS');
  }
  if (present(body.startDate)) terms.startDate = readStartDate(body.startDate, now);
  if (present(body.startAfterDays)) {
    const days = Number(body.startAfterDays);
    if (!Number.isInteger(days) || days < 0 || days > MAX_START_AHEAD_DAYS) {
      throw new MembershipError(`startAfterDays must be a whole number from 0 to ${MAX_START_AHEAD_DAYS}`, 400, 'INVALID_TERMS');
    }
    terms.startDate = days === 0 ? now : T.startOfLocalDay(T.shiftDateKey(T.dateKey(now), days));
  }

  const discount = money(body.discountAmount, 'discountAmount');
  if (discount !== undefined) terms.discountAmount = discount;
  if (present(body.discountNote)) terms.discountNote = String(body.discountNote).trim().slice(0, 200);

  const override = money(present(body.amountOverride) ? body.amountOverride : body.amount, 'amountOverride');
  if (override !== undefined) terms.amountOverride = override;
  // Part of the total taken now; the rest is the member's balance due.
  const paidNow = money(body.amountPaid, 'amountPaid');
  if (paidNow !== undefined) terms.amountPaid = paidNow;

  if (truthy(body.waiveJoiningFee)) terms.chargeJoiningFee = false;
  if (present(body.paymentMethod)) terms.paymentMethod = body.paymentMethod;
  if (present(body.notes)) terms.notes = String(body.notes).trim().slice(0, 1000);
  const requestId = readRequestId(body.requestId);
  if (requestId) terms.requestId = requestId;

  const trainerFields = ['trainerId', 'trainerFee', 'trainerCommissionType', 'trainerCommissionValue'].filter((key) => present(body[key]));
  if (trainerFields.length) {
    if (!allowTrainer) throw new MembershipError('A trainer is chosen when the membership is sold, not on a renewal', 400, 'INVALID_TERMS');
    if (!present(body.trainerId)) throw new MembershipError('Choose the trainer the fee or commission is for (trainerId)', 400, 'INVALID_TERMS');
    if (!mongoose.Types.ObjectId.isValid(String(body.trainerId))) throw new MembershipError('trainerId is not a trainer', 400, 'INVALID_TERMS');
    const commissionType = present(body.trainerCommissionType) ? body.trainerCommissionType : 'percent';
    if (!['percent', 'amount'].includes(commissionType)) {
      throw new MembershipError("trainerCommissionType must be 'percent' or 'amount'", 400, 'INVALID_TERMS');
    }
    const commissionValue = money(body.trainerCommissionValue, 'trainerCommissionValue') || 0;
    if (commissionType === 'percent' && commissionValue > 100) {
      throw new MembershipError('A percentage commission cannot be over 100', 400, 'INVALID_TERMS');
    }
    terms.trainer = {
      trainerId: String(body.trainerId),
      fee: money(body.trainerFee, 'trainerFee') || 0,
      commissionType,
      commissionValue
    };
  }
  return terms;
}

/** What a trainer's commission on a fee comes to. */
function commissionOn(fee, { commissionType, commissionValue }) {
  return commissionType === 'amount' ? round2(commissionValue) : round2((Number(fee) || 0) * (Number(commissionValue) || 0) / 100);
}

/* ---------------------------- manual orders ---------------------------- */

/**
 * An order created by staff: cash or bank at the desk, a comped package, a
 * renewal, or an upgrade. Returns the saved order.
 *
 * `chargeJoiningFee`: left out, the package's joining fee is added when the
 * member has never joined (joiningFeeDue); renewals and package changes
 * pass false.
 *
 * `trainer` ({ trainerId, fee, commissionType, commissionValue }, from
 * readDeskTerms): a personal trainer sold with the membership. The fee is
 * charged on top as payment.trainerFee, the commission is recorded on
 * trainerAssignment, and the member's assigned trainer becomes this one.
 *
 * `amountPaid`: what was taken now, when it is less than the total. The
 * membership is granted all the same (paid, active) with the rest as
 * payment.balanceDue, and what was taken is the order's first installment,
 * recorded as received by `paidBy` (a staff account id).
 *
 * `requestId`: the desk's id for this action. When this member already has
 * the order it made, that order is returned (isRepeat) and nothing is sold
 * -- also when the first copy is still being saved as the second arrives:
 * the unique index on the request id refuses the second order, and the
 * first one is the answer.
 *
 * `imported`: the member import only. A paid membership brought over from
 * the gym's old system: marked so its payment is not counted as money taken
 * today and no invoice is issued for it (see the order model).
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
  chargeJoiningFee,
  trainer = null,
  amountPaid,
  paidBy = null,
  by = null,
  requestId,
  imported = false
}) {
  if (requestId) {
    const first = await orderMadeBy(user._id, requestId);
    if (first) return asRepeat(first);
  }
  const settings = await Settings.getSettings().catch(() => null);
  const listPrice = parseAmount(pkg.price);
  if (listPrice === null) {
    throw new MembershipError(
      `Package "${pkg.name}" has an unreadable price (${JSON.stringify(pkg.price)}). Fix it on the Packages screen first.`,
      422
    );
  }
  // An unknown method is refused rather than recorded as cash.
  const { method, problem } = readDeskMethod(paymentMethod);
  if (problem) throw new MembershipError(problem, 422, 'PAYMENT_METHOD_INVALID');
  const currency = resolveCurrency(pkg.currency, settings && settings.currency);
  const snapshot = packageSnapshot(pkg, currency);
  const feeDue = chargeJoiningFee === undefined ? await joiningFeeDue({ userId: user._id, email: provenEmail(user) }) : !!chargeJoiningFee;
  const joiningFee = feeDue ? round2(snapshot.joiningFee) : 0;

  let coach = null;
  if (trainer) {
    coach = await Trainer.findById(trainer.trainerId).select('name isActive').lean();
    if (!coach) throw new MembershipError('That trainer was not found', 404, 'TRAINER_NOT_FOUND');
    if (coach.isActive === false) throw new MembershipError(`${coach.name} is not an active trainer`, 409, 'TRAINER_INACTIVE');
  }
  const trainerFee = coach ? round2(trainer.fee) : 0;

  let coupon = null;
  let discount = round2(discountAmount);
  if (couponCode) {
    const applied = await applyCoupon(couponCode, pkg, listPrice);
    coupon = applied.coupon;
    discount = round2(discount + applied.discount);
  }
  // A discount comes off the package price, never off the fees charged
  // beside it -- and never below nothing (a package-change credit can be
  // worth more than the new package).
  discount = Math.min(discount, listPrice);
  let amount = round2(listPrice - discount + joiningFee + trainerFee);
  if (amountOverride !== undefined && amountOverride !== null && amountOverride !== '') {
    const override = parseAmount(amountOverride);
    if (override === null) throw new MembershipError('Amount must be a number', 400);
    amount = override;
  }
  // What the total carries, admission first: an override below the fees
  // settles them before the membership (orderMoney.allocate).
  const parts = allocate(amount, { joiningFee, trainerFee });

  const paid = markPaid !== false;
  const now = new Date();

  // Paid in part: checked against the total before anything is written.
  let taken = amount;
  if (amountPaid !== undefined && amountPaid !== null && amountPaid !== '') {
    taken = parseAmount(amountPaid);
    if (taken === null || taken < 0) throw new MembershipError('amountPaid must be an amount of 0 or more', 400, 'INVALID_TERMS');
    taken = round2(taken);
    if (!paid && taken > 0) {
      throw new MembershipError('An order left pending has nothing paid yet: mark it paid to take part of the money now', 400, 'INVALID_TERMS');
    }
    if (taken > amount) throw new MembershipError(`amountPaid cannot be more than the ${amount} charged`, 400, 'INVALID_TERMS');
  }
  const balance = paid ? round2(amount - taken) : 0;
  const staff = paidBy && mongoose.Types.ObjectId.isValid(String(paidBy)) ? paidBy : null;
  const start = startDate ? new Date(startDate) : await startDateFor({ userId: user._id, email: provenEmail(user), kind: snapshot.kind, now });
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
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.phone || 'Member',
      email: user.email || '',
      phone: user.phone || '',
      country: (address && address.country) || ''
    },
    payment: {
      method,
      amount,
      joiningFee: parts.joiningFee,
      trainerFee: parts.trainerFee,
      subtotal: round2(listPrice + joiningFee + trainerFee),
      discountAmount: discount,
      discountNote,
      couponCode: coupon ? coupon.code : '',
      currency: currency.toLowerCase(),
      status: paid ? 'paid' : 'pending',
      paidAt: paid ? now : undefined,
      amountPaid: paid ? taken : null,
      balanceDue: balance,
      // Paid in part: what was taken is the first installment (nothing
      // taken yet, none). Paid in full at once needs none.
      installments: balance > 0 && taken > 0 ? [{ ...nextPart({ joiningFee: parts.joiningFee, trainerFee: parts.trainerFee }, [], taken), method, at: now, by: staff, note: '' }] : []
    },
    subscription: {
      startDate: start,
      endDate: end,
      isActive: paid,
      autoRenew: false,
      renewalDate: end
    },
    sessions: snapshot.sessions > 0 ? { total: snapshot.sessions, used: 0 } : undefined,
    // The commission is on the trainer's fee this order actually carries.
    trainerAssignment: coach
      ? {
          trainerId: coach._id,
          trainerName: coach.name || '',
          fee: parts.trainerFee,
          commissionType: trainer.commissionType,
          commissionValue: trainer.commissionValue,
          commissionAmount: commissionOn(parts.trainerFee, trainer)
        }
      : null,
    renewedFrom,
    status: paid ? 'active' : 'pending',
    notes: notes || `Created from the admin panel by ${by || 'an administrator'}`,
    metadata: requestId ? { requestId } : undefined,
    // Only when it came in paid: one left pending is paid here, later, and
    // that money is real takings on the day it arrives.
    ...(imported && paid ? { imported: true } : {}),
    createdBy: null
  });

  try {
    if (paid) {
      await markPaidAndActivate(order, { paidAt: now, startDate: start, endDate: end });
    } else {
      await order.save();
    }
  } catch (error) {
    // The same request sent again while the first was still being saved:
    // both got past the lookup above, and the unique index let the first
    // one's order in. Nothing of this copy was kept -- the coupon use it
    // counted goes back -- and the first one's order is the answer.
    if (!requestId || !isRequestIdClash(error)) throw error;
    const coupon = order.$locals && order.$locals.couponCounted;
    if (coupon) await Coupon.updateOne({ _id: coupon, redemptions: { $gt: 0 } }, { $inc: { redemptions: -1 } }).catch(() => {});
    const first = await orderMadeBy(user._id, requestId);
    if (!first) throw error;
    return asRepeat(first);
  }

  // The member's trainer from now on (members pages, the trainer's list).
  if (coach && user._id) {
    await User.updateOne({ _id: user._id }, { $set: { assignedTrainerId: coach._id } });
  }
  return order;
}

/* ---------------------------- part payments ---------------------------- */

/** Whether an order's money goes through Stripe (and so is recorded there). */
function stripeBilled(order) {
  const p = (order && order.payment) || {};
  return p.method === 'stripe' || !!p.stripeSubscriptionId || !!p.stripePaymentIntentId || !!p.stripeSessionId;
}

// Whether a refund holds the order right now: claimed, and not so long ago
// that the refund must have died part-way (REFUND_CLAIM_MS, with refund
// below, which lets the next attempt take such a claim over).
function refundUnderWay(order) {
  const claimedAt = order && order.refund && order.refund.claimedAt;
  return !!claimedAt && Date.now() - new Date(claimedAt).getTime() < REFUND_CLAIM_MS;
}

// The same, as a query: no claim, or only a dead one.
function refundNotClaimed() {
  return [{ 'refund.claimedAt': null }, { 'refund.claimedAt': { $lt: new Date(Date.now() - REFUND_CLAIM_MS) } }];
}

function refundInProgress() {
  return new MembershipError('This order is being refunded; no payment can be taken against it.', 409, 'REFUND_IN_PROGRESS');
}

/**
 * Money received at the desk against an order's balance due.
 *
 * The payment becomes one of the order's installments -- the day it
 * arrived, how it was paid, who took it -- with whatever is still owed of
 * the admission fee and the trainer's fee taken first. An order paid in
 * part at once, with no installments yet, first gets that payment as its
 * opening installment (dated when it was paid), so the accounts keep
 * counting it where it was received.
 *
 * Written with one conditional update on the balance it started from: two
 * people recording the same payment at once take it off once, and the
 * second is told the balance moved.
 *
 * `requestId`: the desk's id for this payment, kept on the installment it
 * recorded. Sent again -- straight away, or after later payments -- the
 * order is returned as it now stands (isRepeat) and nothing more is
 * recorded. Two copies at once: the conditional update lets one through,
 * and the other finds its installment and answers the same way.
 *
 * @throws {MembershipError} 409 STRIPE_BILLED / NOT_PAID / NO_BALANCE /
 *   REFUND_IN_PROGRESS / BALANCE_CHANGED; 400 INVALID_PAYMENT (not above 0) / OVERPAYMENT (more
 *   than the balance); 422 PAYMENT_METHOD_INVALID
 */
async function recordPayment(order, { amount, method, note = '', by = null, now = new Date(), requestId } = {}) {
  // First of all: the payment may have settled the balance, and the repeat
  // would otherwise be told nothing is owed.
  if (paymentRecorded(order, requestId)) return asRepeat(order);
  if (stripeBilled(order)) {
    throw new MembershipError('This membership is paid by card through Stripe; there is no balance to take at the desk.', 409, 'STRIPE_BILLED');
  }
  if (order.payment.status !== 'paid') {
    throw new MembershipError(
      order.payment.status === 'refunded' ? 'This order has been refunded.' : 'This order has not been paid for yet: confirm or assign it first.',
      409,
      'NOT_PAID'
    );
  }
  // A refund under way gives back what had come in when it started and
  // then clears the balance: money taken in the meantime would be neither
  // refunded nor owed.
  if (refundUnderWay(order)) throw refundInProgress();
  const balance = round2(order.payment.balanceDue || 0);
  if (!(balance > 0)) throw new MembershipError('Nothing is owed on this order.', 409, 'NO_BALANCE');

  const value = typeof amount === 'number' ? amount : parseAmount(amount);
  if (value === null || !Number.isFinite(value) || round2(value) <= 0) {
    throw new MembershipError('The payment must be more than 0', 400, 'INVALID_PAYMENT');
  }
  const paying = round2(value);
  if (paying > balance) {
    throw new MembershipError(`The balance due is ${balance}; a payment cannot be more than that.`, 400, 'OVERPAYMENT');
  }
  const { method: how, problem } = readDeskMethod(method, {
    fallback: readDeskMethod(order.payment.method).method || 'cash'
  });
  if (problem) throw new MembershipError(problem, 422, 'PAYMENT_METHOD_INVALID');

  const parts = partsSoFar(order.payment, { firstAt: order.createdAt });
  parts.push({
    ...nextPart(order.payment, parts, paying),
    method: how,
    at: now,
    by: by && mongoose.Types.ObjectId.isValid(String(by)) ? by : null,
    note: String(note || '').trim().slice(0, 200),
    ...(requestId ? { requestId } : {})
  });

  const updated = await PackageOrder.findOneAndUpdate(
    // ...and no refund claimed since the order was read.
    { _id: order._id, 'payment.status': 'paid', 'payment.balanceDue': order.payment.balanceDue, $or: refundNotClaimed() },
    {
      $set: {
        'payment.installments': parts,
        'payment.amountPaid': round2(paidSoFar(order.payment) + paying),
        'payment.balanceDue': round2(balance - paying),
        'payment.lastPaidAt': now
      }
    },
    { new: true }
  );
  if (!updated) {
    // The same payment sent twice at once: the other copy recorded it.
    if (requestId) {
      const current = await PackageOrder.findById(order._id);
      if (paymentRecorded(current, requestId)) return asRepeat(current);
    }
    const fresh = await PackageOrder.findById(order._id).select('refund.claimedAt').lean();
    if (fresh && refundUnderWay(fresh)) throw refundInProgress();
    throw new MembershipError('The balance changed while this payment was being recorded. Reload the order and try again.', 409, 'BALANCE_CHANGED');
  }
  return updated;
}

/* ------------------------------ edit terms ----------------------------- */

// The terms a change is recorded against, before and after.
function termsOf(order) {
  const p = order.payment || {};
  const s = order.subscription || {};
  return {
    startDate: s.startDate || null,
    endDate: s.endDate || null,
    discountAmount: round2(p.discountAmount || 0),
    discountNote: p.discountNote || '',
    amount: round2(p.amount),
    balanceDue: round2(p.balanceDue || 0)
  };
}

/**
 * Changes a membership's dates or discount after the sale.
 *
 * `startDate` / `endDate` (a bare date is the start / the end of that day
 * at the gym) move the term; the end must come after the start. Moving the
 * end of a lapsed membership into the future makes it live again, and
 * moving a live one's into the past ends it.
 *
 * `discountAmount` is the order's whole discount from now on; it comes off
 * the package price only, so the total moves by the difference and can
 * never go below the fees it carries. On an order already paid, money
 * received stays exactly what it was -- amountPaid is written down as
 * received -- and the balance due follows: a smaller discount leaves more
 * to pay, a larger one may not take the total below what was paid (that
 * is a refund). The invoice keeps its number and takes the new total.
 *
 * Each change is appended to termsHistory with what the terms were before
 * and after, who made it and `note`. Written with one conditional update
 * on the money it started from, like recordPayment.
 *
 * @throws {MembershipError} 409 STRIPE_BILLED (a card subscription's dates
 *   and price are Stripe's; a card payment's price is what was charged),
 *   409 ORDER_CLOSED, 409 REFUND_NEEDED, 409 TERMS_CHANGED; 400
 *   INVALID_TERMS naming the field, or when nothing would change
 */
async function editTerms(order, body = {}, { by = null, now = new Date() } = {}) {
  const p = order.payment || {};
  if (p.stripeSubscriptionId) {
    throw new MembershipError("This membership is a card subscription: its dates and price follow Stripe's billing and are changed there.", 409, 'STRIPE_BILLED');
  }
  if (['refunded', 'failed', 'cancelled'].includes(p.status) || order.status === 'cancelled') {
    throw new MembershipError('This order is closed; its terms can no longer be changed.', 409, 'ORDER_CLOSED');
  }
  if (stripeBilled(order) && p.status !== 'paid') {
    // Its dates are set when Stripe confirms the payment.
    throw new MembershipError('This card payment has not gone through yet; its terms are set once it does.', 409, 'STRIPE_BILLED');
  }

  const before = termsOf(order);
  const after = { ...before };
  if (present(body.startDate)) after.startDate = readDeskDate(body.startDate, 'start', 'startDate');
  if (present(body.endDate)) after.endDate = readDeskDate(body.endDate, 'end', 'endDate');
  if ((present(body.startDate) || present(body.endDate)) && after.startDate && after.endDate && new Date(after.endDate) <= new Date(after.startDate)) {
    throw new MembershipError('The end date must come after the start date', 400, 'INVALID_TERMS');
  }
  if (body.discountNote !== undefined && body.discountNote !== null) after.discountNote = String(body.discountNote).trim().slice(0, 200);

  const discount = money(body.discountAmount, 'discountAmount');
  if (discount !== undefined && discount !== before.discountAmount) {
    if (stripeBilled(order)) {
      throw new MembershipError('This order was paid by card through Stripe: its price is what was charged. Refund part of it instead.', 409, 'STRIPE_BILLED');
    }
    const listPrice = parseAmount(order.packageDetails && order.packageDetails.price);
    if (listPrice !== null && discount > listPrice) {
      throw new MembershipError(`The discount comes off the package price (${listPrice}) and cannot be more than it`, 400, 'INVALID_TERMS');
    }
    const amount = round2(before.amount + before.discountAmount - discount);
    const fees = round2((p.joiningFee || 0) + (p.trainerFee || 0));
    if (amount < fees) {
      throw new MembershipError(`That would take the total below the ${fees} of fees it carries; the discount comes off the package price only`, 400, 'INVALID_TERMS');
    }
    after.discountAmount = discount;
    after.amount = amount;
    if (p.status === 'paid') {
      const received = paidSoFar(p);
      if (amount < received) {
        throw new MembershipError(`${received} has already been paid, more than the new total of ${amount}. Refund the difference instead.`, 409, 'REFUND_NEEDED');
      }
      after.balanceDue = round2(amount - received);
    }
  }

  const changed = ['startDate', 'endDate', 'discountAmount', 'discountNote', 'amount'].filter((key) => {
    const a = before[key] instanceof Date ? before[key].getTime() : before[key];
    const b = after[key] instanceof Date ? after[key].getTime() : after[key];
    return a !== b;
  });
  if (!changed.length) throw new MembershipError('Nothing to change: send startDate, endDate, discountAmount or discountNote', 400, 'INVALID_TERMS');

  const set = {
    'subscription.startDate': after.startDate,
    'subscription.endDate': after.endDate,
    'subscription.renewalDate': after.endDate,
    'payment.discountAmount': after.discountAmount,
    'payment.discountNote': after.discountNote
  };
  if (after.amount !== before.amount) {
    set['payment.amount'] = after.amount;
    if (p.status === 'paid') {
      // Money received does not move with the price.
      set['payment.amountPaid'] = paidSoFar(p);
      set['payment.balanceDue'] = after.balanceDue;
    }
    if (order.invoice && order.invoice.number) {
      const rate = Number(order.invoice.taxRate) || 0;
      const tax = rate > 0 ? round2(after.amount - after.amount / (1 + rate / 100)) : 0;
      set['invoice.total'] = after.amount;
      set['invoice.taxAmount'] = tax;
      set['invoice.subtotal'] = round2(after.amount - tax);
    }
  }
  // Live again, or over, as the new end date says.
  if (after.endDate && p.status === 'paid') {
    const ends = new Date(after.endDate);
    if (ends > now && order.status === 'expired') {
      set.status = 'active';
      set['subscription.isActive'] = true;
    } else if (ends <= now && order.status === 'active') {
      set.status = 'expired';
      set['subscription.isActive'] = false;
    }
  }

  // An order from before balances has none stored: nothing owed.
  const balanceWas = round2(p.balanceDue || 0) > 0 ? p.balanceDue : { $in: [0, null] };
  const updated = await PackageOrder.findOneAndUpdate(
    { _id: order._id, 'payment.amount': p.amount, 'payment.balanceDue': balanceWas, 'payment.status': p.status },
    {
      $set: set,
      $push: {
        termsHistory: {
          at: now,
          by: by && mongoose.Types.ObjectId.isValid(String(by)) ? by : null,
          from: before,
          to: after,
          note: present(body.note) ? String(body.note).trim().slice(0, 500) : ''
        }
      }
    },
    { new: true }
  );
  if (!updated) {
    throw new MembershipError('The order changed while this was being saved. Reload it and try again.', 409, 'TERMS_CHANGED');
  }
  return updated;
}

/* --------------------------- bank transfers ---------------------------- */

async function createBankTransferOrder({ user, pkg, customerInfo = {}, couponCode }) {
  const settings = await Settings.getSettings().catch(() => null);
  const listPrice = parseAmount(pkg.price);
  if (listPrice === null || listPrice <= 0) throw new MembershipError('This package cannot be bought online', 422);
  const currency = resolveCurrency(pkg.currency, settings && settings.currency);
  const snapshot = packageSnapshot(pkg, currency);

  const { coupon, discount } = await applyCoupon(couponCode, pkg, listPrice);
  // Charged once: not to a member coming back (joiningFeeDue).
  const joiningFee = (await joiningFeeDue({ userId: user._id, email: provenEmail(user) })) ? round2(snapshot.joiningFee) : 0;
  const amount = round2(Math.max(0, listPrice + joiningFee - discount));

  // The same rule as card checkout: one running subscription per member.
  await assertNoActiveSubscription({ userId: user._id, email: provenEmail(user), snapshot });

  const order = await PackageOrder.create({
    orderNumber: await PackageOrder.generateOrderNumber(),
    userId: user._id,
    packageId: pkg._id,
    packageDetails: snapshot,
    customerInfo: {
      fullName: customerInfo.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.phone || 'Member',
      email: user.email || '',
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
      // The coupon came off the price alone, so the fee is all there.
      joiningFee,
      trainerFee: 0,
      subtotal: round2(listPrice + joiningFee),
      discountAmount: discount,
      couponCode: coupon ? coupon.code : '',
      currency: currency.toLowerCase(),
      status: 'pending'
    },
    status: 'pending'
  });
  return order;
}

// The payment statuses a transfer can still be acted on in: nothing received
// yet, or a receipt waiting to be checked. Any other is settled -- paid, or
// closed (rejected, never arrived, refunded) -- and none of the three calls
// below reopens it: a receipt sent again must not bring a refunded or
// rejected order back, and Approve must not hand its membership back.
//
// Each is one conditional update on that status, like recordPayment, so they
// decide on the order as it is stored, not on the copy the caller read.
const REVIEWABLE = ['pending', 'processing'];

// An approval first claims the order by writing when it was reviewed; only
// the request that wrote it activates. Two approvals sent together used to
// both pass the "not paid yet" check on their own copies and both activate:
// the term pushed a full period on, the coupon counted twice, two invoice
// numbers. A claim this old was left by a request that died part-way, and
// the next one may take it over (as REFUND_CLAIM_MS does for refunds).
const REVIEW_CLAIM_MS = 10 * 60 * 1000;

function reviewNotClaimed(now) {
  return [{ 'payment.proof.reviewedAt': null }, { 'payment.proof.reviewedAt': { $lt: new Date(now.getTime() - REVIEW_CLAIM_MS) } }];
}

function reviewable(orderId, now) {
  return { _id: orderId, 'payment.status': { $in: REVIEWABLE }, $or: reviewNotClaimed(now) };
}

function staffId(by) {
  return by && mongoose.Types.ObjectId.isValid(String(by)) ? by : null;
}

/** Why an order could not be acted on, read from the order as it now is. */
async function reviewRefusal(orderId) {
  const fresh = await PackageOrder.findById(orderId).select('payment.status').lean();
  const status = fresh && fresh.payment ? fresh.payment.status : null;
  if (status === 'paid') return new MembershipError('This order is already paid', 400, 'ALREADY_PAID');
  if (status === 'refunded') {
    return new MembershipError('This order was refunded, so it cannot be opened again. Start a new order for the package instead.', 409, 'ORDER_CLOSED');
  }
  if (!REVIEWABLE.includes(status)) {
    return new MembershipError(
      'This order is closed: its payment was not accepted. It cannot be opened again; start a new order for the package instead.',
      409,
      'ORDER_CLOSED'
    );
  }
  return new MembershipError('Somebody else is confirming this payment right now. Reload the order in a moment.', 409, 'REVIEW_IN_PROGRESS');
}

async function submitTransferProof(order, { url, note, reference, now = new Date() }) {
  if (order.payment.method !== 'bank_transfer') throw new MembershipError('This order was not paid by bank transfer', 400);
  const updated = await PackageOrder.findOneAndUpdate(
    reviewable(order._id, now),
    {
      $set: {
        'payment.proof': {
          url: url || (order.payment.proof && order.payment.proof.url) || '',
          note: note || '',
          reference: reference || '',
          uploadedAt: now,
          reviewedAt: null,
          reviewedBy: null,
          rejectionReason: ''
        },
        'payment.status': 'processing',
        status: 'pending'
      }
    },
    { new: true }
  );
  if (!updated) throw await reviewRefusal(order._id);
  return updated;
}

/**
 * Confirms the money arrived and activates the order -- once, however many
 * approvals arrive together.
 * @returns {Promise<object>} the order as activated
 * @throws {MembershipError} 400 ALREADY_PAID; 409 ORDER_CLOSED (refunded,
 *   rejected or failed) / REVIEW_IN_PROGRESS (another approval holds it)
 */
async function approveTransfer(order, { by, now = new Date() } = {}) {
  const claimed = await PackageOrder.findOneAndUpdate(
    reviewable(order._id, now),
    { $set: { 'payment.proof.reviewedAt': now, 'payment.proof.reviewedBy': staffId(by), 'payment.proof.rejectionReason': '' } },
    { new: true }
  );
  if (!claimed) throw await reviewRefusal(order._id);
  try {
    return await markPaidAndActivate(claimed, { paidAt: now });
  } catch (error) {
    // Let go, so the approval can be tried again.
    await PackageOrder.updateOne(
      { _id: order._id, 'payment.status': { $in: REVIEWABLE }, 'payment.proof.reviewedAt': now },
      { $set: { 'payment.proof.reviewedAt': null, 'payment.proof.reviewedBy': null } }
    ).catch(() => {});
    throw error;
  }
}

async function rejectTransfer(order, { by, reason, now = new Date() } = {}) {
  const updated = await PackageOrder.findOneAndUpdate(
    reviewable(order._id, now),
    {
      $set: {
        'payment.proof.reviewedAt': now,
        'payment.proof.reviewedBy': staffId(by),
        'payment.proof.rejectionReason': reason || '',
        'payment.status': 'failed',
        status: 'cancelled',
        cancellation: { cancelledAt: now, reason: reason || 'Bank transfer rejected', by: staffId(by), source: 'staff' }
      }
    },
    { new: true }
  );
  if (!updated) throw await reviewRefusal(order._id);
  return updated;
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

/**
 * A fresh term of the same package, starting when the current one ends --
 * or on `startDate` when the desk says. `discountAmount` / `discountNote`
 * and `amountOverride` price it as on a sale (readDeskTerms).
 */
async function renew(
  order,
  { paymentMethod = 'cash', markPaid = true, months, notes, by, startDate, discountAmount, discountNote, amountOverride, amountPaid, paidBy, requestId } = {}
) {
  const [user, pkg] = await Promise.all([User.findById(order.userId), Package.findById(order.packageId)]);
  if (!user) throw new MembershipError('The member account no longer exists', 404);
  if (!pkg) throw new MembershipError('The package no longer exists; assign a current one instead', 404);

  const now = new Date();
  const currentEnd = order.subscription && order.subscription.endDate ? new Date(order.subscription.endDate) : null;
  const start = startDate || (currentEnd && currentEnd > now && ['active', 'frozen'].includes(order.status) ? currentEnd : now);

  return createManualOrder({
    user,
    pkg,
    paymentMethod,
    markPaid,
    discountAmount,
    discountNote,
    amountOverride,
    amountPaid,
    paidBy,
    durationMonths: months,
    startDate: start,
    notes: notes || `Renewal of ${order.orderNumber}`,
    renewedFrom: order._id,
    // A renewal is not joining: the fee was taken with the first term.
    chargeJoiningFee: false,
    by,
    requestId
  });
}

/**
 * The inline price for a subscription item. Unlike a Checkout line, which
 * may create its product as it goes (product_data), a subscription item's
 * price_data must name a product that already exists: Stripe refuses
 * product_data there (platform/services/subscriptionSync.js does the same).
 */
function subscriptionPriceData({ currency, product, amount, billing }) {
  return {
    currency,
    product,
    unit_amount: toMinorUnits(amount, currency),
    recurring: { interval: billing.interval, interval_count: billing.intervalCount }
  };
}

/**
 * How a credit for unused days meets the new package's price: `applied`
 * comes off it, and `unused` is what the price was too small to take.
 */
function creditAgainst(credit, listPrice) {
  const whole = round2(Math.max(0, credit));
  const applied = listPrice === null ? whole : Math.min(whole, round2(Math.max(0, listPrice)));
  return { applied, unused: round2(whole - applied) };
}

/**
 * Moves a member to a different package. The unused part of what they paid
 * comes off the new price (pro rata by days). On a Stripe subscription the
 * subscription itself is switched and Stripe prorates.
 *
 * A credit worth more than the new package (a year paid, six months left,
 * moved to a monthly) cannot all come off its price. The rest is money the
 * member paid and would get nothing for, so the change is refused (409
 * CREDIT_EXCEEDS_PRICE, with the figures on `details`) unless the desk sends
 * `forfeitCredit`: then it goes ahead, and the answer says what was credited
 * (`credit`) and what was given up (`creditUnused`).
 *
 * `by` names who did it, for the notes; `changedBy` is their account id,
 * recorded on the old order's cancellation.
 */
async function changePackage(order, { packageId, paymentMethod = 'cash', markPaid = true, notes, by, changedBy = null, forfeitCredit = false } = {}) {
  assertActive(order);
  // The credit is for days already paid for; with money still owed it
  // would be worked out on money that never came in.
  if (round2(order.payment.balanceDue) > 0) {
    throw new MembershipError(
      `${round2(order.payment.balanceDue)} is still owed on this membership. Record that payment first, then change the package.`,
      409,
      'BALANCE_DUE'
    );
  }
  const [user, pkg] = await Promise.all([User.findById(order.userId), Package.findById(packageId)]);
  if (!user) throw new MembershipError('The member account no longer exists', 404);
  if (!pkg) throw new MembershipError('Package not found', 404);
  if (String(pkg._id) === String(order.packageId)) throw new MembershipError('That is the package they already have', 400);

  const now = new Date();
  const start = new Date(order.subscription.startDate || order.createdAt);
  const end = new Date(order.subscription.endDate);
  const totalDays = Math.max(1, (end - start) / DAY_MS);
  // A term that has not begun (a renewal queued behind the running one) is
  // unused throughout -- but no more than throughout: counted from now it
  // ran past its own length and credited up to twice what it cost.
  const remainingDays = Math.min(totalDays, Math.max(0, (end - now) / DAY_MS));
  // Only the membership is used up by the day. The admission fee and the
  // trainer's fee inside the total were charged once and are not handed
  // back as unused days -- crediting them made a same-day change nearly
  // free. What was received is allocated as every payment is (fees first,
  // orderMoney.allocate), so a total cut below the fees credits only the
  // part that paid for the membership.
  const membershipPaid = allocate(paidSoFar(order.payment), {
    joiningFee: order.payment.joiningFee,
    trainerFee: order.payment.trainerFee
  }).membership;
  const credit = round2(membershipPaid * (remainingDays / totalDays));

  if (order.payment.stripeSubscriptionId) {
    const snapshot = packageSnapshot(pkg);
    const listPrice = parseAmount(pkg.price);
    // Stripe charges a subscription on an interval, and a one-off package
    // has none of its own: moved onto one, its whole price would be charged
    // every month.
    if (snapshot.billing.mode !== 'recurring' || listPrice === null || listPrice <= 0) {
      throw new MembershipError(
        `${pkg.name} is not paid by card subscription, so this subscription cannot be moved onto it. Cancel the subscription, then assign ${pkg.name} at the desk.`,
        409,
        'NOT_A_SUBSCRIPTION_PACKAGE'
      );
    }
    const stripe = await getStripe();
    const sub = await stripe.subscriptions.retrieve(order.payment.stripeSubscriptionId, { expand: ['items.data.price.product'] });
    const item = sub.items && sub.items.data && sub.items.data[0];
    if (!item) throw new MembershipError('Stripe shows nothing being billed on this subscription, so it was not changed. Check it in the Stripe dashboard.', 409, 'STRIPE_SUBSCRIPTION_EMPTY');
    const settings = await Settings.getSettings().catch(() => null);
    const currency = resolveCurrency(pkg.currency, settings && settings.currency).toLowerCase();
    let updated;
    try {
      // The subscription's own product when it already carries this name,
      // else a new one: a subscription item is priced against a product
      // that exists (see subscriptionPriceData).
      const name = `${pkg.name} Package`;
      const current = item.price && item.price.product;
      const reusable = current && typeof current === 'object' && !current.deleted && current.active !== false && current.name === name;
      const product = reusable ? current.id : (await stripe.products.create({ name, metadata: { packageId: String(pkg._id) } })).id;
      updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price_data: subscriptionPriceData({ currency, product, amount: listPrice, billing: snapshot.billing }) }],
        proration_behavior: 'create_prorations'
      });
    } catch (error) {
      // Stripe unreachable is a gateway problem; anything else is Stripe
      // saying no (another currency, a declined card).
      const unreachable = error && (error.type === 'StripeConnectionError' || error.type === 'StripeAPIError');
      throw new MembershipError(`Stripe did not accept the change, so the membership is as it was: ${error.message}`, unreachable ? 502 : 409, 'STRIPE_CHANGE_FAILED');
    }
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

  const { applied, unused } = creditAgainst(credit, parseAmount(pkg.price));
  if (unused > 0 && !forfeitCredit) {
    const currency = String(order.payment.currency || '').toUpperCase();
    const sum = (n) => `${currency} ${n.toFixed(2)}`.trim();
    const refusal = new MembershipError(
      `This member has ${sum(credit)} of unused days already paid for, but ${pkg.name} costs only ${sum(applied)}: ${sum(unused)} would be lost. ` +
        `To give the money back, refund ${sum(credit)} of this membership and then assign ${pkg.name}. To change anyway and give up the ${sum(unused)}, confirm the change.`,
      409,
      'CREDIT_EXCEEDS_PRICE'
    );
    refusal.details = { credit, price: applied, creditUnused: unused, currency };
    throw refusal;
  }
  const givenUp = unused > 0 ? `${unused} of unused credit given up` : '';

  const replacement = await createManualOrder({
    user,
    pkg,
    paymentMethod,
    markPaid,
    startDate: now,
    discountAmount: applied,
    discountNote: `Credit for ${Math.floor(remainingDays)} unused day(s) of ${order.packageDetails && order.packageDetails.name}${givenUp ? ` (${givenUp})` : ''}`,
    notes: notes || `Changed from ${order.orderNumber} (${order.packageDetails && order.packageDetails.name})`,
    renewedFrom: order._id,
    // Nor is moving to another package: the member joined long ago.
    chargeJoiningFee: false,
    by
  });

  order.status = 'cancelled';
  order.subscription.isActive = false;
  order.subscription.endDate = now;
  order.cancellation = {
    cancelledAt: now,
    reason: `Changed to ${pkg.name} (${replacement.orderNumber})${givenUp ? `; ${givenUp}` : ''}`,
    // An account id or nothing: `by` is a name (the desk's email), and
    // writing that here failed the save -- after the new order was made,
    // leaving the member with both.
    by: changedBy && mongoose.Types.ObjectId.isValid(String(changedBy)) ? changedBy : null,
    source: 'staff',
    immediate: true
  };
  await order.save();

  return { order: replacement, previous: order, credit: applied, creditUnused: unused };
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

  // What came in, which on an order paid in part is less than its total.
  const paidAmount = paidSoFar(order.payment);
  if (!(paidAmount > 0)) {
    throw new MembershipError('Nothing has been paid on this order yet, so there is nothing to refund. Cancel it instead.', 400);
  }
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
          // A refunded membership is over: nothing more is owed on it.
          'payment.balanceDue': 0,
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
  order.payment.balanceDue = 0;
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
  periodLength,
  periodProblem,
  termEnd,
  startDateFor,
  joiningFeeDue,
  checkoutIdentity,
  provenEmail,
  applyCoupon,
  redeemCoupon,
  assertNoActiveSubscription,
  markPaidAndActivate,
  readRequestId,
  isRepeat,
  readDeskTerms,
  commissionOn,
  createManualOrder,
  stripeBilled,
  recordPayment,
  editTerms,
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
  creditAgainst,
  subscriptionPriceData,
  changePackage,
  consumeSession,
  refundSession,
  refund,
  billingPortalUrl,
  membershipSettings
};
