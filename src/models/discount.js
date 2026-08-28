const mongoose = require('mongoose');

const discountSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  discountType: {
    type: String,
    required: true,
    enum: ['percentage', 'fixed'],
    default: 'percentage'
  },
  discountValue: {
    type: Number,
    required: true,
    min: 0
  },
  minimumOrderAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  maximumDiscount: {
    type: Number,
    default: null
  },
  usageLimit: {
    type: Number,
    default: null
  },
  usedCount: {
    type: Number,
    default: 0
  },
  startDate: {
    type: Date,
    default: Date.now
  },
  endDate: {
    type: Date,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  applicableProducts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  applicableCategories: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  }],
  excludedProducts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  // Track which users have used this coupon (for one-per-user restriction)
  usedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // Whether each user can only use this coupon once
  onePerUser: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Generate unique code
discountSchema.statics.generateCode = function(prefix = 'PROMO') {
  const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${randomStr}`;
};

// Check if discount is valid
discountSchema.methods.isValid = function(orderAmount = 0, userId = null) {
  const now = new Date();

  // Check if active
  if (!this.isActive) {
    return { valid: false, message: 'This discount code is not active' };
  }

  // Check start date
  if (this.startDate && now < this.startDate) {
    return { valid: false, message: 'This discount code is not yet valid' };
  }

  // Check end date
  if (this.endDate && now > this.endDate) {
    return { valid: false, message: 'This discount code has expired' };
  }

  // Check usage limit
  if (this.usageLimit !== null && this.usedCount >= this.usageLimit) {
    return { valid: false, message: 'This discount code has reached its usage limit' };
  }

  // Check if user has already used this coupon (one per user restriction)
  if (this.onePerUser && userId) {
    const userIdStr = userId.toString();
    const hasUsed = this.usedBy && this.usedBy.some(id => id.toString() === userIdStr);
    if (hasUsed) {
      return { valid: false, message: 'You have already used this discount code' };
    }
  }

  // Check minimum order amount
  if (orderAmount < this.minimumOrderAmount) {
    return {
      valid: false,
      message: `Minimum order amount of ${this.minimumOrderAmount.toFixed(2)} required`
    };
  }

  return { valid: true, message: 'Discount code is valid' };
};

// Calculate discount amount
discountSchema.methods.calculateDiscount = function(orderAmount) {
  let discountAmount = 0;

  if (this.discountType === 'percentage') {
    discountAmount = (orderAmount * this.discountValue) / 100;
  } else {
    discountAmount = this.discountValue;
  }

  // Apply maximum discount cap if set
  if (this.maximumDiscount !== null && discountAmount > this.maximumDiscount) {
    discountAmount = this.maximumDiscount;
  }

  // Discount cannot exceed order amount
  if (discountAmount > orderAmount) {
    discountAmount = orderAmount;
  }

  return Math.round(discountAmount * 100) / 100;
};

// Increment usage count and record user
discountSchema.methods.incrementUsage = async function(userId = null) {
  this.usedCount += 1;
  if (userId && this.onePerUser) {
    if (!this.usedBy) {
      this.usedBy = [];
    }
    // Only add if not already in the array
    const userIdStr = userId.toString();
    const alreadyUsed = this.usedBy.some(id => id.toString() === userIdStr);
    if (!alreadyUsed) {
      this.usedBy.push(userId);
    }
  }
  await this.save();
};

module.exports = mongoose.models.Discount || mongoose.model('Discount', discountSchema);
