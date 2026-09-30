// src/services/paymentMethods.js
//
// The ways a membership can be paid for, and what each is called on screen,
// on invoices and in reports. The package order's `payment.method` enum is
// this list, so a method cannot be stored that nothing knows how to label.
//
//   stripe         a card payment through the gym's Stripe (online checkout,
//                  or a subscription Stripe renews); refunds go back through
//                  Stripe
//   card           a card taken on the desk's own terminal; the money moves
//                  outside this system, like cash
//   bank_transfer  a transfer to one of the gym's accounts (Settings → Banks)
//   cash
//   jazzcash, easypaisa, wallet
//                  mobile wallets, common where gyms are paid by phone;
//                  `wallet` is any other one
//
// A method this list does not have is refused (422), never quietly filed as
// cash: the desk's takings by method would otherwise be wrong without anyone
// being told.

const PAYMENT_METHODS = ['stripe', 'card', 'bank_transfer', 'cash', 'jazzcash', 'easypaisa', 'wallet'];

const METHOD_LABELS = {
  stripe: 'Card (Stripe)',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  wallet: 'Other mobile wallet'
};

// What staff may record by hand. A Stripe payment is only ever made through
// Stripe: recorded at the desk, a later refund would go looking for a card
// charge that does not exist.
const DESK_METHODS = PAYMENT_METHODS.filter((method) => method !== 'stripe');

function isPaymentMethod(value) {
  return PAYMENT_METHODS.includes(value);
}

/** The label for a method; an unknown value is shown as it is. */
function methodLabel(value) {
  return METHOD_LABELS[value] || String(value || '');
}

/**
 * A method sent by staff, read strictly.
 *
 * Nothing sent (undefined, null, '') is `fallback`. Anything else must be one
 * of `allowed` exactly -- 'Cash' or 'paypal' is not quietly turned into cash.
 *
 * @returns {{ method: string|null, problem: string|null }} method, or the
 *   sentence to answer with when it cannot be used
 */
function readDeskMethod(value, { fallback = 'cash', allowed = DESK_METHODS } = {}) {
  if (value === undefined || value === null || value === '') return { method: fallback, problem: null };
  if (allowed.includes(value)) return { method: value, problem: null };
  if (value === 'stripe') {
    return { method: null, problem: 'Card (Stripe) payments are taken through online checkout. For a card taken on the desk terminal, choose Card.' };
  }
  const offered = allowed.map((method) => `${method} (${METHOD_LABELS[method]})`).join(', ');
  return { method: null, problem: `"${value}" is not a payment method this gym records. Use one of: ${offered}.` };
}

module.exports = {
  PAYMENT_METHODS,
  METHOD_LABELS,
  DESK_METHODS,
  isPaymentMethod,
  methodLabel,
  readDeskMethod
};
