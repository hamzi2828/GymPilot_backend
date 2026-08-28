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
    customerInfo: {
      fullName: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      country: { type: String, required: true },
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
