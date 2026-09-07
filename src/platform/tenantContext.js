// src/platform/tenantContext.js
//
// "Which gym is this for" travels with the work rather than with the code.
//
// Every gym has its own database, so every model read or write has to know
// which one to talk to. Passing a connection through every function argument
// would touch every controller and service in the codebase; instead the
// resolved tenant is stored in an AsyncLocalStorage context that follows the
// request through every await, callback and promise it spawns. The models
// (see modelRegistry.js) read it back when they are used.
//
// There are exactly three ways into a context:
//
//   * resolveTenant middleware  -- one HTTP request, one gym (the normal path)
//   * runWithTenant(gym, fn)    -- a job or a webhook acting for one gym
//   * enterContext(context)     -- a one-off script, for the rest of its run
//
// Outside of these, using a tenant model throws rather than silently reading
// the wrong database.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// Hosts that can only be reached over plain HTTP. Everything else a gym
// registers is assumed to be served over HTTPS -- the platform does not run
// production sites without it.
function isInsecureHost(host) {
  const h = String(host || '').toLowerCase();
  return (
    h === 'localhost' ||
    h.startsWith('localhost:') ||
    h.startsWith('127.0.0.1') ||
    h.startsWith('0.0.0.0') ||
    h.endsWith('.local') ||
    h.endsWith('.test') ||
    h.endsWith('.localhost')
  );
}

function originForHost(host) {
  if (!host) return null;
  return `${isInsecureHost(host) ? 'http' : 'https'}://${host}`;
}

function primaryHost(gym) {
  const domains = (gym && gym.domains) || [];
  const primary = domains.find((d) => d && d.isPrimary && d.host) || domains.find((d) => d && d.host);
  return primary ? primary.host : null;
}

async function toContext(store) {
  if (store && store.connection && store.gym) return store;
  // Lazy require: connections.js requires modelRegistry.js which requires
  // this file.
  const { getTenantConnection } = require('./connections');
  const gym = store && store.gym ? store.gym : store;
  if (!gym || !gym.slug) throw new Error('[tenant] runWithTenant needs a gym document');
  const connection = await getTenantConnection(gym);
  return {
    gym,
    connection,
    host: (store && store.host) || null,
    origin: (store && store.origin) || null,
    source: (store && store.source) || 'explicit'
  };
}

/**
 * Runs `fn` with `store` as the active tenant context.
 *
 * `store` is either a full context ({ gym, connection, host, origin }) or a
 * bare gym document, in which case the connection is opened here.
 */
async function runWithTenant(store, fn) {
  const context = await toContext(store);
  return storage.run(context, fn);
}

/** Opens the gym's connection and returns a context for enterContext(). */
function tenantContextFor(store) {
  return toContext(store);
}

/**
 * Enters a tenant context for the remainder of the current async execution.
 *
 * Synchronous on purpose. AsyncLocalStorage's enterWith() applies to the
 * async function it is called from and everything that function goes on to
 * await -- but NOT to a caller awaiting that function. So a script must call
 * this itself, in its own main:
 *
 *     enterContext(await tenantContextFor(gym));
 *
 * and from that line on, every model call in that main runs against the gym.
 */
function enterContext(context) {
  storage.enterWith(context);
  return context;
}

function currentStore() {
  return storage.getStore() || null;
}

function currentTenant() {
  const store = currentStore();
  return store ? store.gym : null;
}

function currentConnection() {
  const store = currentStore();
  return store ? store.connection : null;
}

function requireTenant() {
  const gym = currentTenant();
  if (!gym) throw new Error('[tenant] No gym in context');
  return gym;
}

/** A stable key for per-tenant caches. Never collides with a real gym id. */
function tenantKey() {
  const gym = currentTenant();
  return gym ? String(gym._id) : '__no_tenant__';
}

function currentTenantId() {
  const gym = currentTenant();
  return gym ? String(gym._id) : null;
}

function currentTenantSlug() {
  const gym = currentTenant();
  return gym ? gym.slug : null;
}

/**
 * The website address links and redirects should point at, for the gym in
 * context.
 *
 * Only ever built from a REGISTERED domain -- the one the request matched, or
 * the gym's primary one -- never from a raw request header. A password-reset
 * email whose link came from an attacker-supplied Origin header would hand
 * them the token, so headers are used to pick the gym and nothing else.
 */
function frontendOrigin() {
  const store = currentStore();
  if (store && store.origin) return store.origin;

  const gym = store && store.gym;
  const envOrigin = (process.env.FRONTEND_ORIGIN || '').replace(/\/+$/, '');

  // The gym a bare deployment defaults to keeps answering with the env value
  // it always used, so a single-gym install behaves exactly as before the
  // platform existed -- in development (localhost) as much as in production.
  if (gym && envOrigin && process.env.DEFAULT_TENANT_SLUG && gym.slug === process.env.DEFAULT_TENANT_SLUG) {
    return envOrigin;
  }

  const primary = primaryHost(gym);
  if (primary) return originForHost(primary);
  return envOrigin || 'http://localhost:3000';
}

/**
 * The gym's IANA timezone. Falls back to the env value the single-gym
 * deployment used, so an unregistered context keeps its old behaviour.
 */
function tenantTimezone() {
  const gym = currentTenant();
  const tz = gym && gym.locale && gym.locale.timezone;
  return tz || process.env.ATTENDANCE_TIMEZONE || 'Asia/Karachi';
}

module.exports = {
  storage,
  runWithTenant,
  tenantContextFor,
  enterContext,
  currentStore,
  currentTenant,
  currentConnection,
  requireTenant,
  tenantKey,
  currentTenantId,
  currentTenantSlug,
  frontendOrigin,
  tenantTimezone,
  originForHost,
  primaryHost,
  isInsecureHost
};
