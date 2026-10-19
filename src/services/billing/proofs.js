// src/services/billing/proofs.js
//
// Paying a payment link by bank transfer: the member transfers to one of the
// gym's accounts (Raast / IBFT, no fee), uploads the receipt on the link's
// page, and the order goes into the SAME bank-transfer verification the
// member's own receipt upload uses (membershipService.submitTransferProof):
// payment.method 'bank_transfer', payment.status 'processing', the receipt
// on payment.proof, the admin bell's "Bank transfers to confirm". Staff then
// approve it (paid, the term renewed, the receipt sent) or reject it.
//
// A rejected payment-link order is reopened rather than closed -- so the
// same link takes a new receipt (or a card payment) -- while its link still
// works: it keeps payment.method 'bank_transfer' and payment.status
// 'failed' as rejectTransfer left them, but its status is 'pending' again
// instead of 'cancelled'. Every other bank transfer is closed on rejection,
// as it always was.

const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const { metadataOf, isDueRenewal } = require('./dueRenewals');

/** Whether an order is paid through a payment link: a renewal it was made for, or one whose receipt came through one. */
function isPayLinkOrder(order) {
  return isDueRenewal(order) || metadataOf(order, 'proofVia') === 'pay_link';
}

/**
 * Where the order's bank-transfer receipt stands, for the link's page:
 * { status: 'none'|'submitted'|'approved'|'rejected', reason, submitted_at }.
 */
function proofView(order) {
  const payment = (order && order.payment) || {};
  const proof = payment.proof || {};
  const submittedAt = proof.uploadedAt || null;
  const none = { status: 'none', reason: '', submitted_at: submittedAt };
  if (!submittedAt && !proof.reference) return { ...none, submitted_at: null };
  if (payment.status === 'paid') return payment.method === 'bank_transfer' ? { status: 'approved', reason: '', submitted_at: submittedAt } : none;
  if (payment.status === 'processing' && payment.method === 'bank_transfer') return { status: 'submitted', reason: '', submitted_at: submittedAt };
  if (metadataOf(order, 'proofRejectedAt') || proof.rejectionReason || (proof.reviewedAt && payment.status === 'failed')) {
    return { status: 'rejected', reason: proof.rejectionReason || '', submitted_at: submittedAt };
  }
  return none;
}

/**
 * Puts an order paid through a link into the bank-transfer queue's hands:
 * method 'bank_transfer', and a 'failed' payment (a declined card, a
 * rejected receipt) back to 'pending' so a receipt can be sent for it. Only an order still waiting for its money
 * -- never one a gateway is recording a payment on right now.
 * @returns {Promise<object|null>} the order as it now is, or null when it changed under us
 */
async function readyForReceipt(order) {
  const payment = order.payment || {};
  if (payment.method === 'bank_transfer' && ['pending', 'processing'].includes(payment.status)) {
    if (metadataOf(order, 'proofVia') !== 'pay_link') {
      await PackageOrder.updateOne({ _id: order._id }, { $set: { 'metadata.proofVia': 'pay_link' } });
    }
    return PackageOrder.findById(order._id);
  }
  const updated = await PackageOrder.findOneAndUpdate(
    { _id: order._id, status: 'pending', 'payment.status': { $in: ['pending', 'failed'] } },
    { $set: { 'payment.method': 'bank_transfer', 'payment.status': 'pending', 'metadata.proofVia': 'pay_link' } },
    { new: true }
  );
  return updated;
}

/**
 * After staff reject a payment-link order's receipt (membershipService.
 * rejectTransfer): open it again for a new receipt while its link works,
 * keeping the reason. Anything else is left as rejectTransfer closed it.
 * @returns {Promise<object|null>} the reopened order, or null when it is not one to reopen
 */
async function reopenAfterRejection(order, now = new Date()) {
  if (!order || !isPayLinkOrder(order)) return null;
  const { linkExpiry } = require('./payLinks');
  if (linkExpiry(order, now).getTime() <= now.getTime()) return null;
  const reason = (order.payment && order.payment.proof && order.payment.proof.rejectionReason) || '';
  return PackageOrder.findOneAndUpdate(
    { _id: order._id, status: 'cancelled', 'payment.status': 'failed' },
    {
      $set: {
        status: 'pending',
        'payment.lastPaymentError': reason ? `Transfer not accepted: ${reason}` : 'Transfer not accepted',
        // Free for the next receipt (reviewable() waits out a recent review).
        'payment.proof.reviewedAt': null,
        'cancellation.cancelledAt': null,
        'cancellation.reason': '',
        'metadata.proofRejectedAt': now.toISOString()
      }
    },
    { new: true }
  );
}

module.exports = { isPayLinkOrder, proofView, readyForReceipt, reopenAfterRejection };
