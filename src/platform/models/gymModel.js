// src/platform/models/gymModel.js
//
// One document per gym the platform runs. This is the tenant record: which
// domains lead here, which database holds its data, who owns it, and what
// it is paying for.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

// Lowercase letters, digits and single hyphens, 2-50 chars. Doubles as the
// default database name suffix and the subdomain, so it has to be safe in both.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

const GYM_STATUSES = ['active', 'suspended'];
const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'expired', 'cancelled'];
const BILLING_CYCLES = ['monthly', 'yearly'];

// Everything a request can present as "the site I am on" is reduced to this
// before it is compared: lowercase, no scheme, no path, no trailing dot, no
// leading www. Ports are kept -- localhost:3000 and localhost:3001 are
// different sites during development.
function normalizeHost(raw) {
  if (!raw) return '';
  let host = String(raw).trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  host = host.split('/')[0].split('?')[0].split('#')[0]; // path etc.
  host = host.replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

const domainSchema = new mongoose.Schema(
  {
    host: { type: String, required: true, trim: true, lowercase: true },
    isPrimary: { type: Boolean, default: false },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const gymSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [SLUG_PATTERN, 'Slug may contain lowercase letters, digits and hyphens only']
    },

    // Operator switch. A suspended gym answers every request with 403 until it
    // is switched back on; its data is untouched.
    status: { type: String, enum: GYM_STATUSES, default: 'active', index: true },

    // Uniqueness across gyms is enforced in code (see provisioning.js) rather
    // than by a unique multikey index, which misbehaves for empty arrays.
    domains: { type: [domainSchema], default: [] },

    database: {
      name: { type: String, required: true, trim: true },
      // A gym on its own cluster. Never returned by the API.
      uri: { type: String, default: '', select: false }
    },

    owner: {
      firstName: { type: String, default: '', trim: true },
      lastName: { type: String, default: '', trim: true },
      email: { type: String, default: '', trim: true, lowercase: true },
      phone: { type: String, default: '', trim: true }
    },

    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPlan', default: null },

    subscription: {
      status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'trialing' },
      billingCycle: { type: String, enum: BILLING_CYCLES, default: 'monthly' },
      // What the gym pays a cycle, all in. `planAmount` and `addons` are the
      // breakdown of it: reports read `amount`, invoices read the parts.
      amount: { type: Number, default: 0, min: 0 },
      planAmount: { type: Number, default: 0, min: 0 },
      // Snapshots, not references: the price agreed when the add-on went on
      // does not change because the price list did.
      addons: {
        type: [
          new mongoose.Schema(
            {
              slug: { type: String, required: true, lowercase: true, trim: true },
              name: { type: String, default: '', trim: true },
              amount: { type: Number, default: 0, min: 0 }
            },
            { _id: false }
          )
        ],
        default: []
      },
      currency: { type: String, default: 'USD', uppercase: true, trim: true },
      startedAt: { type: Date, default: null },
      currentPeriodEnd: { type: Date, default: null },
      cancelledAt: { type: Date, default: null },
      notes: { type: String, default: '', trim: true }
    },

    locale: {
      timezone: { type: String, default: 'UTC', trim: true },
      currency: { type: String, default: 'USD', uppercase: true, trim: true },
      country: { type: String, default: '', trim: true }
    },

    notes: { type: String, default: '', trim: true },
    provisionedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SuperAdmin', default: null }
  },
  {
    timestamps: true,
    collection: 'gyms'
  }
);

gymSchema.index({ 'domains.host': 1 });
gymSchema.index({ 'subscription.status': 1, 'subscription.currentPeriodEnd': 1 });

gymSchema.statics.SLUG_PATTERN = SLUG_PATTERN;
gymSchema.statics.GYM_STATUSES = GYM_STATUSES;
gymSchema.statics.SUBSCRIPTION_STATUSES = SUBSCRIPTION_STATUSES;
gymSchema.statics.BILLING_CYCLES = BILLING_CYCLES;
gymSchema.statics.normalizeHost = normalizeHost;

gymSchema.statics.findByHost = function (host) {
  const normalized = normalizeHost(host);
  if (!normalized) return Promise.resolve(null);
  return this.findOne({ 'domains.host': normalized }).lean();
};

gymSchema.statics.findBySlug = function (slug) {
  if (!slug) return Promise.resolve(null);
  return this.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
};

/**
 * Why a gym may not be served right now, or null when it may.
 *
 * `past_due` is still served: the grace period exists so a late invoice is a
 * reminder, not an outage for a gym's members.
 */
gymSchema.statics.accessBlock = function (gym) {
  if (!gym) return { status: 404, code: 'TENANT_NOT_FOUND', message: 'No gym is connected to this domain.' };
  if (gym.status === 'suspended') {
    return { status: 403, code: 'TENANT_SUSPENDED', message: 'This gym has been suspended. Please contact GymPilot support.' };
  }
  const sub = gym.subscription || {};
  if (sub.status === 'expired' || sub.status === 'cancelled') {
    return {
      status: 402,
      code: 'SUBSCRIPTION_INACTIVE',
      message: 'This gym\'s GymPilot subscription is not active. Please contact GymPilot support to renew.'
    };
  }
  return null;
};

module.exports = platformModel('Gym', gymSchema);
