// src/platform/models/platformBackupModel.js
//
// The list of each gym's stored backups (services/backupJobs.js): where the
// encrypted file is, how big it is, what is in it, and why it was made.
//
// Kept in the platform database, not the gym's own, on purpose: a restore
// replaces the gym's collections, and a list kept among them would be rolled
// back with everything else -- forgetting the backups made since, including
// the one taken just before the restore.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const KINDS = ['daily', 'manual', 'pre-restore'];

const platformBackupSchema = new mongoose.Schema(
  {
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
    // For whoever reads the collection by hand; the id is what is matched.
    gymSlug: { type: String, default: '' },
    //   daily        the scheduled backup (/api/jobs/backups)
    //   manual       "Back up now" in Settings → Data & backup
    //   pre-restore  taken automatically just before a restore
    kind: { type: String, enum: KINDS, required: true },
    url: { type: String, default: '' },
    pathname: { type: String, default: '' },
    // Bytes stored (encrypted).
    size: { type: Number, default: 0 },
    // From the archive's manifest.
    takenAt: { type: Date, default: null },
    documents: { type: Number, default: 0 },
    collections: {
      type: [new mongoose.Schema({ name: String, documents: Number }, { _id: false })],
      default: []
    },
    createdBy: {
      id: { type: String, default: '' },
      email: { type: String, default: '' }
    }
  },
  {
    timestamps: true,
    collection: 'platform_backups'
  }
);

platformBackupSchema.index({ gymId: 1, kind: 1, createdAt: -1 });

platformBackupSchema.statics.KINDS = KINDS;

module.exports = platformModel('PlatformBackup', platformBackupSchema);
