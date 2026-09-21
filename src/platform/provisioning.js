// src/platform/provisioning.js
//
// Creating a gym: the platform record, its empty database, and the first
// things that database needs before an owner can sign in -- the system
// roles, a settings row carrying the gym's name, the homepage sections, the
// legal pages, and the owner's administrator account.
//
// Seeding runs inside a tenant context for the new gym, so it is the very
// same code every request uses; nothing here writes to a database by hand.
// If any step fails the platform record is removed again (and the database
// it had just created is dropped), so a half-made gym never lingers.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Gym = require('./models/gymModel');
const PlatformPlan = require('./models/platformPlanModel');
const { dropTenantDatabase } = require('./connections');
const { databaseNameFor, tenantDatabaseNameFor, MAX_DATABASE_NAME_LENGTH, isProtectedDatabase, tenantDatabasePrefix } = require('./dbNames');
const { runWithTenant, siteUrlFor, inviteSiteUrlFor, isDefaultTenant, subdomainHostFor, isInsecureHost } = require('./tenantContext');
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
const CURRENCY_CODE = /^[A-Z]{3}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

// Labels that mean something under the platform's root domain already (or
// would confuse a browser, a mail server or a person) and so can never be a
// gym's subdomain.
const RESERVED_SLUGS = new Set([
  'api', 'www', 'app', 'admin', 'mail', 'platform', 'static', 'assets', 'cdn',
  'help', 'support', 'docs', 'blog', 'status', 'login', 'checkout', 'panel'
]);

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

function isReservedSlug(slug) {
  return RESERVED_SLUGS.has(String(slug || '').toLowerCase().trim());
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
  if (isReservedSlug(slug)) {
    throw new ProvisioningError(`"${slug}" is reserved and cannot be a gym's web address`);
  }
  const existing = await Gym.findOne({ slug }).select('_id').lean();
  if (existing) throw new ProvisioningError(`A gym with the slug "${slug}" already exists`, 409);
}

/**
 * A free slug built from the gym's name. Nobody types one any more -- the
 * name is the only thing anyone should have to decide -- so a second "Iron
 * Works" becomes iron-works-2 rather than an error somebody has to resolve.
 * A reserved label ("admin", "support") counts as taken for the same reason.
 *
 * Only used when the caller did not name a slug itself; an explicit one that
 * is taken or reserved is still refused, because that was a decision, not a
 * guess.
 */
async function freeSlugFrom(name) {
  // Cut, then trimmed again: a cut that lands on a hyphen would leave a slug
  // the pattern refuses.
  const base = slugify(name).slice(0, 44).replace(/-+$/, '') || 'gym';
  if (!Gym.SLUG_PATTERN.test(base)) {
    throw new ProvisioningError('The gym name needs at least two letters or digits');
  }

  const taken = new Set(
    (await Gym.find({ slug: new RegExp(`^${base}(-\\d+)?$`) }).select('slug').lean()).map((g) => g.slug)
  );
  if (!taken.has(base) && !isReservedSlug(base)) return base;

  for (let n = 2; n <= 200; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * The database this gym's data lives in. The slug alone would be reused if a
 * gym were ever deleted and another took its name, so a short id goes on the
 * end: two gyms can never end up pointed at one database.
 */
function uniqueDatabaseNameFor(slug) {
  return tenantDatabaseNameFor(slug, crypto.randomBytes(3).toString('hex'));
}

// What MongoDB will not have in a database name.
const DATABASE_NAME_FORBIDDEN = /[/\\. "$*<>:|?\0]/;

/**
 * What a caller may say about the database. Only the API applies this (the
 * scripts that adopt an existing deployment name the platform database on
 * purpose): a gym created from the panel can only land in a fresh database
 * under the tenant prefix, and only on the shared cluster unless the
 * deployment has opted in to dedicated ones.
 */
function validateDatabaseInput(database, { allowDedicatedUri = process.env.ALLOW_DEDICATED_DB_URI === '1' } = {}) {
  const name = String((database && database.name) || '').trim();
  const uri = String((database && database.uri) || '').trim();

  if (uri && !allowDedicatedUri) {
    throw new ProvisioningError('A dedicated database URI is not accepted here. Leave database.uri empty, or set ALLOW_DEDICATED_DB_URI=1 on the API to allow it.');
  }
  if (name) {
    if (isProtectedDatabase(name)) {
      throw new ProvisioningError(`"${name}" is the platform's own database; a gym cannot be created in it`);
    }
    // Refused here with a reason rather than by MongoDB halfway through
    // provisioning with a 500.
    if (name.length > MAX_DATABASE_NAME_LENGTH) {
      throw new ProvisioningError(`Database names can be at most ${MAX_DATABASE_NAME_LENGTH} characters ("${name}" is ${name.length}). Leave it empty and one is chosen for you.`);
    }
    if (DATABASE_NAME_FORBIDDEN.test(name)) {
      throw new ProvisioningError(`"${name}" is not a valid database name: use letters, digits, underscores and hyphens only`);
    }
    const prefix = tenantDatabasePrefix();
    if (!uri && !name.startsWith(prefix)) {
      throw new ProvisioningError(`Database names must start with "${prefix}"`);
    }
  }
  return { name, uri };
}

/**
 * What of a gym's locale goes into its Settings row: the currency when it is
 * a real ISO code, the country when Settings has a field for it and the
 * value is a two-letter code (the record accepts free text, Settings does
 * not). Anything else keeps the Settings default rather than failing the
 * whole provisioning run.
 */
function localeSettingsFor(locale, { hasCountry = true } = {}) {
  const update = {};
  const currency = String((locale && locale.currency) || '').toUpperCase().trim();
  if (CURRENCY_CODE.test(currency)) update.currency = currency;
  if (hasCountry) {
    const country = String((locale && locale.country) || '').toUpperCase().trim();
    if (COUNTRY_CODE.test(country)) update.country = country;
  }
  return update;
}

function addonCurrency(addon) {
  return String((addon && addon.price && addon.price.currency) || '').toUpperCase().trim();
}

/**
 * The subscription a gym is put on: a plan, whatever add-ons were switched on
 * with it, and the total of the two.
 *
 * Only add-ons priced in the plan's currency are added -- a PKR add-on on a
 * USD plan would make the total a number in no currency at all. Included
 * ones cost nothing and are kept whatever their list price says.
 *
 * A plan with no trial days (or a trial with no plan) ends its period NOW,
 * not never: the first payment is due at once, and the daily roll-over
 * (jobs.js) only moves gyms whose period end is a date.
 *
 * @param {object|null} plan    the plan document, or null for no plan
 * @param {object} input        status, billingCycle, amount, currency, dates
 * @param {Array} addons        add-on documents already resolved by the caller
 */
function subscriptionFor(plan, input = {}, addons = []) {
  const now = new Date();
  const sub = {
    status: input.status || (plan ? 'trialing' : 'active'),
    billingCycle: input.billingCycle || 'monthly',
    amount: 0,
    planAmount: 0,
    addons: [],
    currency: (plan && plan.price && plan.price.currency) || 'PKR',
    startedAt: input.startedAt ? new Date(input.startedAt) : now,
    currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
    notes: input.notes || ''
  };

  if (plan) {
    sub.planAmount = sub.billingCycle === 'yearly' ? plan.price.yearly : plan.price.monthly;
    if (!sub.currentPeriodEnd) {
      const days = sub.status === 'trialing' ? Math.max(0, Number(plan.trialDays) || 0) : sub.billingCycle === 'yearly' ? 365 : 30;
      sub.currentPeriodEnd = new Date(now.getTime() + days * 86400000);
    }
  } else if (sub.status === 'trialing' && !sub.currentPeriodEnd) {
    // A trial with nothing to trial: due now.
    sub.currentPeriodEnd = now;
  }
  // `amount` has always meant the plan's price; a hand-typed one still does.
  if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
    sub.planAmount = Number(input.amount) || 0;
  }

  // What the plan already includes costs nothing on top of it.
  const included = new Set(((plan && plan.includedAddons) || []).map((slug) => String(slug).toLowerCase()));
  const planCurrency = String(sub.currency).toUpperCase();
  sub.addons = (addons || [])
    .filter(Boolean)
    .filter((addon) => included.has(addon.slug) || !addonCurrency(addon) || addonCurrency(addon) === planCurrency)
    .map((addon) => ({
      slug: addon.slug,
      name: addon.name,
      amount: included.has(addon.slug)
        ? 0
        : typeof addon.amountFor === 'function'
        ? addon.amountFor(sub.billingCycle)
        : Number((sub.billingCycle === 'yearly' ? addon.price && addon.price.yearly : addon.price && addon.price.monthly) || 0)
    }));

  sub.amount = sub.addons.reduce((total, addon) => total + (Number(addon.amount) || 0), sub.planAmount);
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

  // The gym's website: its primary domain, else its platform subdomain, else
  // the env fallback (see tenantContext.siteUrlFor).
  const siteUrl = siteUrlFor(gym);

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
    const update = {
      siteName: gym.name,
      siteUrl,
      ...localeSettingsFor(gym.locale, { hasCountry: !!Settings.schema.path('country') })
    };
    settings = await Settings.updateSettings(update);
  }

  await HomeSection.ensureDefaults();
  await contentPageDefaults.ensureSeeded();

  let ownerUser = null;
  if (owner && owner.email && owner.password) {
    const email = String(owner.email).toLowerCase().trim();
    ownerUser = await User.findOne({ email });
    if (!ownerUser) {
      // On the staff list like anyone who works there, but not one of the
      // plan's staff seats: planLimits knows the owner by gym.owner.email.
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

  return {
    settingsId: settings && settings._id,
    siteUrl,
    owner: ownerUser ? { id: String(ownerUser._id), email: ownerUser.email } : null
  };
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
 * Whether a database of that name exists on the shared cluster right now.
 * Null when it could not be told (no listDatabases privilege, say) -- the
 * caller treats "unknown" as "leave it alone".
 */
async function sharedDatabaseExists(name) {
  try {
    await mongoose.connection.asPromise();
    const { databases } = await mongoose.connection.getClient().db().admin().listDatabases({ nameOnly: true });
    return databases.some((d) => d.name === name);
  } catch {
    return null;
  }
}

/**
 * Creates and seeds a new gym.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} [input.slug]         defaults to a slug of the name
 * @param {Array}  [input.domains]      hosts or {host, isPrimary}
 * @param {object} input.owner          { firstName, lastName, email, phone, password }
 * @param {string} [input.preferredSlug] the address they asked for, if free
 * @param {string} [input.planId]
 * @param {object} [input.locale]       { timezone, currency, country }
 * @param {object} [input.database]     { name, uri } -- both optional
 * @param {object} [input.subscription] overrides for status / cycle / period end,
 *                                  plus `addonSlugs` for anything sold beside
 *                                  the plan (see controllers/addonsController)
 * @param {boolean}[input.adoptExisting] true to register a database that already
 *                                       holds a gym (the pre-platform deployment)
 * @param {object} [options]
 * @param {*}      [options.createdBy]             super admin id
 * @param {boolean}[options.enforceDatabasePolicy] true from the API: see validateDatabaseInput
 * @param {boolean}[options.requireSite]           true from the API: refuse a gym the website
 *                                                 could not be reached on (see below)
 * @param {object} [options.stripe]                { customerId, subscriptionId } of a payment that
 *                                                 already happened (a signup from the marketing site),
 *                                                 written with the gym so a retried webhook finds it
 *
 * @returns {Promise<{gym, seeded, siteUrl, inviteSiteUrl, warnings: string[], ownerInvite: {sent: boolean, error?: string}}>}
 */
async function provisionGym(input, { createdBy = null, enforceDatabasePolicy = false, requireSite = false, stripe = null } = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new ProvisioningError('Gym name is required');
  const warnings = [];

  // Three ways in. `slug` is a decision -- a script adopting a database that
  // already exists means that exact one, so a clash is an error. Anything
  // else is a preference: the address a buyer asked for at checkout, or just
  // the gym's name, and a clash only means a number on the end.
  const slug = input.slug ? slugify(input.slug) : await freeSlugFrom(input.preferredSlug || name);
  if (input.slug) await assertSlugAvailable(slug);

  const domains = normalizeDomains(input.domains);
  await assertDomainsAvailable(domains);

  // Under the platform's root domain every gym has an address from the
  // start: <slug>.<root>. Primary only when nothing else was registered.
  const subdomain = subdomainHostFor(slug);
  if (subdomain && !domains.some((d) => d.host === subdomain)) {
    const holder = await Gym.findOne({ 'domains.host': subdomain }).select('slug').lean();
    if (holder) {
      warnings.push(`${subdomain} is already registered to ${holder.slug}, so it was not added to this gym`);
    } else {
      domains.push({ host: subdomain, isPrimary: domains.length === 0, addedAt: new Date() });
    }
  }

  const adoptExisting = !!input.adoptExisting;

  // The website picks its gym by the host it is visited on, and nothing
  // else. A gym with no domain and no platform subdomain has no host: its
  // links fall back to FRONTEND_ORIGIN, which is the default gym's site, so
  // the owner's set-password link would look for their token in the wrong
  // gym and call it invalid. Better said now than after the gym exists.
  const servedByDefault = !!process.env.FRONTEND_ORIGIN && isDefaultTenant({ slug });
  if (requireSite && !adoptExisting && !domains.length && !servedByDefault) {
    throw new ProvisioningError(
      'This gym would have no web address, so nobody could open its site or the owner\'s set-password link. ' +
        'Add a domain for it (for local testing, a host such as ironworks.localhost:3000 works), or set PLATFORM_ROOT_DOMAIN on the API so every gym gets <slug>.<root domain>.'
    );
  }

  const owner = validateOwner(input.owner, { required: !adoptExisting });

  let plan = null;
  if (input.planId) {
    plan = await PlatformPlan.findById(input.planId).lean();
    if (!plan) throw new ProvisioningError('Plan not found', 404);
  }

  // Required here rather than at the top: addonsController requires this file
  // for slugify, and two modules requiring each other at load time is how you
  // get an empty object at three in the morning.
  const { resolveAddons } = require('./controllers/addonsController');
  let addons = [];
  try {
    addons = await resolveAddons((input.subscription || {}).addonSlugs, plan);
  } catch (error) {
    throw new ProvisioningError(error.message, error.status || 400);
  }

  const requested = enforceDatabasePolicy ? validateDatabaseInput(input.database) : input.database || {};
  const database = {
    name: String(requested.name || uniqueDatabaseNameFor(slug)).trim(),
    uri: String(requested.uri || '').trim()
  };

  // Known before anything is written, so the rollback can tell a database it
  // created from one that was already there.
  const databaseExistedBefore = adoptExisting || database.uri ? true : await sharedDatabaseExists(database.name);

  const subscription = subscriptionFor(plan, input.subscription || {}, addons);
  // Set in the same write that creates the gym, not after: a paid signup
  // whose webhook is retried looks for its gym by these, and must find it
  // even if the process died a moment after this line.
  if (stripe) {
    subscription.stripeCustomerId = String(stripe.customerId || '');
    subscription.stripeSubscriptionId = String(stripe.subscriptionId || '');
  }

  const gym = await Gym.create({
    name,
    slug,
    status: 'active',
    domains,
    database,
    owner: owner ? { firstName: owner.firstName, lastName: owner.lastName, email: owner.email, phone: owner.phone } : {},
    plan: plan ? plan._id : null,
    subscription,
    locale: {
      timezone: (input.locale && input.locale.timezone) || 'UTC',
      currency: String((input.locale && input.locale.currency) || 'USD').toUpperCase(),
      country: (input.locale && input.locale.country) || ''
    },
    notes: input.notes || '',
    createdBy
  });

  // The connection needs the uri, which the schema hides from reads.
  const gymForSeed = gym.toObject();
  gymForSeed.database = database;

  let seeded;
  try {
    seeded = await runWithTenant(gymForSeed, () => seedTenantDefaults({ gym: gymForSeed, owner, adoptExisting }));
    gym.provisionedAt = new Date();
    await gym.save();
    invalidateTenantCache();
  } catch (error) {
    // Roll back the record, and the database when it was this run that
    // brought it into being. One that existed before -- or whose existence
    // could not be checked -- is left alone: it may be somebody's data.
    await Gym.deleteOne({ _id: gym._id }).catch(() => {});
    if (databaseExistedBefore === false && !isProtectedDatabase(database.name)) {
      await dropTenantDatabase(gymForSeed).catch((dropError) => {
        console.error(`[platform] could not drop ${database.name} after a failed provisioning:`, dropError.message);
      });
    }
    throw new ProvisioningError(`Could not set up the gym's database: ${error.message}`, 500);
  }

  // Put every domain on the website host -- the ones typed in as well as the
  // platform subdomain, the same way editing them later does. Best effort:
  // the gym exists either way, and the warnings say what is left to do.
  warnings.push(...(await connectDomainsToWebsite(domains.map((d) => d.host), { platformHost: subdomain })));

  // Tell the owner. The password never travels: the email carries a link to
  // set one. A gym adopted from an existing deployment already has its owner
  // signed in, so it is not written to.
  const inviteSiteUrl = inviteSiteUrlFor(gymForSeed);
  let ownerInvite = { sent: false, skipped: adoptExisting ? 'existing gym' : 'no owner' };
  if (!adoptExisting && owner && owner.email) {
    try {
      const { sendOwnerInvite } = require('./ownerInvite');
      ownerInvite = await runWithTenant(gymForSeed, () => sendOwnerInvite({ gym: gymForSeed, email: owner.email, siteUrl: inviteSiteUrl }));
    } catch (error) {
      ownerInvite = { sent: false, error: error.message };
    }
    if (!ownerInvite.sent) warnings.push('Owner email could not be sent');
  }

  return { gym, seeded, siteUrl: seeded.siteUrl, inviteSiteUrl, warnings, ownerInvite };
}

/**
 * Adds hosts to the website's Vercel project and says, in words for the
 * panel, whatever still stands between each one and a working site: Vercel
 * not connected, a host it refused, a TXT record it wants first, the DNS
 * record a custom domain needs. Never throws.
 *
 * @param {string[]} hosts
 * @param {object} [options]
 * @param {string|null} [options.platformHost] the gym's <slug>.<root>: DNS for it is ours, not the owner's
 * @param {object} [options.vercel]            the vercelDomains module (tests pass a stand-in)
 * @returns {Promise<string[]>} warnings
 */
async function connectDomainsToWebsite(hosts, { platformHost = null, vercel = require('./vercelDomains') } = {}) {
  const warnings = [];
  // Local development hosts are never on Vercel.
  const remote = (hosts || []).filter((host) => host && !isInsecureHost(host));
  if (!remote.length) return warnings;

  if (!vercel.configured()) {
    const custom = remote.filter((host) => host !== platformHost);
    if (custom.length) {
      warnings.push(`The website host is not connected on the API (VERCEL_TOKEN / VERCEL_PROJECT_ID), so ${custom.join(', ')} ${custom.length === 1 ? 'was' : 'were'} not added to it. Add ${custom.length === 1 ? 'it' : 'them'} to the website's Vercel project by hand.`);
    }
    if (remote.includes(platformHost)) {
      warnings.push(`The website host is not connected on the API, so ${platformHost} was not added to it. It works only if the Vercel project has a wildcard domain for *.${platformHost.split('.').slice(1).join('.')}.`);
    }
    return warnings;
  }

  const describe = (result) => {
    if (!result) return;
    if (!result.added) {
      warnings.push(`${result.host} could not be added to the website host: ${result.error || result.skipped || 'unknown reason'}`);
    } else if (result.verified === false) {
      const records = (result.verification || []).map((v) => `${v.type} record ${v.domain} = ${v.value}`).join('; ');
      warnings.push(`${result.host} is on the website host but is not served until its ownership is verified${records ? ` -- add a ${records}` : ''}.`);
    }
  };

  for (const host of remote) {
    let result;
    try {
      result = await vercel.addDomain(host);
    } catch (error) {
      result = { host, added: false, error: error.message };
    }
    describe(result);
    describe(result.www);
    // A domain of the owner's own only works once its DNS points here, which
    // nobody has done yet on the day the gym is created.
    if (result.added && host !== platformHost && result.dns) {
      const twin = result.www && result.www.added ? ' (and a CNAME record for www pointing to cname.vercel-dns.com)' : '';
      warnings.push(`Point ${host} at the website: create a DNS ${result.dns.type} record for ${result.dns.name} pointing to ${result.dns.value}${twin}. Until then the site is not reachable there.`);
    }
  }
  return warnings;
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
    const withUri = await Gym.findByIdWithUri(gym._id);
    const target = withUri || gym;
    const name = (target.database && target.database.name) || databaseNameFor(gym.slug);
    if (!(target.database && target.database.uri) && isProtectedDatabase(name)) {
      throw new ProvisioningError(`"${name}" is the platform's main database and cannot be dropped. Remove the gym without dropping its database.`, 400);
    }
    await dropTenantDatabase(target);
  }
  await Gym.deleteOne({ _id: gym._id });
  invalidateTenantCache();
  return { deleted: true, databaseDropped: !!dropDatabase };
}

module.exports = {
  ProvisioningError,
  RESERVED_SLUGS,
  isReservedSlug,
  freeSlugFrom,
  uniqueDatabaseNameFor,
  validateDatabaseInput,
  localeSettingsFor,
  provisionGym,
  replaceDomains,
  deleteGym,
  seedTenantDefaults,
  connectDomainsToWebsite,
  normalizeDomains,
  assertDomainsAvailable,
  subscriptionFor,
  slugify
};
