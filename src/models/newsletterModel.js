// src/models/newsletterModel.js
const mongoose = require('mongoose');

const newsletterSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    subscribedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['active', 'unsubscribed'],
      default: 'active'
    },
    source: {
      type: String,
      enum: ['blog', 'homepage', 'sidebar', 'footer'],
      default: 'blog'
    },
    ipAddress: {
      type: String,
      default: null
    },
    userAgent: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Index for better performance
newsletterSchema.index({ email: 1, status: 1 });
newsletterSchema.index({ subscribedAt: -1 });

// Static method to check if email exists
newsletterSchema.statics.isEmailSubscribed = async function(email) {
  const subscription = await this.findOne({
    email: email.toLowerCase(),
    status: 'active'
  });
  return !!subscription;
};

// Static method to get active subscribers count
newsletterSchema.statics.getActiveSubscribersCount = async function() {
  return this.countDocuments({ status: 'active' });
};

// Static method to unsubscribe
newsletterSchema.statics.unsubscribeEmail = async function(email) {
  return this.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      status: 'unsubscribed',
      unsubscribedAt: new Date()
    },
    { new: true }
  );
};

const Newsletter = mongoose.model('Newsletter', newsletterSchema);

module.exports = Newsletter;