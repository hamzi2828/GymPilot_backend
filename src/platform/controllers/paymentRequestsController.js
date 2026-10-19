// src/platform/controllers/paymentRequestsController.js
//
// "Payments to verify": the bank-transfer receipts gyms uploaded to pay
// GymsPilotPro, for the super admin to approve or reject
// (services/paymentRequests.js). Mounted under /api/platform behind
// platformAuth; every decision is written to the audit log.
//
//   GET  /api/platform/payment-requests?status=pending&gymId=&page=&limit=
//        -> { success, data: [request], total }
//   POST /api/platform/payment-requests/:id/approve   {}
//        -> { success, data: { request, payment, subscription }, emailed, duplicate }
//   POST /api/platform/payment-requests/:id/reject    { reason }
//        -> { success, data: { request }, emailed }

const PlatformAuditLog = require('../models/platformAuditLogModel');
const paymentRequests = require('../services/paymentRequests');
const manualPayments = require('../services/manualPayments');
const { PlatformPayError } = require('../services/platformPay');

function fail(res, error) {
  if (error instanceof PlatformPayError || error instanceof manualPayments.ManualPaymentError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.error('[platform] payment requests:', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

function audit(req, action, request, meta) {
  return PlatformAuditLog.record({
    actorId: req.superAdmin._id,
    actorEmail: req.superAdmin.email,
    action,
    gymId: request ? request.gymId : null,
    gymSlug: request ? request.gymSlug : '',
    meta,
    ip: String(req.ip || '')
  });
}

module.exports = {
  // GET /api/platform/payment-requests
  list: async (req, res) => {
    try {
      const q = req.query || {};
      const mongoose = require('mongoose');
      const gymId = q.gymId && mongoose.Types.ObjectId.isValid(String(q.gymId)) ? q.gymId : undefined;
      const { data, total } = await paymentRequests.listRequests({ status: q.status, gymId, page: q.page, limit: q.limit });
      return res.json({ success: true, data, total });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/platform/payment-requests/:id/approve
  approve: async (req, res) => {
    try {
      const outcome = await paymentRequests.approve({ id: req.params.id, actor: req.superAdmin });
      const request = paymentRequests.publicRequest(outcome.request);
      const payment = outcome.payment ? manualPayments.publicPayment(outcome.payment) : null;
      if (!outcome.duplicate) {
        audit(req, 'gym_payment_request_approved', outcome.request, {
          requestId: request.id,
          paymentId: payment && payment.id,
          amount: request.amount,
          currency: request.currency,
          reference: payment && payment.reference,
          paidUntil: payment && payment.periodTo,
          emailed: outcome.emailed
        });
      }
      return res.json({
        success: true,
        message: outcome.duplicate ? 'Already approved.' : 'Approved. The payment is recorded.',
        data: { request, payment, subscription: paymentRequests.subscriptionView(outcome.gym) },
        emailed: !!outcome.emailed,
        duplicate: !!outcome.duplicate
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/platform/payment-requests/:id/reject   { reason }
  reject: async (req, res) => {
    try {
      const outcome = await paymentRequests.reject({ id: req.params.id, reason: req.body && req.body.reason, actor: req.superAdmin });
      const request = paymentRequests.publicRequest(outcome.request);
      if (!outcome.duplicate) audit(req, 'gym_payment_request_rejected', outcome.request, { requestId: request.id, reason: request.reason, emailed: outcome.emailed });
      return res.json({ success: true, message: 'Rejected. The gym is shown why.', data: { request }, emailed: !!outcome.emailed });
    } catch (error) {
      return fail(res, error);
    }
  }
};
