// packageOrderModel.js - Package Order Model for Gymfolio Package Subscriptions

const mongoose = require('mongoose');

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
      features: [String]
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
      transactionId: String
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
      renewalDate: Date
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'expired', 'cancelled', 'suspended'],
      default: 'pending'
    },
    notes: String,

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

// Method to activate subscription
packageOrderSchema.methods.activateSubscription = async function() {
  this.subscription.isActive = true;
  this.subscription.startDate = new Date();

  // Calculate end date based on package period
  const period = this.packageDetails.period.toLowerCase();
  const endDate = new Date();

  if (period.includes('month')) {
    const months = parseInt(period) || 1;
    endDate.setMonth(endDate.getMonth() + months);
  } else if (period.includes('year')) {
    const years = parseInt(period) || 1;
    endDate.setFullYear(endDate.getFullYear() + years);
  } else {
    // Default to 30 days
    endDate.setDate(endDate.getDate() + 30);
  }

  this.subscription.endDate = endDate;
  this.status = 'active';

  await this.save();
};

const PackageOrder = mongoose.model('PackageOrder', packageOrderSchema);

module.exports = PackageOrder;
