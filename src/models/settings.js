// src/model/settings.js

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    // General Settings
    siteName: { 
      type: String, 
      required: true, 
      trim: true, 
      default: 'The Jymor' 
    },
    siteUrl: { 
      type: String, 
      required: true, 
      trim: true, 
      default: 'https://www.inkedwearpk.com' 
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
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'GBP', 'PKR'],
      trim: true
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

    // Site colour scheme. Stores a preset key; the frontend maps it to CSS
    // custom properties so the whole site recolours from one value.
    theme: {
      type: String,
      default: 'midnight-ember',
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
      siteName: 'The Jymor',
      siteUrl: 'https://www.inkedwearpk.com',
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

module.exports = mongoose.model('Settings', settingsSchema);