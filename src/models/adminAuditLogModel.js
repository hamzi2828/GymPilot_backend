// src/models/adminAuditLogModel.js
//
// Who changed what in the admin panel. One row per write that passed the
// permission gate -- a package edited, a member deleted, settings saved --
// with enough of the request to answer "what did they send", and none of the
// secrets. Written after the response, so it never slows a request down or
// stops one from completing.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const adminAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    actorEmail: { type: String, default: '' },
    actorRole: { type: String, default: '' },
    method: { type: String, default: '' },
    path: { type: String, default: '' },
    // The permission tab the route sits under: the coarse "what area".
    tab: { type: String, default: '', index: true },
    status: { type: Number, default: 0 },
    // A summary of the body: keys, short values, secrets stripped.
    body: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' }
  },
  {
    timestamps: true,
    collection: 'gym_admin_audit_logs'
  }
);

adminAuditLogSchema.index({ createdAt: -1 });

const SECRET_KEY = /pass|secret|token|key|otp|code$|cvv|card/i;

/** A body that is safe to keep: no credentials, nothing huge. */
function summariseBody(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(body).slice(0, 40)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[hidden]';
    } else if (value !== null && typeof value === 'object') {
      out[key] = Array.isArray(value) ? `[${value.length} items]` : summariseBody(value);
    } else {
      const text = String(value);
      out[key] = text.length > 120 ? `${text.slice(0, 117)}...` : value;
    }
  }
  return out;
}

adminAuditLogSchema.statics.summariseBody = summariseBody;

adminAuditLogSchema.statics.record = function (entry) {
  return this.create(entry).catch((err) => {
    console.error('[audit] write failed:', err.message);
    return null;
  });
};

module.exports = tenantModel('AdminAuditLog', adminAuditLogSchema);
