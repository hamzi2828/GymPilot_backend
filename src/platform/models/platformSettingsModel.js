// src/platform/models/platformSettingsModel.js
//
// The platform's own settings -- one document, created on first read.
//
// The Stripe and Safepay keys and the bank accounts here are GymsPilotPro's,
// for charging gyms their plan. They are
// NOT a gym's keys: a gym sells memberships into its own Stripe account and
// those keys live in that gym's Settings (see services/stripeClient.js). The
// two must never be crossed, which is why the platform's live in the platform
// database and are read by a client of their own.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');
const { seal, open, isSealed } = require('../../services/secretBox');
const { storage } = require('../tenantContext');

// The secret key and webhook secret are sealed at rest the same way a gym's
// are (services/secretBox.js). secretBox picks its key from the gym in
// context, and these are read from inside gym requests too (a gym's
// /api/billing checkout) -- sealed under whichever gym happened to be asking,
// they would open for nobody else. So both directions run with no gym in
// context, which is secretBox's un-scoped key: the same key every time.
function sealPlatform(value) {
  return storage.run(undefined, () => seal(value));
}
function openPlatform(value) {
  return storage.run(undefined, () => open(value));
}

// `set` before `trim`, as in secretBox.secretString(): mongoose runs setters
// last-defined-first, so the plaintext is trimmed before it is sealed.
const platformSecret = () => ({ type: String, default: '', set: sealPlatform, trim: true, get: openPlatform });

const SECRET_PATHS = ['stripe.secretKey', 'stripe.webhookSecret', 'safepay.secretKey', 'safepay.webhookSecret'];

// One of GymsPilotPro's own bank accounts, for gyms paying by transfer
// (services/payments/providers/generic.js). `_id` is the id the panel edits
// it by; `qrCodeUrl` is the image a banking app scans.
const bankAccountSchema = new mongoose.Schema(
  {
    bankName: { type: String, default: '', trim: true, maxlength: 80 },
    accountTitle: { type: String, default: '', trim: true, maxlength: 120 },
    accountNumber: { type: String, default: '', trim: true, maxlength: 40 },
    iban: { type: String, default: '', trim: true, maxlength: 34 },
    qrCodeUrl: { type: String, default: '', trim: true, maxlength: 2048 },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const platformSettingsSchema = new mongoose.Schema(
  {
    // A fixed key, so there can only ever be one of these.
    singleton: { type: String, default: 'platform', unique: true, immutable: true },

    // How gyms pay GymsPilotPro (services/payments): 'none', 'stripe',
    // 'safepay' or 'generic'. Unset on a platform from before the choice
    // existed; it then reads as 'stripe' when stripe.enabled is on and
    // 'none' otherwise. Not an enum, as on a gym: the registry is the list.
    onlinePayments: {
      provider: { type: String, default: undefined, trim: true }
    },

    // GymsPilotPro's own Safepay account -- never a gym's. Switched on by
    // choosing it (onlinePayments.provider), so `enabled` is not a field the
    // panel shows. Secrets sealed like the Stripe ones.
    safepay: {
      enabled: { type: Boolean, default: false },
      environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
      publicKey: { type: String, default: '', trim: true },
      secretKey: platformSecret(),
      webhookSecret: platformSecret()
    },

    bankAccounts: { type: [bankAccountSchema], default: [] },

    // Emails to gym owners about their GymsPilotPro payment
    // (services/ownerPayReminders.js): these many days before the due date,
    // on it, and this many days after it (0: no last-day email).
    billingReminders: {
      daysBefore: { type: [Number], default: () => [3] },
      onDueDay: { type: Boolean, default: true },
      lastDayAfterDue: { type: Number, default: 3, min: 0, max: 30 }
    },

    stripe: {
      publishableKey: { type: String, default: '', trim: true },
      // Never returned in full by the API -- see platformSettingsController.
      // Sealed at rest; a value saved before sealing existed still reads back
      // as the plaintext it is, and is sealed on the next save.
      secretKey: platformSecret(),
      webhookSecret: platformSecret(),
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

// Legacy plaintext is sealed whenever the document is saved for any reason,
// not only when that key is retyped.
platformSettingsSchema.pre('save', function sealLegacySecrets() {
  for (const path of SECRET_PATHS) {
    const raw = this.get(path, null, { getters: false });
    if (raw && !isSealed(raw)) this.set(path, raw);
  }
});

/** The one settings document, created empty the first time it is asked for. */
platformSettingsSchema.statics.getSettings = async function getSettings() {
  const existing = await this.findOne({ singleton: 'platform' });
  if (existing) return existing;
  return this.create({ singleton: 'platform' });
};

module.exports = platformModel('PlatformSettings', platformSettingsSchema);
