// src/platform/models/platformSettingsModel.js
//
// The platform's own settings -- one document, created on first read.
//
// The Stripe keys here are GymPilot's, for charging gyms their plan. They are
// NOT a gym's keys: a gym sells memberships into its own Stripe account and
// those keys live in that gym's Settings (see services/stripeClient.js). The
// two must never be crossed, which is why the platform's live in the platform
// database and are read by a client of their own.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const platformSettingsSchema = new mongoose.Schema(
  {
    // A fixed key, so there can only ever be one of these.
    singleton: { type: String, default: 'platform', unique: true, immutable: true },

    stripe: {
      publishableKey: { type: String, default: '', trim: true },
      // Never returned in full by the API -- see platformSettingsController.
      secretKey: { type: String, default: '', trim: true },
      webhookSecret: { type: String, default: '', trim: true },
      enabled: { type: Boolean, default: false },
      // What the last "test connection" saw, so the panel can say which
      // account these keys actually reach.
      accountName: { type: String, default: '', trim: true },
      accountId: { type: String, default: '', trim: true },
      livemode: { type: Boolean, default: false },
      checkedAt: { type: Date, default: null }
    },

    updatedByEmail: { type: String, default: '', trim: true }
  },
  {
    timestamps: true,
    collection: 'platform_settings'
  }
);

/** The one settings document, created empty the first time it is asked for. */
platformSettingsSchema.statics.getSettings = async function getSettings() {
  const existing = await this.findOne({ singleton: 'platform' });
  if (existing) return existing;
  return this.create({ singleton: 'platform' });
};

module.exports = platformModel('PlatformSettings', platformSettingsSchema);
