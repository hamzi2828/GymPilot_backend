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

    // Emailed six-digit code at sign-in, per account.
    twoFactor: {
      enabled: { type: Boolean, default: false },
      pending: {
        challengeId: { type: String, default: null, index: true },
        codeHash: { type: String, default: null, select: false },
        expiresAt: { type: Date, default: null },
        attempts: { type: Number, default: 0 }
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
