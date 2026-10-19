// src/model/settings.js

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');
const { secretString } = require('../services/secretBox');

// The paths below that are sealed at rest (services/secretBox.js). Each is
// declared with secretString(), which installs the setter that seals on the
// way in and the getter that opens on the way out; getSettings() and the
// schema's toObject/toJSON apply the getters, so every reader sees the
// plaintext it always did.
const SECRET_PATHS = [
  'stripe.secretKey',
  'stripe.webhookSecret',
  'smtp.pass',
  'messaging.sms.authToken',
  'messaging.sms.webhookToken',
  'messaging.whatsapp.authToken',
  'messaging.whatsapp.accessToken',
  'messaging.whatsapp.webhookToken',
  'messaging.push.vapidPrivateKey'
];

const settingsSchema = new mongoose.Schema(
  {
    // General Settings
    siteName: { 
      type: String, 
      required: true, 
      trim: true, 
      default: 'GymsPilotPro' 
    },
    siteUrl: { 
      type: String, 
      required: true, 
      trim: true, 
      default: '' 
    },
    // Empty until the gym uploads its own. It used to default to
    // '/images/logo.png', a bundled picture of the word "LOGO": rows from
    // then still hold that path, and it is read as no logo
    // (services/branding.js ownLogo).
    logoUrl: {
      type: String,
      default: '',
      trim: true
    },
    logoWidth: {
      type: Number,
      default: 160,
      min: 20,
      max: 2000
    },
    logoHeight: {
      type: Number,
      default: 56,
      min: 20,
      max: 2000
    },
    footerLogoUrl: {
      type: String,
      default: '',
      trim: true
    },
    footerLogoWidth: {
      type: Number,
      default: 120,
      min: 20,
      max: 2000
    },
    footerLogoHeight: {
      type: Number,
      default: 40,
      min: 20,
      max: 2000
    },
    timezone: { 
      type: String, 
      default: 'UTC+05:00',
      trim: true 
    },
    dateFormat: { 
      type: String, 
      default: 'MM/DD/YYYY',
      enum: ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'],
      trim: true 
    },
    
    // Notification Settings
    emailNotifications: { 
      type: Boolean, 
      default: true 
    },
    marketingEmails: { 
      type: Boolean, 
      default: false 
    },
    securityAlerts: { 
      type: Boolean, 
      default: true 
    },
    
    // Security Settings
    twoFactorAuth: { 
      type: Boolean, 
      default: false 
    },
    
    // Billing Settings
    // Any ISO 4217 code. Gyms run in every currency there is; the old three-
    // value list is gone.
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true,
      validate: {
        validator: (value) => /^[A-Z]{3}$/.test(String(value || '')),
        message: 'Currency must be a 3-letter ISO code such as USD, GBP or PKR'
      }
    },
    // Where the gym is (ISO 3166-1 alpha-2). Picked in Settings → General;
    // fills the currency and timezone and is mirrored on the platform record.
    country: {
      type: String,
      default: '',
      uppercase: true,
      trim: true,
      validate: {
        validator: (value) => !value || /^[A-Z]{2}$/.test(String(value)),
        message: 'Country must be a 2-letter ISO code such as GB, AE or PK'
      }
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    paymentMethods: [{
      type: String,
      enum: ['credit_card', 'paypal', 'stripe', 'razorpay'],
      default: ['credit_card', 'paypal']
    }],

    // POS External Link
    posUrl: {
      type: String,
      trim: true,
      default: ''
    },

    // Contact Information
    mobileNumber: {
      type: String,
      trim: true,
      default: ''
    },
    address: {
      type: String,
      trim: true,
      default: ''
    },
    // Where members write to the gym: the contact page, the structured data
    // and the phone app's "contact us" (services/branding.js). Not the
    // address emails are sent from -- that is smtp.fromEmail.
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: ''
    },
    // A sentence or two about the gym. The site's description wherever the
    // gym has not written a search description of its own (seo.description).
    siteDescription: {
      type: String,
      trim: true,
      default: ''
    },

    // Top Slider Banner Text
    topSliderText: {
      type: String,
      trim: true,
      default: ''
    },

    // Social Media Links
    youtubeUrl: {
      type: String,
      trim: true,
      default: ''
    },
    facebookUrl: {
      type: String,
      trim: true,
      default: ''
    },
    instagramUrl: {
      type: String,
      trim: true,
      default: ''
    },
    twitterUrl: {
      type: String,
      trim: true,
      default: ''
    },
    tiktokUrl: {
      type: String,
      trim: true,
      default: ''
    },

    // Additional metadata
    // Payment gateway credentials. The secret and webhook values are never
    // returned by the public settings endpoint and are masked in the admin
    // response — see settingsController.maskSecret. Sealed at rest.
    stripe: {
      publishableKey: { type: String, default: '', trim: true },
      secretKey: secretString(),
      webhookSecret: secretString(),
      enabled: { type: Boolean, default: false }
    },

    // Outbound mail configuration, used for member credential emails.
    smtp: {
      host: { type: String, default: '', trim: true },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      user: { type: String, default: '', trim: true },
      pass: secretString(),
      fromName: { type: String, default: '', trim: true },
      fromEmail: { type: String, default: '', trim: true }
    },

    // Invoices. Prices are treated as tax-inclusive; taxRate above says how
    // much of each payment was tax.
    invoice: {
      prefix: { type: String, default: 'INV', trim: true },
      taxLabel: { type: String, default: 'Tax', trim: true },
      taxNumber: { type: String, default: '', trim: true },
      footerNote: { type: String, default: '', trim: true }
    },

    // The till's printed receipt. Set from the POS page, not the general
    // settings page (controller/posController.js receiptSettings). The gym's
    // name, address, phone and tax number come from the fields above; an
    // empty footerText falls back to invoice.footerNote.
    receipt: {
      paperWidth: { type: String, enum: ['80mm', '58mm'], default: '80mm' },
      showLogo: { type: Boolean, default: true },
      footerText: { type: String, default: '', trim: true, maxlength: 300 }
    },

    // Set when the owner has been through the setup wizard (or the gym was
    // adopted from a pre-platform deployment). Until then the admin panel
    // points at /admin/setup.
    setupCompletedAt: { type: Date, default: null },

    // What members may do to their own membership from the portal.
    membership: {
      allowMemberFreeze: { type: Boolean, default: true },
      maxFreezeDays: { type: Number, default: 30, min: 1 },
      allowMemberCancel: { type: Boolean, default: true },
      // The agreement members sign. Bumping the version asks everyone to
      // sign again.
      waiver: {
        required: { type: Boolean, default: false },
        version: { type: String, default: '1.0', trim: true },
        text: { type: String, default: '' }
      }
    },

    // Text channels beside email, push, the website's WhatsApp button and
    // the automated nudges. Secrets are masked on the way out
    // (settingsController.sanitizeSettings). See services/messaging.js.
    messaging: {
      // Prepended to phone numbers saved without a country code ("+92").
      defaultCountryCode: { type: String, default: '', trim: true },
      sms: {
        provider: { type: String, enum: ['none', 'twilio', 'http'], default: 'none' },
        accountSid: { type: String, default: '', trim: true },
        authToken: secretString(),
        from: { type: String, default: '', trim: true },
        webhookUrl: { type: String, default: '', trim: true },
        webhookToken: secretString()
      },
      whatsapp: {
        provider: { type: String, enum: ['none', 'twilio', 'meta', 'http'], default: 'none' },
        accountSid: { type: String, default: '', trim: true },
        authToken: secretString(),
        from: { type: String, default: '', trim: true },
        phoneNumberId: { type: String, default: '', trim: true },
        accessToken: secretString(),
        webhookUrl: { type: String, default: '', trim: true },
        webhookToken: secretString()
      },
      push: {
        enabled: { type: Boolean, default: false },
        vapidPublicKey: { type: String, default: '' },
        vapidPrivateKey: secretString({ trim: false }),
        subject: { type: String, default: '', trim: true }
      },
      // Which channels carry the transactional notices, beyond email.
      transactional: {
        sms: { type: Boolean, default: false },
        whatsapp: { type: Boolean, default: false },
        push: { type: Boolean, default: true }
      },
      // The floating "chat on WhatsApp" button on the public site.
      whatsappButton: {
        enabled: { type: Boolean, default: false },
        number: { type: String, default: '', trim: true },
        message: { type: String, default: '', trim: true }
      },
      // 0 = off. See services/automations.js.
      automations: {
        absentDays: { type: Number, default: 0, min: 0 },
        winBackDays: { type: Number, default: 0, min: 0 },
        birthday: { type: Boolean, default: false }
      }
    },

    // Class booking policy. See gymfolio/services/bookingRules.js for the
    // defaults and what each does.
    booking: {
      horizonDays: { type: Number, default: 30, min: 1 },
      cutoffMinutes: { type: Number, default: 15, min: 0 },
      cancelHours: { type: Number, default: 2, min: 0 },
      requireActiveMembership: { type: Boolean, default: false },
      useCredits: { type: Boolean, default: true },
      noShowStrikes: { type: Number, default: 0, min: 0 },
      noShowWindowDays: { type: Number, default: 30, min: 1 },
      noShowBanDays: { type: Number, default: 7, min: 1 },
      autoNoShow: { type: Boolean, default: false }
    },
    // Front-desk attendance. Set from the admin attendance page
    // (attendance/controller/attendanceCorrectionController.js).
    attendance: {
      // Members scan on the way out as well as in. Off for a gym where they
      // only scan in: every member scan is then a new visit (see
      // attendance/services/punchService.js).
      memberScanOut: { type: Boolean, default: true },
      // Members the desk turns away at the door instead of checking in with a
      // red warning. All off by default: warn only, as the desk always has.
      // Nothing is recorded for a refused scan (see punchService
      // entryRefusal); someone already inside can always check out.
      refuseEntry: {
        expired: { type: Boolean, default: false },   // membership ran out (or cancelled and ended)
        unpaid: { type: Boolean, default: false },    // balance owing, or the card payment failed
        noPackage: { type: Boolean, default: false }  // never bought a package
      },
      // What the front desk and the web kiosk SAY after the alert sound, for
      // a member whose fee has run out, is about to, or has money owing.
      // Spoken, not shown: the member hears it from across the counter. A
      // blank message means the default (punchService VOICE_DEFAULTS); off
      // leaves only the sound.
      voice: {
        enabled: { type: Boolean, default: true },
        expiredMessage: { type: String, default: 'Fee expired, please renew', trim: true, maxlength: 200 },
        expiringMessage: { type: String, default: 'Your fee expires soon', trim: true, maxlength: 200 },
        balanceDueMessage: { type: String, default: 'Please clear your balance', trim: true, maxlength: 200 }
      }
    },
    // Personal training.
    pt: {
      slotMinutes: { type: Number, default: 60, min: 15 },
      defaultCommissionPercent: { type: Number, default: 0, min: 0, max: 100 },
      allowMemberBooking: { type: Boolean, default: true },
      requirePack: { type: Boolean, default: false },
      cancelHours: { type: Number, default: 12, min: 0 },
      horizonDays: { type: Number, default: 30, min: 1 }
    },
    // Named rooms / studios a class can be put in.
    rooms: { type: [String], default: [] },

    // Renewal reminders with a payment link, and automatic card charges on
    // the due date (services/billing/). Read through billingSettings(), which
    // fills in these defaults for a gym that has never saved the block.
    billing: {
      // Days before the due date a "renewal due" message goes, each 0..30.
      reminderDaysBefore: { type: [Number], default: [3] },
      dueDayReminder: { type: Boolean, default: true },
      // The last day to pay is the due date plus this many days; 0 sends no
      // last-day message.
      lastDayAfterDue: { type: Number, default: 3, min: 0, max: 30 },
      sendVia: {
        email: { type: Boolean, default: true },
        sms: { type: Boolean, default: false },
        // Only goes when the gym has its own WhatsApp provider (Settings → Messaging).
        whatsapp: { type: Boolean, default: true },
        push: { type: Boolean, default: true }
      },
      // Switched on by the gym once its payment gateway has confirmed
      // merchant-initiated (saved card) charges for its account.
      autoCharge: { enabled: { type: Boolean, default: false } }
    },

    // Search engines and social previews.
    seo: {
      title: { type: String, default: '', trim: true },
      description: { type: String, default: '', trim: true },
      keywords: { type: String, default: '', trim: true },
      ogImage: { type: String, default: '', trim: true }
    },
    // Where the gym is, for the contact page map and the structured data.
    maps: {
      embedUrl: { type: String, default: '', trim: true },
      placeUrl: { type: String, default: '', trim: true },
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null }
    },
    // Opening hours, shown on the site and in the structured data.
    openingHours: {
      type: [
        new mongoose.Schema(
          {
            day: { type: String, enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], required: true },
            open: { type: String, default: '06:00' },
            close: { type: String, default: '22:00' },
            closed: { type: Boolean, default: false }
          },
          { _id: false }
        )
      ],
      default: []
    },
    // The language the public site and portal read in, and its direction.
    locale: {
      language: { type: String, default: 'en', trim: true },
      direction: { type: String, enum: ['ltr', 'rtl'], default: 'ltr' }
    },

    // Site colour scheme. Stores a preset key; the frontend maps it to CSS
    // custom properties so the whole site recolours from one value.
    theme: {
      type: String,
      default: 'electric-lime',
      trim: true
    },

    isActive: { 
      type: Boolean, 
      default: true 
    },
    version: { 
      type: String, 
      default: '1.0.0' 
    }
  },
  {
    timestamps: true,
    collection: 'settings',
    // Getters on, so a document turned into a plain object (sanitizeSettings,
    // res.json) carries the opened secrets exactly as it did before they were
    // sealed. Virtuals off, so the shape stays what .lean() used to return.
    toObject: { getters: true, virtuals: false },
    toJSON: { getters: true, virtuals: false }
  }
);

// Index for faster queries
settingsSchema.index({ isActive: 1 });

settingsSchema.statics.SECRET_PATHS = SECRET_PATHS;

// A plain object with every getter applied -- the shape .lean() gave, plus
// the sealed secrets opened. minimize is off so an empty nested block is not
// dropped from the result the way toObject() would by default.
function plainSettings(doc) {
  return doc && doc.toObject ? doc.toObject({ getters: true, virtuals: false, minimize: false }) : doc;
}

// The _id the first settings document is created under. Creating it as an
// upsert on a fixed _id is what makes first access safe: two requests that
// both found no settings used to create two documents, and later reads then
// picked either one. The _id index is unique, so however many race, one
// document is written and every caller gets it back.
const FIRST_SETTINGS_ID = new mongoose.Types.ObjectId('000000000000000000000001');

// Static method to get or create settings
//
// Returns a plain object, not a document. It used to be a .lean() read, but
// lean skips getters, which would have handed every caller (Stripe, SMTP,
// messaging) the sealed ciphertext instead of the key.
settingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne({ isActive: true });

  if (!settings) {
    // Create default settings if none exist
    const defaults = {
      siteName: 'GymsPilotPro',
      siteUrl: '',
      logoUrl: '',
      timezone: 'UTC+05:00',
      dateFormat: 'MM/DD/YYYY',
      emailNotifications: true,
      marketingEmails: false,
      securityAlerts: true,
      twoFactorAuth: false,
      currency: 'USD',
      taxRate: 0,
      paymentMethods: ['credit_card', 'paypal'],
      posUrl: '',
      topSliderText: '',
      youtubeUrl: '',
      facebookUrl: '',
      instagramUrl: '',
      twitterUrl: '',
      tiktokUrl: '',
      isActive: true
    };
    try {
      settings = await this.findOneAndUpdate(
        { _id: FIRST_SETTINGS_ID },
        { $setOnInsert: defaults },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      // Lost the race on a server that does not retry the upsert itself:
      // the winner's document is there now.
      if (!error || error.code !== 11000) throw error;
      settings = await this.findById(FIRST_SETTINGS_ID);
    }
  }

  return plainSettings(settings);
};

// Static method to update settings
settingsSchema.statics.updateSettings = async function(updateData) {
  let settings = await this.findOne({ isActive: true });
  
  if (!settings) {
    // Create new settings if none exist
    settings = new this(updateData);
  } else {
    // Update existing settings
    Object.keys(updateData).forEach(key => {
      if (updateData[key] !== undefined) {
        settings[key] = updateData[key];
      }
    });
  }
  
  await settings.save();
  return settings;
};

module.exports = tenantModel('Settings', settingsSchema);