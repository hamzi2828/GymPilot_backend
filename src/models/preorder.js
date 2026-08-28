// src/models/preorder.js

const mongoose = require('mongoose');

/**
 * Generate a unique preorder number
 * Format: PRE-XXXXXX-XXXX (e.g., PRE-A1B2C3-1234)
 */
function generatePreorderNumber() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'PRE-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  code += '-';
  for (let i = 0; i < 4; i++) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
}

const preorderSchema = new mongoose.Schema(
  {
    preorderNumber: {
      type: String,
      required: true,
      unique: true,
      default: generatePreorderNumber,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    variantId: {
      type: String,
      trim: true,
      default: null,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    status: {
      type: String,
      enum: ['pending', 'notified', 'converted', 'cancelled'],
      default: 'pending',
      index: true,
    },
    notifiedAt: {
      type: Date,
      default: null,
    },
    convertedAt: {
      type: Date,
      default: null,
    },
    // Store variant details for display
    variantDetails: {
      color: { type: String, trim: true },
      size: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

// Compound index for checking existing preorders
preorderSchema.index({ product: 1, email: 1, status: 1 });
preorderSchema.index({ product: 1, variantId: 1, email: 1, status: 1 });

// Ensure unique preorder number on save
preorderSchema.pre('save', async function (next) {
  if (this.isNew && !this.preorderNumber) {
    let isUnique = false;
    while (!isUnique) {
      const number = generatePreorderNumber();
      const existing = await mongoose.models.Preorder.findOne({ preorderNumber: number });
      if (!existing) {
        this.preorderNumber = number;
        isUnique = true;
      }
    }
  }
  next();
});

module.exports = mongoose.models.Preorder || mongoose.model('Preorder', preorderSchema);
