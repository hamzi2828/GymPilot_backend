// src/platform/models/platformJobRunModel.js
//
// When a scheduled job last ran for each gym: one document per job and gym.
//
// The daily cron fits as many gyms as it can into one invocation and leaves
// the rest for the next day (see jobs.js scheduleActiveGyms). What makes that
// fair is this record: each run starts with the gyms whose last run began
// longest ago, so a gym left over today is first in line tomorrow instead of
// being starved every day for sitting late in the alphabet.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const platformJobRunSchema = new mongoose.Schema(
  {
    // Which job: 'daily' is the cron's per-gym run.
    job: { type: String, required: true, trim: true },
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
    // For whoever reads the collection by hand; the id is what is matched.
    gymSlug: { type: String, default: '' },
    // Written before the gym's work begins. The run order is by this, not by
    // lastRunAt: a gym whose run was cut off by the platform's time limit
    // never gets a lastRunAt, and ordering by that would put it -- and the
    // time limit it hits -- at the front of every run from then on.
    lastStartedAt: { type: Date, default: null },
    // Written when the gym's work ended, whether it went through or failed.
    // For the daily job this is the gym's "last daily run".
    lastRunAt: { type: Date, default: null },
    lastOutcome: { type: String, enum: ['', 'ok', 'error'], default: '' },
    lastError: { type: String, default: '' },
    lastDurationMs: { type: Number, default: null }
  },
  {
    timestamps: true,
    collection: 'platform_job_runs'
  }
);

platformJobRunSchema.index({ job: 1, gymId: 1 }, { unique: true });

module.exports = platformModel('PlatformJobRun', platformJobRunSchema);
