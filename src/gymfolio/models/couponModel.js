// src/gymfolio/models/couponModel.js
//
// A gym's own discount codes, applied at checkout to any payment method --
// card, bank transfer or cash at the desk. Distinct from Stripe promotion
// codes, which only Stripe Checkout can honour.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z0-9_-]{3,30}$/, 'Codes are 3-30 letters, digits, hyphens or underscores']
    },
    description: { type: String, default: '', trim: true, maxlength: 200 },
    type: { type: String, enum: ['percent', 'amount'], required: true },
    // Percent: 1-100. Amount: in the gym's currency, major units.
    value: { type: Number, required: true, min: 0 },
    currency: { type: String, default: '', uppercase: true, trim: true },
    // Empty = every package.
    packageIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Package' }], default: [] },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    // 0 = unlimited.
    maxRedemptions: { type: Number, default: 0, min: 0 },
    redemptions: { type: Number, default: 0, min: 0 },
    // For recurring memberships: discount every renewal, or the first
    // payment only.
    appliesToRenewals: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    collection: 'gym_coupons'
  }
);

couponSchema.index({ isActive: 1, validUntil: 1 });

/**
 * Why this coupon cannot be used right now, or null when it can.
 */
couponSchema.methods.problem = function (packageId, now = new Date()) {
  if (!this.isActive) return 'This code is no longer active';
  if (this.validFrom && now < this.validFrom) return 'This code is not valid yet';
  if (this.validUntil && now > this.validUntil) return 'This code has expired';
  if (this.maxRedemptions && this.redemptions >= this.maxRedemptions) return 'This code has been used up';
  if (this.packageIds.length && packageId && !this.packageIds.some((id) => String(id) === String(packageId))) {
    return 'This code does not apply to that package';
  }
  return null;
};

/** The discount, in major units, this coupon takes off `amount`. */
couponSchema.methods.discountOn = function (amount) {
  const base = Number(amount) || 0;
  if (this.type === 'percent') return Math.round(base * Math.min(100, this.value)) / 100;
  return Math.min(base, Number(this.value) || 0);
};

module.exports = tenantModel('Coupon', couponSchema);
