// src/model/color.js

const mongoose = require('mongoose');

const colorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    hex: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Helpers to format fields
function capitalizeFirstWord(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Ensure formatting on create/save
colorSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = capitalizeFirstWord(this.name);
  }
  if (this.isModified('slug') && typeof this.slug === 'string') {
    this.slug = String(this.slug).trim().toLowerCase();
  }
  next();
});

// Ensure formatting on findOneAndUpdate / findByIdAndUpdate
colorSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
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

module.exports = mongoose.model('Color', colorSchema);
