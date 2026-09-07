// src/platform/models/platformAuditLogModel.js
//
// Who did what to which gym from the platform panel. Suspending a paying
// customer or dropping a database is the kind of action that needs a trail.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const platformAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'SuperAdmin', default: null },
    actorEmail: { type: String, default: '' },
    action: { type: String, required: true, index: true },
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', default: null, index: true },
    gymSlug: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' }
  },
  {
    timestamps: true,
    collection: 'platform_audit_logs'
  }
);

platformAuditLogSchema.index({ createdAt: -1 });

// Never lets a failed log write break the action it describes.
platformAuditLogSchema.statics.record = function (entry) {
  return this.create(entry).catch((err) => {
    console.error('[platform] audit log write failed:', err.message);
    return null;
  });
};

module.exports = platformModel('PlatformAuditLog', platformAuditLogSchema);
