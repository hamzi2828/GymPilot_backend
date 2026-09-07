// packageOrderModel.js - Package Order Model for Gymfolio Package Subscriptions

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const packageOrderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false // Can be null for guest checkouts
    },
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Package',
      required: true
    },
    packageDetails: {
      name: { type: String, required: true },
      price: { type: String, required: true },
      currency: { type: String, required: true },
      period: { type: String, required: true },
      features: [String],
      // Snapshot of the package's shape at the time of sale (see
      // membershipService.packageSnapshot). Older orders have none of these
      // and are treated as plain memberships.
      kind: { type: String, default: 'membership' },
      durationDays: { type: Number, default: 0 },
      sessions: { type: Number, default: 0 },
      joiningFee: { type: Number, default: 0 },
      billing: {
        mode: { type: String, default: 'one_time' },
        interval: { type: String, default: 'month' },
        intervalCount: { type: Number, default: 1 },
        trialDays: { type: Number, default: 0 }
      }
    },
    // Who the membership is for. Name and email are required because an order
    // that identifies nobody is not an order.
    //
    // Phone and country are NOT required, deliberately. They come from the
    // public checkout form, which asks for them -- but an admin assigning a
    // membership at the desk has no such form, and when they were required
    // that path wrote the literal string 'N/A' into both to get past
    // validation. That made "no phone number" indistinguishable from a member
    // whose number really is on file, and put 'N/A' on the receipt. An empty
    // field says the same thing honestly, and the admin screens can then
    // prompt for what is actually missing.
    customerInfo: {
      fullName: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, default: '' },
      country: { type: String, default: '' },
      address: String,
      city: String,
      state: String,
      zipCode: String
    },
    payment: {
      method: {
        type: String,
        enum: ['stripe', 'card', 'bank_transfer', 'cash'],
        default: 'stripe'
      },
      stripeSessionId: String,
      stripePaymentIntentId: String,
      stripeCustomerId: String,
      amount: {
        type: Number,
        required: true
      },
      currency: {
        type: String,
        required: true,
        default: 'pkr'
      },
      status: {
        type: String,
        enum: ['pending', 'processing', 'paid', 'failed', 'refunded', 'cancelled'],
        default: 'pending'
      },
      paidAt: Date,
      transactionId: String,

      // ---- Discounts ----
      subtotal: { type: Number, default: null },        // list price (+ joining fee) before discount
      discountAmount: { type: Number, default: 0 },
      discountNote: { type: String, default: '' },      // e.g. credit for unused days on an upgrade
      couponCode: { type: String, default: '' },
      couponRedeemed: { type: Boolean, default: false },

      // ---- Stripe subscriptions ----
      stripeSubscriptionId: { type: String, default: null, index: true },
      stripeInvoiceId: { type: String, default: null },
      lastPaymentError: { type: String, default: '' },

      // ---- Bank transfer: the receipt the member sent and what staff did with it ----
      proof: {
        url: { type: String, default: '' },
        note: { type: String, default: '' },
        reference: { type: String, default: '' },
        uploadedAt: { type: Date, default: null },
        reviewedAt: { type: Date, default: null },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        rejectionReason: { type: String, default: '' }
      }
    },
    subscription: {
      startDate: Date,
      endDate: Date,
      isActive: {
        type: Boolean,
        default: false
      },
      autoRenew: {
        type: Boolean,
        default: false
      },
      renewalDate: Date,
      // Set when the member (or Stripe) has said "do not renew": access runs
      // to endDate, then the expiry job closes it.
      cancelAtPeriodEnd: { type: Boolean, default: false },
      stripeStatus: { type: String, default: '' },
      renewals: {
        type: [
          new mongoose.Schema(
            {
              at: Date,
              amount: Number,
              currency: String,
              invoiceId: String,
              periodEnd: Date
            },
            { _id: false }
          )
        ],
        default: []
      }
    },
    status: {
      type: String,
      // frozen: paused by the member or staff, end date pushed out.
      // past_due: a Stripe renewal failed; Stripe is retrying.
      enum: ['pending', 'active', 'expired', 'cancelled', 'suspended', 'frozen', 'past_due'],
      default: 'pending'
    },
    notes: String,

    // ---- Lifecycle ----
    freeze: {
      isFrozen: { type: Boolean, default: false },
      frozenAt: { type: Date, default: null },
      resumeAt: { type: Date, default: null },
      reason: { type: String, default: '' },
      totalFrozenDays: { type: Number, default: 0 },
      history: {
        type: [
          new mongoose.Schema(
            {
              from: Date,
              to: Date,
              days: Number,
              reason: String,
              by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
              resumedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
              source: String
            },
            { _id: false }
          )
        ],
        default: []
      }
    },
    cancellation: {
      cancelledAt: { type: Date, default: null },
      reason: { type: String, default: '' },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      source: { type: String, default: '' },  // member | staff | stripe
      immediate: { type: Boolean, default: false },
      resumedAt: { type: Date, default: null }
    },
    // Session packs: how many are on it and how many have been used.
    sessions: {
      total: { type: Number, default: 0 },
      used: { type: Number, default: 0 },
      exhaustedAt: { type: Date, default: null },
      log: {
        type: [
          new mongoose.Schema(
            { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: String },
            { _id: false }
          )
        ],
        default: []
      }
    },
    // The order this one renewed or replaced.
    renewedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageOrder', default: null },
    // Issued once the order is paid; see services/invoiceService.js.
    invoice: {
      number: { type: String, default: null, index: true },
      issuedAt: { type: Date, default: null },
      taxRate: { type: Number, default: 0 },
      taxLabel: { type: String, default: 'Tax' },
      taxAmount: { type: Number, default: 0 },
      subtotal: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      currency: { type: String, default: '' }
    },

    // Which expiry notices have already gone out for this membership, as the
    // day-counts they were sent for ([14, 7, 1]).
    //
    // Stored on the order rather than in a separate log because the question
    // being asked is always "has THIS membership had THIS notice", and the
    // answer has to survive the cron running twice -- which it will, because a
    // scheduler that retries on timeout is normal. Appended only after a send
    // actually succeeds, so a mail outage retries rather than silently
    // swallowing the reminder.
    remindersSent: {
      type: [Number],
      default: []
    },

    metadata: {
      type: Map,
      of: String
    }
  },
  {
    timestamps: true
  }
);

// Generate order number
packageOrderSchema.statics.generateOrderNumber = async function() {
  const prefix = 'PKG';
  const date = new Date();
  const year = date.getFullYear().toString().substr(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');

  // Find the last order number for today
  const lastOrder = await this.findOne({
    orderNumber: new RegExp(`^${prefix}${year}${month}`)
  })
  .sort({ orderNumber: -1 })
  .select('orderNumber');

  let sequence = 1;
  if (lastOrder) {
    const lastSequence = parseInt(lastOrder.orderNumber.substr(-4));
    sequence = lastSequence + 1;
  }

  return `${prefix}${year}${month}${String(sequence).padStart(4, '0')}`;
};

// Indexes for better query performance
packageOrderSchema.index({ userId: 1, createdAt: -1 });
packageOrderSchema.index({ 'payment.status': 1 });
packageOrderSchema.index({ status: 1 });
packageOrderSchema.index({ 'payment.stripeSessionId': 1 });
packageOrderSchema.index({ 'customerInfo.email': 1 });
packageOrderSchema.index({ createdAt: -1 });

// Virtual for subscription duration
packageOrderSchema.virtual('subscriptionDuration').get(function() {
  if (this.subscription.startDate && this.subscription.endDate) {
    const diff = this.subscription.endDate - this.subscription.startDate;
    return Math.ceil(diff / (1000 * 60 * 60 * 24)); // days
  }
  return null;
});

// Method to check if subscription is active
packageOrderSchema.methods.isSubscriptionActive = function() {
  if (!this.subscription.isActive) return false;

  const now = new Date();
  if (this.subscription.endDate && now > this.subscription.endDate) {
    return false;
  }

  return this.payment.status === 'paid' && this.status === 'active';
};

// Method to activate subscription.
//
// Kept for the callers that always used it; the dates now come from the
// membership service so a renewal bought early starts when the current term
// ends, and packs/passes honour their explicit duration.
packageOrderSchema.methods.activateSubscription = async function(options = {}) {
  const service = require('../services/membershipService');
  const now = new Date();
  const start = options.startDate
    ? new Date(options.startDate)
    : await service.startDateFor({
        userId: this.userId,
        email: this.customerInfo && this.customerInfo.email,
        kind: (this.packageDetails && this.packageDetails.kind) || 'membership',
        now
      });
  this.subscription.isActive = true;
  this.subscription.startDate = start;
  this.subscription.endDate = options.endDate ? new Date(options.endDate) : service.termEnd(start, this.packageDetails || {});
  this.subscription.renewalDate = this.subscription.endDate;
  this.status = 'active';

  await this.save();
};

const PackageOrder = tenantModel('PackageOrder', packageOrderSchema);

module.exports = PackageOrder;
