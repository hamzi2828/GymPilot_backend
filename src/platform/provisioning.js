// src/platform/provisioning.js
//
// Creating a gym: the platform record, its empty database, and the first
// things that database needs before an owner can sign in -- the system
// roles, a settings row carrying the gym's name, the homepage sections, the
// legal pages, and the owner's administrator account.
//
// Seeding runs inside a tenant context for the new gym, so it is the very
// same code every request uses; nothing here writes to a database by hand.
// If any step fails the platform record is removed again, so a half-made gym
// never lingers in the list.

const bcrypt = require('bcryptjs');
const Gym = require('./models/gymModel');
const PlatformPlan = require('./models/platformPlanModel');
const { databaseNameFor, dropTenantDatabase } = require('./connections');
const { runWithTenant, originForHost } = require('./tenantContext');
const { invalidateTenantCache } = require('./middleware/resolveTenant');

// Tenant-side models and services. Proxies: they bind to the new gym's
// database while runWithTenant() is active.
const User = require('../models/user');
const Settings = require('../models/settings');
const HomeSection = require('../models/homeSectionModel');
const contentPageDefaults = require('../seeds/contentPageDefaults');
const { ensureDefaultRoles, ADMIN_SLUG } = require('../services/roleService');

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const MIN_PASSWORD_LENGTH = 8;

class ProvisioningError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Cleans a list of {host, isPrimary} (or bare host strings): normalised,
 * de-duplicated, validated, exactly one primary.
 */
function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  const seen = new Set();
  const domains = [];

  for (const entry of list) {
    const raw = typeof entry === 'string' ? entry : entry && entry.host;
    const host = Gym.normalizeHost(raw);
    if (!host) continue;
    if (!HOST_PATTERN.test(host)) {
      throw new ProvisioningError(`"${raw}" is not a valid domain name`);
    }
    if (seen.has(host)) continue;
    seen.add(host);
    domains.push({
      host,
      isPrimary: !!(entry && typeof entry === 'object' && entry.isPrimary),
      addedAt: new Date()
    });
  }

  if (domains.length && !domains.some((d) => d.isPrimary)) domains[0].isPrimary = true;
  // Only one primary, whatever the caller sent.
  let primarySeen = false;
  for (const d of domains) {
    if (d.isPrimary && primarySeen) d.isPrimary = false;
    if (d.isPrimary) primarySeen = true;
  }
  return domains;
}

async function assertDomainsAvailable(domains, excludeGymId = null) {
  const hosts = domains.map((d) => d.host);
  if (!hosts.length) return;
  const query = { 'domains.host': { $in: hosts } };
  if (excludeGymId) query._id = { $ne: excludeGymId };
  const clash = await Gym.find(query).select('slug name domains').lean();
  if (clash.length) {
    const taken = clash
      .flatMap((g) => g.domains.map((d) => d.host))
      .filter((h) => hosts.includes(h));
    throw new ProvisioningError(
      `Domain already in use by another gym: ${[...new Set(taken)].join(', ')}`,
      409,
      { domains: taken, gyms: clash.map((g) => g.slug) }
    );
  }
}

async function assertSlugAvailable(slug) {
  if (!Gym.SLUG_PATTERN.test(slug)) {
    throw new ProvisioningError('Slug may contain lowercase letters, digits and hyphens only (2-50 characters)');
  }
  const existing = await Gym.findOne({ slug }).select('_id').lean();
  if (existing) throw new ProvisioningError(`A gym with the slug "${slug}" already exists`, 409);
}

function subscriptionFor(plan, input = {}) {
  const now = new Date();
  const sub = {
    status: input.status || (plan ? 'trialing' : 'active'),
    billingCycle: input.billingCycle || 'monthly',
    amount: 0,
    currency: (plan && plan.price && plan.price.currency) || 'USD',
    startedAt: input.startedAt ? new Date(input.startedAt) : now,
    currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
    notes: input.notes || ''
  };

  if (plan) {
    sub.amount = sub.billingCycle === 'yearly' ? plan.price.yearly : plan.price.monthly;
    if (!sub.currentPeriodEnd) {
      const days = sub.status === 'trialing' ? Number(plan.trialDays) || 0 : sub.billingCycle === 'yearly' ? 365 : 30;
      sub.currentPeriodEnd = days ? new Date(now.getTime() + days * 86400000) : null;
    }
  }
  if (input.amount !== undefined && input.amount !== null && input.amount !== '') sub.amount = Number(input.amount) || 0;
  if (input.currency) sub.currency = String(input.currency).toUpperCase();

  return sub;
}

/**
 * Everything a fresh gym database needs before the owner signs in. Every
 * step is idempotent, so re-running it against an existing database only
 * fills in what is missing.
 */
async function seedTenantDefaults({ gym, owner, adoptExisting = false }) {
  await ensureDefaultRoles();

  const primary = (gym.domains || []).find((d) => d.isPrimary) || (gym.domains || [])[0];
  const siteUrl = primary
    ? originForHost(primary.host)
    : (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');

  // Settings.getSettings() creates the row with an empty siteUrl, which the
  // schema then refuses (it is required) -- fine on a database that already
  // has one, fatal on a brand-new gym's. So the first row is written here,
  // with the gym's name and website in it from the start.
  let settings = await Settings.findOne({ isActive: true });
  if (!settings) {
    settings = await Settings.create({ siteName: gym.name, siteUrl, isActive: true });
  }
  // A gym that was already running before it joined the platform has, by
  // definition, been set up; only a brand-new one gets the wizard.
  if (adoptExisting && !settings.setupCompletedAt) {
    settings.setupCompletedAt = new Date();
    await settings.save();
  }

  if (!adoptExisting) {
    const update = { siteName: gym.name, siteUrl };
    // Settings only accepts the currencies its enum lists; anything else
    // keeps the default rather than failing the whole provisioning run.
    const enumValues = Settings.schema.path('currency').enumValues || [];
    if (gym.locale && gym.locale.currency && enumValues.includes(gym.locale.currency)) {
      update.currency = gym.locale.currency;
    }
    settings = await Settings.updateSettings(update);
  }

  await HomeSection.ensureDefaults();
  await contentPageDefaults.ensureSeeded();

  let ownerUser = null;
  if (owner && owner.email && owner.password) {
    const email = String(owner.email).toLowerCase().trim();
    ownerUser = await User.findOne({ email });
    if (!ownerUser) {
      const hashed = await bcrypt.hash(owner.password, await bcrypt.genSalt(10));
      ownerUser = await User.create({
        firstName: owner.firstName || 'Gym',
        lastName: owner.lastName || 'Owner',
        email,
        password: hashed,
        role: ADMIN_SLUG,
        isActive: true,
        phone: owner.phone || null,
        employment: { isStaff: true, jobTitle: 'Owner', joinedAt: new Date() }
      });
    } else if (ownerUser.role !== ADMIN_SLUG) {
      ownerUser.role = ADMIN_SLUG;
      await ownerUser.save();
    }
  }

  return { settingsId: settings && settings._id, owner: ownerUser ? { id: String(ownerUser._id), email: ownerUser.email } : null };
}

function validateOwner(owner, { required }) {
  const o = owner || {};
  if (!required && !o.email) return null;
  const email = String(o.email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ProvisioningError('A valid owner email is required');
  if (o.password !== undefined && o.password !== null && o.password !== '') {
    if (typeof o.password !== 'string' || o.password.length < MIN_PASSWORD_LENGTH) {
      throw new ProvisioningError(`Owner password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  } else if (required) {
    throw new ProvisioningError('An owner password is required so they can sign in');
  }
  return {
    firstName: String(o.firstName || '').trim(),
    lastName: String(o.lastName || '').trim(),
    email,
    phone: String(o.phone || '').trim(),
    password: o.password || null
  };
}

/**
 * Creates and seeds a new gym.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} [input.slug]         defaults to a slug of the name
 * @param {Array}  [input.domains]      hosts or {host, isPrimary}
 * @param {object} input.owner          { firstName, lastName, email, phone, password }
 * @param {string} [input.planId]
 * @param {object} [input.locale]       { timezone, currency, country }
 * @param {object} [input.database]     { name, uri } -- both optional
 * @param {object} [input.subscription] overrides for status / cycle / period end
 * @param {boolean}[input.adoptExisting] true to register a database that already
 *                                       holds a gym (the pre-platform deployment)
 */
async function provisionGym(input, { createdBy = null } = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new ProvisioningError('Gym name is required');

  const slug = slugify(input.slug || name);
  await assertSlugAvailable(slug);

  const domains = normalizeDomains(input.domains);
  await assertDomainsAvailable(domains);

  const adoptExisting = !!input.adoptExisting;
  const owner = validateOwner(input.owner, { required: !adoptExisting });

  let plan = null;
  if (input.planId) {
    plan = await PlatformPlan.findById(input.planId).lean();
    if (!plan) throw new ProvisioningError('Plan not found', 404);
  }

  const database = {
    name: String((input.database && input.database.name) || databaseNameFor(slug)).trim(),
    uri: String((input.database && input.database.uri) || '').trim()
  };

  const gym = await Gym.create({
    name,
    slug,
    status: 'active',
    domains,
    database,
    owner: owner ? { firstName: owner.firstName, lastName: owner.lastName, email: owner.email, phone: owner.phone } : {},
    plan: plan ? plan._id : null,
    subscription: subscriptionFor(plan, input.subscription || {}),
    locale: {
      timezone: (input.locale && input.locale.timezone) || 'UTC',
      currency: String((input.locale && input.locale.currency) || 'USD').toUpperCase(),
      country: (input.locale && input.locale.country) || ''
    },
    notes: input.notes || '',
    createdBy
  });

  try {
    // The connection needs the uri, which the schema hides from reads.
    const gymForSeed = gym.toObject();
    gymForSeed.database = database;
    const seeded = await runWithTenant(gymForSeed, () => seedTenantDefaults({ gym: gymForSeed, owner, adoptExisting }));
    gym.provisionedAt = new Date();
    await gym.save();
    invalidateTenantCache();
    return { gym, seeded };
  } catch (error) {
    // Roll back the record; the empty database (if any was touched) is
    // harmless and is reused if the same slug is provisioned again.
    await Gym.deleteOne({ _id: gym._id }).catch(() => {});
    throw new ProvisioningError(`Could not set up the gym's database: ${error.message}`, 500);
  }
}

/**
 * Replaces a gym's domain list. Returns the saved gym.
 */
async function replaceDomains(gym, input) {
  const domains = normalizeDomains(input);
  await assertDomainsAvailable(domains, gym._id);
  gym.domains = domains;
  await gym.save();
  invalidateTenantCache();
  return gym;
}

/**
 * Removes a gym from the platform. The database is kept unless asked for
 * explicitly, and even then only after the caller has typed the slug back.
 */
async function deleteGym(gym, { confirmSlug, dropDatabase = false } = {}) {
  if (confirmSlug !== gym.slug) {
    throw new ProvisioningError('Type the gym\'s slug to confirm deletion', 400);
  }
  if (dropDatabase) {
    const withUri = await Gym.findById(gym._id).select('+database.uri').lean();
    await dropTenantDatabase(withUri || gym);
  }
  await Gym.deleteOne({ _id: gym._id });
  invalidateTenantCache();
  return { deleted: true, databaseDropped: !!dropDatabase };
}

module.exports = {
  ProvisioningError,
  provisionGym,
  replaceDomains,
  deleteGym,
  seedTenantDefaults,
  normalizeDomains,
  assertDomainsAvailable,
  subscriptionFor,
  slugify
};
