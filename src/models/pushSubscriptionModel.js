// src/models/pushSubscriptionModel.js
//
// A browser that has agreed to receive the gym's push notifications. One
// row per device; a member with a phone and a laptop has two. Dead
// subscriptions (the browser revoked them) are deleted when a send comes
// back 404/410.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    },
    userAgent: { type: String, default: '' },
    lastUsedAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    collection: 'gym_push_subscriptions'
  }
);

module.exports = tenantModel('PushSubscription', pushSubscriptionSchema);
