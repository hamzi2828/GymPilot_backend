// src/models/messageTemplateModel.js
//
// A gym's own wording for one of the messages the system sends. Only the
// events an admin has actually customised have a row; everything else uses
// the built-in text (services/templateService.js). Deleting the row puts the
// default back.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const messageTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    // Email: subject line and body. The body may be plain text with blank
    // lines between paragraphs, or simple HTML. {{placeholders}} are filled
    // in at send time.
    subject: { type: String, default: '', trim: true },
    body: { type: String, default: '' },
    // The short version used for SMS, WhatsApp and push.
    text: { type: String, default: '', trim: true },
    enabled: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    collection: 'gym_message_templates'
  }
);

module.exports = tenantModel('MessageTemplate', messageTemplateSchema);
