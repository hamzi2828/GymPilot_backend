const mongoose = require('mongoose');

const shippingOptionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    price: { type: Number, required: true, default: 0, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Helper function
function capitalizeFirstWord(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Pre-save hooks
shippingOptionSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = capitalizeFirstWord(this.name);
  }
  if (this.isModified('slug') && typeof this.slug === 'string') {
    this.slug = String(this.slug).trim().toLowerCase();
  }
  next();
});

// Pre-update hooks
shippingOptionSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if ($set.name && typeof $set.name === 'string') {
    $set.name = capitalizeFirstWord($set.name);
  }
  if ($set.slug && typeof $set.slug === 'string') {
    $set.slug = String($set.slug).trim().toLowerCase();
  }
  if (update.$set) this.setUpdate({ ...update, $set });
  else this.setUpdate($set);
  next();
});

module.exports = mongoose.model('ShippingOption', shippingOptionSchema);
