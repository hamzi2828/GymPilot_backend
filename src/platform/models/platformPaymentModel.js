// src/platform/models/platformPaymentModel.js
//
// A gym's payments to the platform that did not come through Stripe: a bank
// transfer, JazzCash, Easypaisa, cash -- recorded by hand from the panel, or
// by approving a receipt the gym uploaded -- and a payment through
// GymsPilotPro's own Safepay account, recorded by its webhook (all through
// services/manualPayments.js), one row per payment, and never edited
// afterwards -- this is the gym's payment history. Stripe card payments are
// not here: Stripe keeps those.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const METHODS = ['bank_transfer', 'jazzcash', 'easypaisa', 'cash', 'other', 'safepay'];
// What the panel's "Record payment" form offers: Safepay payments are
// recorded by Safepay's webhook, not typed in.
const MANUAL_METHODS = METHODS.filter((method) => method !== 'safepay');

const platformPaymentSchema = new mongoose.Schema(
  {
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
    gymSlug: { type: String, default: '', trim: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    method: { type: String, required: true, enum: METHODS },
    // When the money arrived, as the admin said -- not when it was typed in
    // (that is createdAt).
    receivedAt: { type: Date, required: true },
    // The bank's or wallet's transaction id, or a receipt number.
    reference: { type: String, default: '', trim: true, maxlength: 120 },
    note: { type: String, default: '', trim: true, maxlength: 1000 },
    // What it paid for: the gym was paid until `periodFrom` before, and
    // until `periodTo` after.
    periodFrom: { type: Date, default: null },
    periodTo: { type: Date, required: true },
    billingCycle: { type: String, default: 'monthly' },
    // The subscription status it found, so the history shows a gym that was
    // brought back from "expired".
    statusBefore: { type: String, default: '' },
    recordedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'SuperAdmin', default: null },
      email: { type: String, default: '' }
    },
    // Made up by the panel for each time the form is opened. A second click
    // on Save sends the same one, and is the same payment.
    requestId: { type: String, required: true, trim: true, maxlength: 100 }
  },
  {
    timestamps: true,
    collection: 'platform_payments'
  }
);

platformPaymentSchema.index({ gymId: 1, requestId: 1 }, { unique: true });
platformPaymentSchema.index({ gymId: 1, createdAt: -1 });
// One payment per transaction id: the same transfer typed into two forms at
// once both pass the service's lookup, and this lets only one be recorded.
// A payment without a reference (cash, other) is not indexed: any number of
// those may be on record.
platformPaymentSchema.index(
  { gymId: 1, method: 1, reference: 1 },
  { unique: true, name: 'one_payment_per_reference', partialFilterExpression: { reference: { $gt: '' } } }
);

platformPaymentSchema.statics.METHODS = METHODS;
platformPaymentSchema.statics.MANUAL_METHODS = MANUAL_METHODS;

module.exports = platformModel('PlatformPayment', platformPaymentSchema);
