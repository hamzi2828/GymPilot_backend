// test/integration/helpers/harness.js
//
// A real MongoDB for the integration suite: an in-memory mongod
// (mongodb-memory-server), the platform database and one database per test
// gym on it, and the outside world (email, notifications, Stripe, Vercel)
// replaced by stand-ins that record what they were asked to do.
//
// The order of events is the whole point of this file:
//
//   1. On load -- before any application module can be required -- MONGO_URI
//      is pointed at a port nothing listens on and every variable that could
//      reach a real service is removed. .env is never read (only index.js
//      loads dotenv, and the tests never require index.js).
//   2. start() boots the in-memory server, points MONGO_URI at IT, connects,
//      and installs the stubs. Application modules are required only after
//      that, through h.src(), so the ones that destructure (e.g.
//      `const { sendEmail } = require(...)`) pick up the stand-ins.
//
// Every test file is its own process under `node --test`, so each gets its
// own server and nothing leaks between files.
//
// When the server cannot start (no binary and no network to download one)
// every test is skipped with the reason -- unless
// GYMPILOT_INTEGRATION_REQUIRED=1, in which case that is a failure.

'use strict';

const path = require('path');
const nodeTest = require('node:test');
const { tolerateStopStall } = require('./mongoTeardown');

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

const PLATFORM_DB = 'gpit_platform';
const TENANT_PREFIX = 'gpit_';

// ---------------------------------------------------------------------------
// 1. Environment -- synchronously, at require time.
// ---------------------------------------------------------------------------

// Never a real database: a closed port until start() has a server to offer.
process.env.MONGO_URI = 'mongodb://127.0.0.1:9/__gympilot_integration_not_started__';
process.env.PLATFORM_DB_NAME = PLATFORM_DB;
process.env.TENANT_DB_PREFIX = TENANT_PREFIX;
process.env.JWT_SECRET = 'gympilot-integration-jwt-secret';
process.env.SETTINGS_ENCRYPTION_KEY = 'gympilot-integration-settings-key';
process.env.PLATFORM_JWT_SECRET = 'gympilot-integration-platform-secret';
process.env.QR_TOKEN_SECRET = 'gympilot-integration-qr-secret';
process.env.NODE_ENV = 'test';

// Anything that could reach a real service, or change a default the tests
// rely on, is removed -- whatever the shell running the tests has exported.
const SCRUBBED = [
  'VERCEL', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY',
  'EXPO_ACCESS_TOKEN', 'BLOB_READ_WRITE_TOKEN',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
  'FRONTEND_ORIGIN', 'PLATFORM_ROOT_DOMAIN', 'PLATFORM_ADMIN_ORIGIN', 'GYMFOLIO_URL',
  'DEFAULT_TENANT_SLUG', 'LEGACY_KEY_TENANT_SLUG', 'ALLOW_DEDICATED_DB_URI',
  'SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_PASSWORD', 'PLATFORM_CONTACT_EMAIL',
  'ACCOUNTS_CURRENCY', 'SUBSCRIPTION_GRACE_DAYS', 'MEMBERSHIP_REMINDER_DAYS',
  'ATTENDANCE_TIMEZONE', 'ATTENDANCE_OPEN_VISIT_HOURS', 'ATTENDANCE_MIN_PUNCH_GAP_SECONDS',
  'ATTENDANCE_LATE_GRACE_MINUTES', 'ATTENDANCE_EXPIRY_WARNING_DAYS',
  'ATTENDANCE_STAFF_SHIFT_GRACE_HOURS', 'ATTENDANCE_STAFF_OPEN_HOURS',
  'FINGERPRINT_FAR', 'FINGERPRINT_ENCRYPTION_KEY', 'OWNER_INVITE_TTL_HOURS',
  'SAFEPAY_API_BASE_URL', 'SAFEPAY_CHECKOUT_BASE_URL'
];
for (const key of SCRUBBED) delete process.env[key];

// ---------------------------------------------------------------------------
// 2. The server, the connection and the stand-ins.
// ---------------------------------------------------------------------------

const state = {
  started: false,
  skipReason: null,
  server: null,
  mongoose: null,
  // What getStripe() returns while a test has installed a fake (setStripe).
  stripeFake: null,
  // The error every email send reports while a test has made email fail
  // (setEmailFailure); null: sends succeed.
  emailFailure: null
};

// What the stand-ins were asked to do, for assertions.
const calls = {
  emails: [],
  notifications: [],
  stripe: []
};

function src(relative) {
  if (!state.started) throw new Error(`[integration] h.src('${relative}') before start()`);
  return require(path.join(SRC, relative));
}

function installStubs() {
  // Email: recorded, never sent. Installed before anything that destructures
  // sendEmail (ownerInvite, gymNotifications, ...) is loaded.
  const email = require(path.join(SRC, 'services', 'emailService'));
  email.sendEmail = async (to, subject, html) => {
    calls.emails.push({ to, subject, html });
    if (state.emailFailure) return { success: false, error: state.emailFailure };
    return { success: true, messageId: `stub-${calls.emails.length}` };
  };
  email.verifyConnection = async () => ({ ok: true });

  // Member notifications (email + push): recorded, never delivered. Callers
  // use `notify.bookingCreated(...)`, so replacing the exports is enough.
  const notify = require(path.join(SRC, 'services', 'gymNotifications'));
  for (const name of Object.keys(notify)) {
    if (typeof notify[name] !== 'function') continue;
    notify[name] = async (...args) => {
      calls.notifications.push({ name, args });
      return null;
    };
  }

  // A gym's Stripe: no network. A test that needs Stripe installs its own
  // fake with setStripe(); without one, reaching Stripe is an error.
  const stripeClient = require(path.join(SRC, 'services', 'stripeClient'));
  stripeClient.getStripe = async () => {
    calls.stripe.push({ name: 'getStripe' });
    if (state.stripeFake) return state.stripeFake;
    throw new Error('[integration] Stripe is stubbed out: this path should not reach Stripe');
  };

  // The website host (Vercel): never configured, never called.
  const vercel = require(path.join(SRC, 'platform', 'vercelDomains'));
  vercel.configured = () => false;
  vercel.addDomain = async (host) => ({ host, added: false, skipped: 'stubbed in integration tests' });
}

async function start() {
  if (state.started || state.skipReason) return state;

  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch (error) {
    return unavailable(`mongodb-memory-server is not installed (${error.message}). Run npm install.`);
  }

  try {
    state.server = await MongoMemoryServer.create();
  } catch (error) {
    return unavailable(`the in-memory MongoDB could not start (${error.message}). It needs its binary, downloaded once to ~/.cache/mongodb-binaries.`);
  }
  // A watchdog slow to exit at the end must not fail a file (mongoTeardown.js).
  tolerateStopStall(state.server);

  const base = state.server.getUri(); // mongodb://127.0.0.1:<port>/
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    await state.server.stop();
    throw new Error(`[integration] refusing to run against a non-local server: ${base}`);
  }
  process.env.MONGO_URI = `${base.replace(/\/?$/, '/')}${PLATFORM_DB}`;

  const mongoose = require('mongoose');
  state.mongoose = mongoose;
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

  installStubs();
  state.started = true;
  return state;
}

function unavailable(reason) {
  if (process.env.GYMPILOT_INTEGRATION_REQUIRED === '1') throw new Error(`[integration] ${reason}`);
  state.skipReason = reason;
  console.warn(`[integration] skipping: ${reason}`);
  return state;
}

async function stop() {
  const mongoose = state.mongoose;
  // Let fire-and-forget work queued by the last test (audit log writes,
  // directory publishes) land before the connection goes away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (state.server) await state.server.stop({ doCleanup: true, force: true }).catch(() => {});
  state.started = false;
}

/**
 * Registers the start/stop hooks for a test file -- and `setup`, run once the
 * server is up -- and returns `test`, wrapped so every test skips (with the
 * reason) when there is no server.
 */
function suite(setup = null) {
  nodeTest.before(async () => {
    await start();
    if (state.started && setup) await setup();
  });
  nodeTest.after(stop);
  const wrapped = (name, options, fn) => {
    if (typeof options === 'function') {
      fn = options;
      options = {};
    }
    return nodeTest(name, options, async (t) => {
      if (state.skipReason) return t.skip(state.skipReason);
      return fn(t);
    });
  };
  return wrapped;
}

// ---------------------------------------------------------------------------
// 3. Gyms and tenant context.
// ---------------------------------------------------------------------------

/**
 * A platform Gym record plus its own database with a Settings row in it.
 * Returns the gym as a plain object, with `database` filled in, ready for
 * runWithTenant().
 */
async function createGym(slug, { name, timezone = 'UTC', currency = 'GBP', settings = {} } = {}) {
  const Gym = src('platform/models/gymModel');
  const { runWithTenant } = src('platform/tenantContext');

  const database = { name: `${TENANT_PREFIX}${slug.replace(/-/g, '_')}` };
  const doc = await Gym.create({
    name: name || `Gym ${slug}`,
    slug,
    status: 'active',
    domains: [{ host: `${slug}.test`, isPrimary: true }],
    database,
    locale: { timezone, currency, country: 'GB' },
    subscription: { status: 'active', currency }
  });
  const gym = doc.toObject();
  gym.database = database;

  await runWithTenant(gym, async () => {
    const Settings = src('models/settings');
    await Settings.create({ siteName: gym.name, siteUrl: `https://${slug}.test`, currency, isActive: true, ...settings });
  });
  return gym;
}

function inGym(gym, fn) {
  return src('platform/tenantContext').runWithTenant(gym, fn);
}

/** Waits for the named tenant models' collections and indexes to exist on the current gym. */
async function ensureIndexes(...models) {
  for (const Model of models) await Model.init();
}

/** The raw driver database, bypassing every model and proxy. */
function rawDb(name) {
  return state.mongoose.connection.getClient().db(name);
}

async function databaseNames() {
  const { databases } = await state.mongoose.connection.getClient().db().admin().listDatabases({ nameOnly: true });
  return databases.map((d) => d.name);
}

// ---------------------------------------------------------------------------
// 4. Calling controllers without HTTP.
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.send = (body) => {
    res.body = body;
    return res;
  };
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
  };
  res.set = res.setHeader;
  return res;
}

/** Runs an Express handler with a plain request object; resolves the response. */
async function call(handler, req = {}) {
  const headers = req.headers || {};
  const request = {
    query: {},
    params: {},
    body: {},
    get: (name) => headers[String(name).toLowerCase()],
    ...req,
    headers
  };
  const res = fakeRes();
  await handler(request, res);
  return res;
}

// ---------------------------------------------------------------------------
// 5. Time.
// ---------------------------------------------------------------------------

/**
 * An IANA zone in which it is currently between 12:00 and 13:00, so tests
 * about "today", rosters and booking cut-offs never run into midnight
 * whenever the suite happens to be run.
 */
function middayZone(now = new Date()) {
  const offset = 12 - now.getUTCHours(); // -11 .. +12
  if (offset === 0) return 'Etc/UTC';
  // Etc/GMT signs are inverted: Etc/GMT-3 is UTC+3.
  return `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

function minutesAgo(minutes, from = new Date()) {
  return new Date(from.getTime() - minutes * 60000);
}

/** What getStripe() hands back from now on (null: reaching Stripe throws). */
function setStripe(fake) {
  state.stripeFake = fake || null;
}

/** Every email send fails with `error` from now on (null: sends succeed again). */
function setEmailFailure(error) {
  state.emailFailure = error || null;
}

module.exports = {
  PLATFORM_DB,
  TENANT_PREFIX,
  state,
  calls,
  src,
  start,
  stop,
  suite,
  createGym,
  inGym,
  ensureIndexes,
  rawDb,
  databaseNames,
  fakeRes,
  call,
  middayZone,
  minutesAgo,
  setStripe,
  setEmailFailure
};
