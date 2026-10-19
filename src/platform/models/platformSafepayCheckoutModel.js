// src/platform/models/platformSafepayCheckoutModel.js
//
// A Safepay checkout a gym opened from its Billing tab to pay GymsPilotPro
// (services/platformSafepay.js), one row per Safepay tracker: what it asked
// for and what paying it does -- the cycle, and the plan when the owner
// picked another one. The platform webhook finds it by tracker, records the
// payment once (manualPayments.recordPayment) and marks it paid; a payment
// delivered twice finds it paid.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const STATUSES = ['pending', 'paid', 'failed', 'refunded'];

const platformSafepayCheckoutSchema = new mongoose.Schema(
  {
    tracker: { type: String, required: true, trim: true },
    orderRef: { type: String, default: '', trim: true },
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
    gymSlug: { type: String, default: '', trim: true },
    environment: { type: String, default: 'sandbox' },
    // What was asked, in major units and in Safepay's minor units.
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    billingCycle: { type: String, default: 'monthly' },
    // What paying moves the subscription to beside the date, when the owner
    // picked another plan or cycle: { plan, billingCycle, planAmount, addons,
    // amount, currency }. Null: the subscription as it is.
    change: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: STATUSES, default: 'pending' },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPayment', default: null },
    paidAt: { type: Date, default: null },
    // Why a paid tracker was not applied (the gym moved to Stripe since, say).
    error: { type: String, default: '', maxlength: 500 },
    openedBy: {
      id: { type: String, default: '' },
      email: { type: String, default: '' }
    }
  },
  {
    timestamps: true,
    collection: 'platform_safepay_checkouts'
  }
);

platformSafepayCheckoutSchema.index({ tracker: 1 }, { unique: true });
platformSafepayCheckoutSchema.index({ gymId: 1, createdAt: -1 });

platformSafepayCheckoutSchema.statics.STATUSES = STATUSES;

module.exports = platformModel('PlatformSafepayCheckout', platformSafepayCheckoutSchema);
