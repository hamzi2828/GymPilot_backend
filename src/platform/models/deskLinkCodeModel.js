// src/platform/models/deskLinkCodeModel.js
//
// One-time codes that link a front-desk PC to a gym from the admin panel.
//
// An owner presses "Get link code" on the website's Desk app page and types
// the code into the Windows app. The app does not know which gym it belongs
// to yet -- that is what the code tells it -- so the code cannot live in a
// gym's own database: it is looked up before any gym is known. Hence the
// platform database, beside the list of gyms.
//
// Only a keyed hash of the code is stored (see deskLinkController.hashCode).
// A code is 40 random bits, few enough that a plain SHA-256 of it could be
// reversed from a database dump in seconds; with the server's secret mixed
// in, the dump alone is not enough.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

// Expired codes are kept a day before MongoDB removes them, so a desk typing
// one a little late is told "expired" rather than "not a code", and the
// trail of who linked what survives the afternoon.
const KEEP_AFTER_EXPIRY_SECONDS = 24 * 60 * 60;

const deskLinkCodeSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
    gymSlug: { type: String, default: '' },
    // The account the desk is signed in as once the code is used: the one
    // that asked for it. In the gym's own database, so not a ref here.
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userEmail: { type: String, default: '' },

    expiresAt: { type: Date, required: true },
    // Set, atomically, by the one redeem that wins. A code is spent the
    // moment it is claimed, whatever happens after.
    usedAt: { type: Date, default: null },
    usedIp: { type: String, default: '' },
    usedDevice: { type: String, default: '' },
    // Set when a newer code from the same account pushed this one out.
    revokedAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    collection: 'platform_desk_link_codes'
  }
);

deskLinkCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: KEEP_AFTER_EXPIRY_SECONDS });
deskLinkCodeSchema.index({ gymId: 1, userId: 1, usedAt: 1, revokedAt: 1, expiresAt: 1 });

module.exports = platformModel('DeskLinkCode', deskLinkCodeSchema);
