// src/platform/models/superAdminModel.js
//
// The people who run the platform. A separate collection from any gym's
// users on purpose: a gym administrator's credentials must never be able to
// open the panel that lists every other gym.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const superAdminSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
    // Which generation of sessions is still good. Every token carries the
    // number it was signed under; changing or resetting the password, or
    // signing out, moves this on and every token before it stops working
    // (middleware/platformAuth.js).
    tokenVersion: { type: Number, default: 0 },

    // A second step at sign-in, per account: a six-digit code emailed each
    // time, or one from an authenticator app (platform/totp.js).
    twoFactor: {
      enabled: { type: Boolean, default: false },
      method: { type: String, enum: ['email', 'totp'], default: 'email' },
      pending: {
        challengeId: { type: String, default: null, index: true },
        codeHash: { type: String, default: null, select: false },
        expiresAt: { type: Date, default: null },
        attempts: { type: Number, default: 0 }
      },
      // The authenticator app. Secrets are sealed (services/secretBox.js);
      // backup codes are kept as hashes only and shown once.
      totp: {
        secret: { type: String, default: null, select: false },
        // Set up but not yet confirmed with a code: not used for sign-in.
        pendingSecret: { type: String, default: null, select: false },
        pendingExpiresAt: { type: Date, default: null },
        // The last time step a code was accepted for; never accepted twice.
        lastStep: { type: Number, default: -1 },
        backupCodes: { type: [String], default: [], select: false },
        backupCodesRemaining: { type: Number, default: 0 },
        enabledAt: { type: Date, default: null },
        // Wrong codes across sign-ins, so a fresh challenge per password
        // does not mean a fresh allowance of guesses.
        failures: { type: Number, default: 0 },
        lockedUntil: { type: Date, default: null }
      }
    },

    // Only the hash of an outstanding reset token is kept; the token itself
    // is emailed and forgotten.
    passwordReset: {
      tokenHash: { type: String, default: null, select: false },
      expiresAt: { type: Date, default: null }
    }
  },
  {
    timestamps: true,
    collection: 'super_admins'
  }
);

module.exports = platformModel('SuperAdmin', superAdminSchema);
