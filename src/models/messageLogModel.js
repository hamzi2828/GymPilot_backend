// src/models/messageLogModel.js
//
// Every message the gym sends on a channel other than the transactional
// email path -- SMS, WhatsApp, push, and campaign email -- with what happened
// to it. The admin Messaging screen reads this; the campaign sender uses it
// to know who has already been reached so a retried batch never doubles up.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const messageLogSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: ['email', 'sms', 'whatsapp', 'push'], required: true, index: true },
    // The address: an email, a phone number, or the user id for push.
    to: { type: String, default: '', index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    // What triggered it: 'booking confirmed', 'campaign', 'absent nudge', 'manual' ...
    context: { type: String, default: '', index: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },
    status: { type: String, enum: ['sent', 'failed', 'skipped'], required: true, index: true },
    error: { type: String, default: '' },
    provider: { type: String, default: '' },
    providerId: { type: String, default: '' },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    collection: 'gym_message_logs'
  }
);

messageLogSchema.index({ createdAt: -1 });
// Six months is plenty for "did they get the reminder"; after that the row
// is noise, and the collection would otherwise grow for the life of the gym.
messageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

// Never lets a failed log write break the send it describes.
messageLogSchema.statics.record = function (entry) {
  return this.create({ ...entry, body: String(entry.body || '').slice(0, 500) }).catch((err) => {
    console.error('[messages] log write failed:', err.message);
    return null;
  });
};

module.exports = tenantModel('MessageLog', messageLogSchema);
