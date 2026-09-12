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

// A claim is refused once the order is paid, or while another caller holds
// it. Anything else -- pending, failed, cancelled, refunded -- may be
// claimed: Stripe is the authority on whether the money arrived.
const BLOCKING = new Set(['paid', 'processing']);

const CLAIMED_STATUS = 'processing';

/** Whether an order whose payment is in `paymentStatus` may be claimed. */
function canClaimActivation(paymentStatus) {
  return !BLOCKING.has(String(paymentStatus || ''));
}

/** The filter that wins the claim only when nobody else has. */
function claimFilter(orderId) {
  return { _id: orderId, 'payment.status': { $nin: [...BLOCKING] } };
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
  CLAIMED_STATUS,
  canClaimActivation,
  claimFilter,
  claimUpdate,
  releaseFilter,
  releaseUpdate
};
