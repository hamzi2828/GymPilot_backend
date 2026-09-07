// src/models/leadModel.js
//
// Somebody who has asked about the gym but has not joined: a walk-in, a
// phone call, a website enquiry. Worked through a short pipeline
// (new → contacted → trial → won / lost) and, when they join, linked to the
// member account that was made for them.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const SOURCES = ['website', 'walk_in', 'phone', 'referral', 'social', 'event', 'other'];
const STATUSES = ['new', 'contacted', 'trial', 'won', 'lost'];

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    at: { type: Date, default: Date.now }
  },
  { _id: true }
);

const leadSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, default: '', trim: true },
    email: { type: String, default: '', lowercase: true, trim: true, index: true },
    phone: { type: String, default: '', trim: true, index: true },
    source: { type: String, enum: SOURCES, default: 'walk_in' },
    status: { type: String, enum: STATUSES, default: 'new', index: true },
    // What they asked about -- a package name, "personal training", free text.
    interest: { type: String, default: '', trim: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    nextFollowUpAt: { type: Date, default: null, index: true },
    lastContactedAt: { type: Date, default: null },
    notes: { type: [noteSchema], default: [] },
    tags: { type: [String], default: [] },
    lostReason: { type: String, default: '', trim: true },
    // The member account made when they joined.
    convertedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    convertedAt: { type: Date, default: null },
    // The website enquiry this came from, if any.
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  {
    timestamps: true,
    collection: 'gym_leads'
  }
);

leadSchema.index({ status: 1, nextFollowUpAt: 1 });
leadSchema.index({ createdAt: -1 });

leadSchema.statics.SOURCES = SOURCES;
leadSchema.statics.STATUSES = STATUSES;

module.exports = tenantModel('Lead', leadSchema);
