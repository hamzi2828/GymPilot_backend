// src/models/guideline.js

const mongoose = require('mongoose');

const guidelineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    type: {
      type: String,
      required: true,
      enum: ['size-chart', 'measuring-tip'],
      default: 'size-chart',
      index: true
    },
    imageUrl: { type: String, default: null }, // Keep for backward compatibility
    images: [{ type: String }], // Array of image URLs
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Helper to format fields
function capitalizeFirstWord(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Ensure formatting on create/save
guidelineSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = capitalizeFirstWord(this.name);
  }
  if (this.isModified('slug') && typeof this.slug === 'string') {
    this.slug = String(this.slug).trim().toLowerCase();
  }
  next();
});

// Ensure formatting on findOneAndUpdate / findByIdAndUpdate
guidelineSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if ($set.name && typeof $set.name === 'string') {
    $set.name = capitalizeFirstWord($set.name);
  }
  if ($set.slug && typeof $set.slug === 'string') {
    $set.slug = String($set.slug).trim().toLowerCase();
  }
  if (update.$set) this.setUpdate({ ...update, $set }); else this.setUpdate($set);
  next();
});

module.exports = mongoose.model('Guideline', guidelineSchema);
