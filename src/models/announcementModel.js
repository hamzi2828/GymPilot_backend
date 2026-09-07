// src/models/announcementModel.js
//
// A notice shown inside the site: a bar on the public pages, a banner in the
// member portal, or both. "Closed Monday for maintenance" does not need an
// email to everybody; it needs to be where people look.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '', trim: true },
    // members: signed-in portal only. public: the website. all: both.
    audience: { type: String, enum: ['members', 'public', 'all'], default: 'members' },
    tone: { type: String, enum: ['info', 'success', 'warning'], default: 'info' },
    url: { type: String, default: '', trim: true },
    urlLabel: { type: String, default: '', trim: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    collection: 'gym_announcements'
  }
);

announcementSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });

/** The announcements live right now for a visitor (signed in or not). */
announcementSchema.statics.liveFor = function (signedIn, now = new Date()) {
  const audiences = signedIn ? ['members', 'public', 'all'] : ['public', 'all'];
  return this.find({
    isActive: true,
    audience: { $in: audiences },
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }
    ]
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
};

module.exports = tenantModel('Announcement', announcementSchema);
