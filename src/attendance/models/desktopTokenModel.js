// src/attendance/models/desktopTokenModel.js
//
// Bearer tokens for the front-desk desktop app (GymPilot_desktopApp).
//
// Deliberately NOT the normal 7-day web JWT: a front-desk PC is left signed
// in for weeks, so it needs a long-lived credential that can be revoked from
// the server the moment a PC is lost or an account is withdrawn -- something
// a stateless JWT cannot offer. Only the SHA-256 hash of the token is stored,
// so a database dump does not hand anyone a working session.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');
const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 30;

const desktopTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    // SHA-256 of the bearer token. The token itself is returned once, at
    // login, and never stored anywhere on this side.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    // Which front-desk PC this token belongs to. Recorded at login and shown
    // on the punch receipt, so an attendance row can be traced to the machine
    // that took it.
    deviceLabel: { type: String, default: '', trim: true },
    clientApp: { type: String, default: '', trim: true },
    osUser: { type: String, default: '', trim: true },
    ip: { type: String, default: '', trim: true },

    expiresAt: { type: Date, required: true, index: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application. See the
    // note in attendanceModel.js.
    collection: 'gym_desktop_tokens'
  }
);

desktopTokenSchema.index({ userId: 1, revokedAt: 1 });

desktopTokenSchema.statics.hashToken = function (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
};

// Returns the plaintext token exactly once -- the caller must send it to the
// app now, because it is unrecoverable afterwards.
desktopTokenSchema.statics.issue = async function (userId, context = {}, ttlDays = DEFAULT_TTL_DAYS) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await this.create({
    userId,
    tokenHash: this.hashToken(token),
    deviceLabel: context.deviceLabel || '',
    clientApp: context.clientApp || '',
    osUser: context.osUser || '',
    ip: context.ip || '',
    expiresAt
  });

  return { token, expiresAt };
};

desktopTokenSchema.statics.findUsable = function (token) {
  return this.findOne({
    tokenHash: this.hashToken(token),
    revokedAt: null,
    expiresAt: { $gt: new Date() }
  });
};

// Used both on sign-out (one token) and when an account loses app access
// (every token it holds, so a revoked PC drops to the login screen on its
// very next request rather than at the end of the 30 days).
desktopTokenSchema.statics.revokeAllForUser = function (userId) {
  return this.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

module.exports =
  tenantModel('DesktopToken', desktopTokenSchema);
