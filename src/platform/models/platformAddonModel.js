// src/platform/models/platformAddonModel.js
//
// Something a gym can switch on alongside its plan, for a price of its own:
// the member phone app today, and whatever we sell beside the plans later
// (an extra branch, WhatsApp credits, a second front desk).
//
// An add-on is not a feature flag. Nothing in a gym's database reads this --
// it is what we agreed to charge for, and the gym's own subscription keeps a
// snapshot of the price at the time it was added.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const platformAddonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'Slug may contain lowercase letters, digits and hyphens only']
    },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    price: {
      monthly: { type: Number, default: 0, min: 0 },
      yearly: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: 'PKR', uppercase: true, trim: true }
    },
    // Which plans may have it. Empty means every plan, which is the usual
    // case -- an add-on that only some tiers can buy is the exception.
    planSlugs: { type: [String], default: [] },
    // Shown on the public price list under each plan it applies to.
    isPublic: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 }
  },
  {
    timestamps: true,
    collection: 'platform_addons'
  }
);

platformAddonSchema.index({ isActive: 1, order: 1 });

/** Can this add-on go on that plan? An empty plan list means any of them. */
platformAddonSchema.methods.appliesTo = function (planSlug) {
  if (!this.planSlugs || !this.planSlugs.length) return true;
  return this.planSlugs.includes(String(planSlug || '').toLowerCase());
};

/** What it costs for a billing cycle. */
platformAddonSchema.methods.amountFor = function (billingCycle) {
  return billingCycle === 'yearly' ? this.price.yearly || 0 : this.price.monthly || 0;
};

module.exports = platformModel('PlatformAddon', platformAddonSchema);
