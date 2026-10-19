// src/platform/models/platformPaymentRequestModel.js
//
// A gym saying "we have paid GymsPilotPro by bank transfer -- here is the
// receipt", waiting for the super admin (services/paymentRequests.js). One
// pending request per gym at a time: a new upload replaces the pending one.
// Approving it records the payment through manualPayments.recordPayment (and
// `paymentId` points at it); rejecting it keeps the reason, which the gym's
// Billing tab shows until it uploads again. Never deleted: this is the trail
// of what each gym sent.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const STATUSES = ['pending', 'approved', 'rejected'];

const platformPaymentRequestSchema = new mongoose.Schema(
  {
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
    gymSlug: { type: String, default: '', trim: true },
    gymName: { type: String, default: '', trim: true },
    // What it pays for, worked out on the server when it was sent
    // (platformPay.payTerms) -- never what the browser said.
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    billingCycle: { type: String, default: 'monthly' },
    // What approving it moves the subscription to beside the date, when the
    // gym paid for another cycle: as on a Safepay checkout. Null: nothing.
    change: { type: mongoose.Schema.Types.Mixed, default: null },
    receiptUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    reference: { type: String, default: '', trim: true, maxlength: 120 },
    note: { type: String, default: '', trim: true, maxlength: 1000 },
    submittedAt: { type: Date, required: true },
    submittedBy: {
      id: { type: String, default: '' },
      email: { type: String, default: '' },
      name: { type: String, default: '' }
    },
    status: { type: String, enum: STATUSES, default: 'pending' },
    reason: { type: String, default: '', trim: true, maxlength: 500 },
    reviewedAt: { type: Date, default: null },
    reviewedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'SuperAdmin', default: null },
      email: { type: String, default: '' }
    },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPayment', default: null },
    // Set while an approval is being recorded: a rejection, or the gym
    // replacing the receipt, waits for it rather than racing it.
    approvingAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    collection: 'platform_payment_requests'
  }
);

// One pending request per gym, however two uploads race.
platformPaymentRequestSchema.index({ gymId: 1 }, { unique: true, name: 'one_pending_per_gym', partialFilterExpression: { status: 'pending' } });
platformPaymentRequestSchema.index({ gymId: 1, submittedAt: -1 });
platformPaymentRequestSchema.index({ status: 1, submittedAt: -1 });

platformPaymentRequestSchema.statics.STATUSES = STATUSES;

module.exports = platformModel('PlatformPaymentRequest', platformPaymentRequestSchema);
