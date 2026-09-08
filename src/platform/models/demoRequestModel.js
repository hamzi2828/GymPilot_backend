// src/platform/models/demoRequestModel.js
//
// A gym that asked for a demo, or one that filled in checkout to start a
// trial. Both are the same thing at this stage -- somebody who wants a gym set
// up -- so they are one record with a `kind`, worked from the panel's Demo
// requests page. Platform-wide (it is not a gym's data yet), so it lives in
// the main database with the other platform records.
//
// A checkout also carries what they chose: the plan, the billing cycle, the
// add-ons, and what that came to. The price is worked out on the server, not
// taken from the form, so the record says what we would actually charge.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const DEMO_REQUEST_STATUSES = ['new', 'contacted', 'converted', 'closed'];
const DEMO_REQUEST_KINDS = ['demo', 'trial'];

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

    // 'demo' asked us to show them; 'trial' picked a plan at checkout.
    kind: { type: String, enum: DEMO_REQUEST_KINDS, default: 'demo', index: true },
    // The web address they asked for, if they got as far as choosing one.
    preferredSlug: { type: String, default: '', trim: true, lowercase: true, maxlength: 60 },
    plan: {
      slug: { type: String, default: '', trim: true, lowercase: true },
      name: { type: String, default: '', trim: true },
      billingCycle: { type: String, default: 'monthly', trim: true },
      addonSlugs: { type: [String], default: [] },
      addonNames: { type: [String], default: [] },
      amount: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: '', uppercase: true, trim: true },
      trialDays: { type: Number, default: 0, min: 0 }
    },

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
DemoRequest.KINDS = DEMO_REQUEST_KINDS;

module.exports = DemoRequest;
