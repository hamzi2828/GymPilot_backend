// src/gymfolio/services/activationClaim.js
//
// Who gets to activate a Stripe-paid order.
//
// Three callers can learn that the money arrived: the success page's verify
// call, the checkout.session.completed webhook, and payment_intent.succeeded
// or invoice.paid a moment later. Each used to check "not paid yet" and then
// activate, so two arriving together both activated -- two invoice numbers,
// two coupon redemptions, two confirmation emails. Now each first CLAIMS the
// order with one conditional update; only the caller that wins the claim
// activates, the rest read back the order the winner produced.
//
// The claim marks the payment 'processing'. A claim whose activation then
// fails is released back to the status it had, so a retry can win it again
// instead of finding the order stuck.
//
// Pure decisions live here so they can be unit-tested; the database calls
// that apply them are in gymfolioPaymentService.

// A claim is refused once the order is paid, while another caller holds it,
// and once the sale has been undone:
//
//   refunded   the money went back (membershipService.refund) and the
//              membership was ended. A late or redelivered event for the
//              original payment -- payment_intent.succeeded, invoice.paid,
//              the member reopening the success page -- is news of money
//              that has since been returned, not a new payment, and must not
//              hand the membership back.
//   cancelled  a payment called off for good. Nothing in this system writes
//              it today; it is terminal by meaning, so it is treated like
//              'refunded' rather than revived by whatever arrives later.
//
// 'pending' and 'failed' may still be claimed: Stripe is the authority on
// whether the money arrived. An order closed because its checkout expired or
// a card was declined ('failed', order 'cancelled') is activated if the
// money then does arrive -- the member paid, so they get what they paid for.
//
// The order's own status is not consulted. The lifecycle statuses
// ('active', 'frozen', 'past_due', 'expired') follow a paid payment, which
// is blocked above, and a paid membership that is cancelled keeps its
// payment 'paid'. An unpaid order closed by hand is treated like an expired
// checkout: if the money then arrives, the order is activated.
const BLOCKING = new Set(['paid', 'processing']);
const UNDONE = new Set(['refunded', 'cancelled']);
const REFUSED = [...BLOCKING, ...UNDONE];

const CLAIMED_STATUS = 'processing';

/** Whether an order whose payment is in `paymentStatus` may be claimed. */
function canClaimActivation(paymentStatus) {
  const status = String(paymentStatus || '');
  return !BLOCKING.has(status) && !UNDONE.has(status);
}

/**
 * The filter that wins the claim only when nobody else has -- and never on
 * an order whose sale was undone, even if it was undone after the caller
 * read it (a refund landing between the read and the claim).
 */
function claimFilter(orderId) {
  return { _id: orderId, 'payment.status': { $nin: [...REFUSED] } };
}

/** The update that takes the claim. */
function claimUpdate() {
  return { $set: { 'payment.status': CLAIMED_STATUS } };
}

/**
 * Releases a claim that could not be completed: back to the status the
 * order had, and only if it is still held (a winner that finished in the
 * meantime must not be un-paid).
 */
function releaseFilter(orderId) {
  return { _id: orderId, 'payment.status': CLAIMED_STATUS };
}

function releaseUpdate(previousStatus) {
  const back = canClaimActivation(previousStatus) ? String(previousStatus || 'pending') : 'pending';
  return { $set: { 'payment.status': back } };
}

module.exports = {
  BLOCKING_STATUSES: [...BLOCKING],
  UNDONE_STATUSES: [...UNDONE],
  CLAIMED_STATUS,
  canClaimActivation,
  claimFilter,
  claimUpdate,
  releaseFilter,
  releaseUpdate
};
