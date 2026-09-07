// src/platform/models/platformPlanModel.js
//
// What the platform sells to a gym: a price and a set of limits. Limits of 0
// mean unlimited, so a plan can be created without deciding every cap.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const platformPlanSchema = new mongoose.Schema(
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
      currency: { type: String, default: 'USD', uppercase: true, trim: true }
    },
    limits: {
      maxMembers: { type: Number, default: 0, min: 0 },
      maxStaff: { type: Number, default: 0, min: 0 },
      maxTrainers: { type: Number, default: 0, min: 0 },
      maxClasses: { type: Number, default: 0, min: 0 }
    },
    features: { type: [String], default: [] },
    trialDays: { type: Number, default: 14, min: 0 },
    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 }
  },
  {
    timestamps: true,
    collection: 'platform_plans'
  }
);

platformPlanSchema.index({ isActive: 1, order: 1 });

module.exports = platformModel('PlatformPlan', platformPlanSchema);
