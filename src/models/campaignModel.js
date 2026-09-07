// src/models/campaignModel.js
//
// One message to many people: a promotion, a holiday-hours notice, a
// newsletter. Sent in batches (services/campaignService.js) because the API
// runs on serverless functions with a time limit; the per-recipient trail
// lives in gym_message_logs.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const AUDIENCES = ['all_members', 'active_members', 'expiring_members', 'expired_members', 'newsletter', 'tags', 'leads'];
const CHANNELS = ['email', 'sms', 'whatsapp', 'push'];

const campaignSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    channel: { type: String, enum: CHANNELS, default: 'email' },
    audience: {
      type: { type: String, enum: AUDIENCES, default: 'all_members' },
      tags: { type: [String], default: [] },
      // For expiring_members: within this many days.
      days: { type: Number, default: 14, min: 1 }
    },
    subject: { type: String, default: '', trim: true },
    body: { type: String, default: '' },
    // Where a push notification opens.
    url: { type: String, default: '', trim: true },
    status: { type: String, enum: ['draft', 'sending', 'sent', 'failed'], default: 'draft', index: true },
    stats: {
      targeted: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 }
    },
    startedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    collection: 'gym_campaigns'
  }
);

campaignSchema.statics.AUDIENCES = AUDIENCES;
campaignSchema.statics.CHANNELS = CHANNELS;

module.exports = tenantModel('Campaign', campaignSchema);
