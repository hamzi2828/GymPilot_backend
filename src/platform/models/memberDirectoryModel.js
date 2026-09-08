// src/platform/models/memberDirectoryModel.js
//
// Which gym a username belongs to.
//
// The website knows its gym from the domain it was opened on. The mobile app
// has no domain: a member types the username and password their gym gave
// them and nothing else. This tiny platform-wide index is what turns that
// username into a gym, so the app can then talk to the right database.
//
// It holds no personal data beyond the username itself -- no name, no email,
// no password. The account it points at stays inside its own gym's database.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');
const { currentTenant } = require('../tenantContext');

const memberDirectorySchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
    gymSlug: { type: String, required: true, trim: true },
    // The account inside that gym's database.
    userId: { type: mongoose.Schema.Types.ObjectId, required: true }
  },
  {
    timestamps: true,
    collection: 'platform_member_logins'
  }
);

memberDirectorySchema.index({ gymId: 1, userId: 1 }, { unique: true });

/** Is this username spoken for by somebody other than `userId`? */
memberDirectorySchema.statics.isTaken = async function (username, userId = null) {
  const row = await this.findOne({ username: String(username).toLowerCase().trim() }).select('userId').lean();
  if (!row) return false;
  return !userId || String(row.userId) !== String(userId);
};

/** Record (or move) a user's username against the gym they belong to. */
memberDirectorySchema.statics.publish = async function (user, gym = currentTenant()) {
  if (!user || !user.username || !gym) return null;
  const username = String(user.username).toLowerCase().trim();
  // One row per account: renaming replaces the old username rather than
  // leaving a second one that would still sign in.
  return this.findOneAndUpdate(
    { gymId: gym._id, userId: user._id },
    { $set: { username, gymSlug: gym.slug } },
    { upsert: true, new: true }
  );
};

/** The gym and account a username belongs to, or null. */
memberDirectorySchema.statics.lookup = function (username) {
  return this.findOne({ username: String(username || '').toLowerCase().trim() }).lean();
};

/** Called when an account is deleted, so its username can be reused. */
memberDirectorySchema.statics.withdraw = function (user, gym = currentTenant()) {
  if (!user || !gym) return null;
  return this.deleteOne({ gymId: gym._id, userId: user._id });
};

module.exports = platformModel('MemberDirectory', memberDirectorySchema);
