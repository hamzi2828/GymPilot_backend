// src/platform/models/demoRequestModel.js
//
// A gym that asked for a demo on the marketing site. Platform-wide (it is
// not a gym's data yet), so it lives in the main database with the other
// platform records and is worked from the panel's Demo requests page.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const DEMO_REQUEST_STATUSES = ['new', 'contacted', 'converted', 'closed'];

const demoRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200, index: true },
    phone: { type: String, default: '', trim: true, maxlength: 40 },
    gymName: { type: String, default: '', trim: true, maxlength: 160 },
    gymSize: { type: String, default: '', trim: true, maxlength: 60 },
    country: { type: String, default: '', trim: true, maxlength: 120 },
    message: { type: String, default: '', trim: true, maxlength: 4000 },
    // Which page sent it (the URL), for attribution.
    source: { type: String, default: '', trim: true, maxlength: 500 },

    status: { type: String, enum: DEMO_REQUEST_STATUSES, default: 'new', index: true },
    notes: { type: String, default: '', trim: true, maxlength: 4000 },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SuperAdmin', default: null },

    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 500 }
  },
  {
    timestamps: true,
    collection: 'platform_demo_requests'
  }
);

demoRequestSchema.index({ status: 1, createdAt: -1 });

const DemoRequest = platformModel('DemoRequest', demoRequestSchema);
DemoRequest.STATUSES = DEMO_REQUEST_STATUSES;

module.exports = DemoRequest;
