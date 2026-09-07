// src/model/settings.js

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const settingsSchema = new mongoose.Schema(
  {
    // General Settings
    siteName: { 
      type: String, 
      required: true, 
      trim: true, 
      default: 'GymPilot' 
    },
    siteUrl: { 
      type: String, 
      required: true, 
      trim: true, 
      default: '' 
    },
    logoUrl: {
      type: String,
      default: '/images/logo.png',
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
    // response — see settingsController.maskSecret.
    stripe: {
      publishableKey: { type: String, default: '', trim: true },
      secretKey: { type: String, default: '', trim: true },
      webhookSecret: { type: String, default: '', trim: true },
      enabled: { type: Boolean, default: false }
    },

    // Outbound mail configuration, used for member credential emails.
    smtp: {
      host: { type: String, default: '', trim: true },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      user: { type: String, default: '', trim: true },
      pass: { type: String, default: '', trim: true },
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
        authToken: { type: String, default: '', trim: true },
        from: { type: String, default: '', trim: true },
        webhookUrl: { type: String, default: '', trim: true },
        webhookToken: { type: String, default: '', trim: true }
      },
      whatsapp: {
        provider: { type: String, enum: ['none', 'twilio', 'meta', 'http'], default: 'none' },
        accountSid: { type: String, default: '', trim: true },
        authToken: { type: String, default: '', trim: true },
        from: { type: String, default: '', trim: true },
        phoneNumberId: { type: String, default: '', trim: true },
        accessToken: { type: String, default: '', trim: true },
        webhookUrl: { type: String, default: '', trim: true },
        webhookToken: { type: String, default: '', trim: true }
      },
      push: {
        enabled: { type: Boolean, default: false },
        vapidPublicKey: { type: String, default: '' },
        vapidPrivateKey: { type: String, default: '' },
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
    collection: 'settings' 
  }
);

// Index for faster queries
settingsSchema.index({ isActive: 1 });

// Static method to get or create settings
settingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne({ isActive: true }).lean();

  if (!settings) {
    // Create default settings if none exist
    settings = await this.create({
      siteName: 'GymPilot',
      siteUrl: '',
      logoUrl: '/images/logo.png',
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
    });
  }

  return settings;
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