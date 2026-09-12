// src/gymfolio/services/stripeShapes.js
//
// Reading the fields this system needs off Stripe objects, whichever API
// version produced them.
//
// Stripe's 2025-03-31 ("basil") release moved things around: an invoice no
// longer carries `subscription` or `payment_intent` at the top level (they
// live under `parent.subscription_details.subscription` and `payments`), and
// a subscription's `current_period_start/end` moved onto each subscription
// item. A webhook event is shaped by the API version the gym's endpoint is
// pinned to -- which this code does not control -- so every read here
// accepts both shapes. Pure functions, no Stripe client, so they can be
// unit-tested against literal objects.

/** The id of an expandable field: a bare id string, or an expanded object. */
function idOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return typeof value === 'object' && value.id ? value.id : null;
}

/** The subscription an invoice belongs to, or null for a one-off invoice. */
function subscriptionIdOf(invoice) {
  if (!invoice) return null;
  const parent = invoice.parent && invoice.parent.subscription_details;
  return idOf(invoice.subscription) || idOf(parent && parent.subscription) || null;
}

function toDate(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/**
 * The current billing period of a subscription as Dates.
 * @returns {{ start: Date|null, end: Date|null }}
 */
function periodOf(subscription) {
  if (!subscription) return { start: null, end: null };
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  return {
    start: toDate(subscription.current_period_start) || toDate(item && item.current_period_start),
    end: toDate(subscription.current_period_end) || toDate(item && item.current_period_end)
  };
}

/** The PaymentIntent that paid an invoice, or null when it has none yet. */
function paymentIntentOf(invoice) {
  if (!invoice) return null;
  const direct = idOf(invoice.payment_intent);
  if (direct) return direct;
  const payments = invoice.payments && invoice.payments.data;
  if (Array.isArray(payments)) {
    for (const entry of payments) {
      const pi = entry && entry.payment && idOf(entry.payment.payment_intent);
      if (pi) return pi;
    }
  }
  return null;
}

/** The billing period an invoice line covers, from its first dated line. */
function invoicePeriodOf(invoice) {
  const lines = invoice && invoice.lines && invoice.lines.data;
  const line = Array.isArray(lines) ? lines.find((l) => l && l.period && l.period.end) : null;
  return {
    start: line ? toDate(line.period.start) : null,
    end: line ? toDate(line.period.end) : null
  };
}

module.exports = { idOf, subscriptionIdOf, periodOf, paymentIntentOf, invoicePeriodOf };
