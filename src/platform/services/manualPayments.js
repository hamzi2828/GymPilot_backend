// src/platform/services/manualPayments.js
//
// A gym paying the platform outside Stripe -- a bank transfer, JazzCash,
// Easypaisa, cash -- recorded by hand from the panel. One payment does three
// things: it is kept as a row of the gym's payment history
// (models/platformPaymentModel.js), it moves the gym's paid-until date
// forward, and it makes the subscription active again whatever it was
// (trialing, past due, expired, cancelled), so a gym that lapsed for not
// paying is served again the moment its payment is typed in.
//
// The daily roll-over (jobs.js rollFilters) needs nothing more: a gym with
// no Stripe subscription goes past due when `currentPeriodEnd` passes, and
// this is what moves that date -- to the next cycle, each time it pays.
//
// A gym that pays by card is refused here. Stripe records its payments and
// moves its period itself (services/platformWebhook.js); a date moved by
// hand as well would be overwritten by the next event.

const Gym = require('../models/gymModel');
const PlatformPayment = require('../models/platformPaymentModel');
const { invalidateTenantCache } = require('../middleware/resolveTenant');

const METHOD_LABELS = {
  bank_transfer: 'Bank transfer',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  cash: 'Cash',
  other: 'Other'
};
// These always come with a transaction id; without it the payment cannot be
// found again on the statement.
const REFERENCE_REQUIRED = new Set(['bank_transfer', 'jazzcash', 'easypaisa']);
const DAY_MS = 86400000;
const MAX_AMOUNT = 1e9;
const HISTORY_LIMIT = 100;

const NO_NOTICES = { trial7: null, trial3: null, trial1: null, pastDue: null, expired: null, cancelled: null };

class ManualPaymentError extends Error {
  constructor(message, status = 400, code = 'MANUAL_PAYMENT') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** A date as the panel sends it ("2026-11-09", or a full timestamp), or null. */
function dateOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayLabel(date) {
  return date ? new Date(date).toISOString().slice(0, 10) : '';
}

/**
 * One billing cycle on from `date`: the same day next month, or next year.
 * A day the month does not have is its last one (31 January -> 28 February).
 */
function addCycle(date, billingCycle) {
  const from = new Date(date);
  const months = billingCycle === 'yearly' ? 12 : 1;
  const first = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return first;
}

/**
 * Where a payment takes a gym's paid-until date by default: one cycle on
 * from the later of today and the date it is already paid until. Paying
 * early loses nothing (the rest of a trial included), and paying after a
 * lapse buys a full cycle from today rather than one that is half over.
 *
 * @returns {{ from: Date, paidUntil: Date }} both at the start of a UTC day
 */
function nextPaidUntil(subscription, now = new Date()) {
  const sub = subscription || {};
  const end = dateOf(sub.currentPeriodEnd);
  const from = startOfUtcDay(end && end.getTime() > now.getTime() ? end : now);
  return { from, paidUntil: addCycle(from, sub.billingCycle) };
}

/** Why a payment cannot be recorded by hand for this gym, or null when it can. */
function refusalFor(gym) {
  const sub = (gym && gym.subscription) || {};
  if (sub.stripeSubscriptionId) {
    return 'This gym pays by card through Stripe, which records its payments itself. To bill it by hand instead, cancel its Stripe subscription first.';
  }
  return null;
}

/**
 * What the panel shows before a payment is saved: whether one can be
 * recorded, and the amount and paid-until date it starts from.
 */
function paymentTerms(gym, now = new Date()) {
  const sub = (gym && gym.subscription) || {};
  const refusal = refusalFor(gym);
  const next = nextPaidUntil(sub, now);
  return {
    canRecord: !refusal,
    reason: refusal || '',
    amount: Number(sub.amount) || 0,
    currency: String(sub.currency || 'PKR').toUpperCase(),
    billingCycle: sub.billingCycle === 'yearly' ? 'yearly' : 'monthly',
    paidFrom: next.from,
    paidUntil: next.paidUntil,
    methods: PlatformPayment.schema.statics.METHODS.map((value) => ({ value, label: METHOD_LABELS[value] }))
  };
}

/**
 * Checks what the panel sent. Returns `{ errors, data }`; with no errors,
 * `data` is the payment ready to store.
 */
function validatePayment(body, gym, now = new Date()) {
  const b = body && typeof body === 'object' ? body : {};
  const sub = (gym && gym.subscription) || {};
  const errors = [];

  const amount = Number(b.amount);
  if (b.amount === '' || b.amount === null || b.amount === undefined || !Number.isFinite(amount) || amount <= 0) errors.push('Enter the amount received');
  else if (amount > MAX_AMOUNT) errors.push('That amount is too large');

  const method = text(b.method, 40).toLowerCase();
  if (!METHOD_LABELS[method]) errors.push('Choose how it was paid');

  const receivedAt = b.receivedAt === undefined || b.receivedAt === null || b.receivedAt === '' ? startOfUtcDay(now) : dateOf(b.receivedAt);
  if (!receivedAt) errors.push('The date received is not a valid date');
  // A day's slack: the admin's "today" may be tomorrow in UTC.
  else if (receivedAt.getTime() > now.getTime() + DAY_MS) errors.push('The date received cannot be in the future');

  const reference = text(b.reference, 120);
  if (!reference && REFERENCE_REQUIRED.has(method)) errors.push(`Enter the ${METHOD_LABELS[method]} reference (the transaction id)`);

  const next = nextPaidUntil(sub, now);
  const paidUntil = b.paidUntil === undefined || b.paidUntil === null || b.paidUntil === '' ? next.paidUntil : dateOf(b.paidUntil);
  const currentEnd = dateOf(sub.currentPeriodEnd);
  if (!paidUntil) errors.push('Paid until is not a valid date');
  else if (paidUntil.getTime() <= now.getTime()) errors.push('Paid until must be a date in the future');
  else if (currentEnd && paidUntil.getTime() <= currentEnd.getTime()) errors.push(`This gym is already paid until ${dayLabel(currentEnd)}. Paid until must be later than that.`);

  const requestId = text(b.requestId, 100);
  if (requestId.length < 8) errors.push('This form is missing its request id. Reload the page and try again.');

  return {
    errors,
    data: {
      amount,
      currency: String(sub.currency || 'PKR').toUpperCase(),
      method,
      receivedAt,
      reference,
      note: text(b.note, 1000),
      periodFrom: currentEnd,
      periodTo: paidUntil,
      billingCycle: sub.billingCycle === 'yearly' ? 'yearly' : 'monthly',
      statusBefore: sub.status || '',
      requestId
    }
  };
}

/**
 * Records one payment for a gym and brings its subscription up to date.
 *
 * The same `requestId` again is the same payment: the row already stored is
 * returned (`duplicate: true`) and nothing moves a second time -- a double
 * click, or a retry after a slow answer, even when the first click is saved
 * while the second is being checked. A different form with a reference
 * already on record for the gym is refused (409 `DUPLICATE_REFERENCE`): the
 * same transfer typed in twice. Both rules are backed by unique indexes
 * (models/platformPaymentModel.js), so two requests at once cannot get
 * round them.
 *
 * @param {object} args
 * @param {object} args.gym    the gym document (lean or not)
 * @param {object} args.input  the request body
 * @param {object} [args.actor] the super admin: { _id, email }
 * @returns {Promise<{payment: object, duplicate: boolean}>}
 * @throws {ManualPaymentError} with `status` and `code`
 */
async function recordPayment({ gym, input, actor = null, now = new Date() }) {
  const refusal = refusalFor(gym);
  if (refusal) throw new ManualPaymentError(refusal, 409, 'STRIPE_BILLED');

  const requestId = text(input && input.requestId, 100);
  const already = requestId ? await PlatformPayment.findOne({ gymId: gym._id, requestId }).lean() : null;
  if (already) return { payment: already, duplicate: true };

  const { errors, data } = validatePayment(input, gym, now);
  if (errors.length) throw new ManualPaymentError(errors[0], 400, 'INVALID_PAYMENT');

  // The same transfer typed into a second form is refused -- but a row with
  // this reference made by THIS form is this payment: the first of two
  // clicks, saved between this one's lookup by request id and this one.
  const sameReference = () => (data.reference ? PlatformPayment.findOne({ gymId: gym._id, method: data.method, reference: data.reference }).lean() : null);
  const duplicateReference = (same) =>
    new ManualPaymentError(
      `A ${METHOD_LABELS[data.method]} payment with reference "${data.reference}" is already recorded for this gym (received ${dayLabel(same.receivedAt)}).`,
      409,
      'DUPLICATE_REFERENCE'
    );
  const same = await sameReference();
  if (same) {
    if (same.requestId === requestId) return { payment: same, duplicate: true };
    throw duplicateReference(same);
  }

  let payment;
  try {
    payment = await PlatformPayment.create({
      ...data,
      gymId: gym._id,
      gymSlug: gym.slug,
      recordedBy: { id: actor ? actor._id : null, email: (actor && actor.email) || '' }
    });
  } catch (error) {
    if (!error || error.code !== 11000) throw error;
    // Two clicks that raced past both lookups above: a unique index -- the
    // request id's, or the reference's -- let one in.
    const first = await PlatformPayment.findOne({ gymId: gym._id, requestId }).lean();
    if (first) return { payment: first, duplicate: true };
    const taken = await sameReference();
    if (taken) throw duplicateReference(taken);
    throw error;
  }

  const set = {
    'subscription.status': 'active',
    'subscription.currentPeriodEnd': data.periodTo,
    'subscription.pastDueSince': null,
    'subscription.cancelledAt': null
  };
  if (!(gym.subscription && gym.subscription.startedAt)) set['subscription.startedAt'] = now;
  // A new period: its reminders start again.
  for (const [key, value] of Object.entries(NO_NOTICES)) set[`subscription.notices.${key}`] = value;
  try {
    await Gym.updateOne({ _id: gym._id }, { $set: set });
  } catch (error) {
    // A payment on record that paid for nothing would be worse than none.
    await PlatformPayment.deleteOne({ _id: payment._id }).catch(() => {});
    throw error;
  }
  invalidateTenantCache();

  return { payment: payment.toObject ? payment.toObject() : payment, duplicate: false };
}

/** A gym's recorded payments, newest first. */
function listPayments(gymId) {
  return PlatformPayment.find({ gymId }).sort({ receivedAt: -1, createdAt: -1 }).limit(HISTORY_LIMIT).lean();
}

function publicPayment(row) {
  return {
    id: String(row._id),
    amount: row.amount,
    currency: row.currency,
    method: row.method,
    methodLabel: METHOD_LABELS[row.method] || row.method,
    receivedAt: row.receivedAt,
    reference: row.reference || '',
    note: row.note || '',
    periodFrom: row.periodFrom || null,
    periodTo: row.periodTo,
    statusBefore: row.statusBefore || '',
    recordedBy: (row.recordedBy && row.recordedBy.email) || '',
    createdAt: row.createdAt
  };
}

module.exports = {
  ManualPaymentError,
  METHOD_LABELS,
  addCycle,
  nextPaidUntil,
  paymentTerms,
  validatePayment,
  recordPayment,
  listPayments,
  publicPayment
};
