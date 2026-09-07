// src/platform/middleware/resolveTenant.js
//
// Turns "which website did this request come from" into "which gym's
// database it runs against", once per request, before any route sees it.
//
// Where the site is read from, in order:
//
//   1. X-Tenant-Host header    -- set by the Next.js server for server-side
//                                 renders, which carry no Origin
//   2. ?tenantHost= query       -- for top-level navigations (Google sign-in
//                                 redirects) and cache-keyed fetches
//   3. Origin header            -- every browser request from a gym's site;
//                                 set by the browser, not by page script
//   4. Host header              -- a gym whose domain points straight at the
//                                 API, or a same-origin proxy setup
//
// Each candidate is matched against the registered domains, then against
// `<slug>.PLATFORM_ROOT_DOMAIN`. Failing all that, an explicit slug
// (X-Tenant-Slug / ?tenant=) and finally DEFAULT_TENANT_SLUG are tried, which
// is what keeps a plain `localhost` development setup working with no
// headers at all.
//
// Reading the tenant from a header is safe because it only SELECTS a
// database. Nothing in that database is reachable without that gym's own
// JWT, and the JWT is bound to the gym it was issued by (see middleware/auth).

const { AsyncResource } = require('async_hooks');
const Gym = require('../models/gymModel');
const { getTenantConnection } = require('../connections');
const { storage, originForHost } = require('../tenantContext');

// Gym records change rarely and are read on every request, so lookups are
// cached briefly. The platform panel calls invalidate() after every change,
// so a suspension or a new domain lands on the next request rather than in
// half a minute.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // 'host:<host>' | 'slug:<slug>' -> { at, gym }

function cached(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.gym;
}

function remember(key, gym) {
  cache.set(key, { at: Date.now(), gym });
  return gym;
}

function invalidateTenantCache() {
  cache.clear();
}

async function gymByHost(host) {
  const normalized = Gym.normalizeHost(host);
  if (!normalized) return null;
  const hit = cached(`host:${normalized}`);
  if (hit !== undefined) return hit;
  return remember(`host:${normalized}`, await Gym.findByHost(normalized));
}

async function gymBySlug(slug) {
  const clean = String(slug || '').toLowerCase().trim();
  if (!clean || !Gym.SLUG_PATTERN.test(clean)) return null;
  const hit = cached(`slug:${clean}`);
  if (hit !== undefined) return hit;
  return remember(`slug:${clean}`, await Gym.findBySlug(clean));
}

function subdomainSlug(host) {
  const root = String(process.env.PLATFORM_ROOT_DOMAIN || '').toLowerCase().trim();
  if (!root || !host || !host.endsWith(`.${root}`)) return null;
  const label = host.slice(0, -(root.length + 1));
  return label && !label.includes('.') ? label : null;
}

function headerValue(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function queryValue(req, name) {
  const value = req.query && req.query[name];
  return Array.isArray(value) ? value[0] : value;
}

function uniqueHosts(values) {
  const seen = new Set();
  const hosts = [];
  for (const value of values) {
    const host = Gym.normalizeHost(value);
    if (host && host !== 'null' && !seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

// Hosts the caller named on purpose. When one of these matches nothing,
// the answer is "no such gym" -- never the default gym, which would quietly
// show one gym's site under another gym's domain.
function explicitHosts(req) {
  return uniqueHosts([headerValue(req, 'x-tenant-host'), queryValue(req, 'tenantHost')]);
}

// Hosts that arrive on every request whether or not anyone thought about
// them. These may fall through to DEFAULT_TENANT_SLUG, which is what keeps a
// single-gym server and a plain-localhost development setup working.
function ambientHosts(req) {
  return uniqueHosts([headerValue(req, 'origin'), headerValue(req, 'host')]);
}

function candidateHosts(req) {
  return uniqueHosts([...explicitHosts(req), ...ambientHosts(req)]);
}

/**
 * Finds the gym a request belongs to.
 *
 * @returns {Promise<{gym, host, source}|null>}  `host` is set only when the
 *   gym was matched by a registered domain or platform subdomain -- the only
 *   cases where it is safe to build links from it.
 */
async function resolveGymForRequest(req) {
  const hosts = candidateHosts(req);

  for (const host of hosts) {
    const gym = await gymByHost(host);
    if (gym) return { gym, host, source: 'domain' };
  }

  for (const host of hosts) {
    const slug = subdomainSlug(host);
    if (!slug) continue;
    const gym = await gymBySlug(slug);
    if (gym) return { gym, host, source: 'subdomain' };
  }

  const explicitSlug = headerValue(req, 'x-tenant-slug') || queryValue(req, 'tenant');
  if (explicitSlug) {
    const gym = await gymBySlug(explicitSlug);
    if (gym) return { gym, host: null, source: 'slug' };
  }

  // Something was named explicitly and none of it matched: that is a wrong
  // answer, not a missing one. Only requests that named nothing may fall
  // back to the default gym.
  if (explicitSlug || explicitHosts(req).length) return null;

  if (process.env.DEFAULT_TENANT_SLUG) {
    const gym = await gymBySlug(process.env.DEFAULT_TENANT_SLUG);
    if (gym) return { gym, host: null, source: 'default' };
  }

  return null;
}

/**
 * Re-enters the tenant context whenever the request or response emits.
 *
 * AsyncLocalStorage follows promises and timers, but not events on a socket
 * that was created before the context existed. Body parsers that run after
 * this middleware (multer on upload routes, express.raw on the webhook) read
 * the request as a stream and call next() from a 'data'/'end' listener --
 * which would otherwise run with no tenant and fail on the first model call.
 */
function bindEmitters(req, res) {
  const resource = new AsyncResource('gympilot.tenantRequest');
  for (const emitter of [req, res]) {
    const emit = emitter.emit;
    emitter.emit = function boundEmit(...args) {
      return resource.runInAsyncScope(emit, emitter, ...args);
    };
  }
}

async function resolveTenant(req, res, next) {
  try {
    const resolved = await resolveGymForRequest(req);
    if (!resolved) {
      return res.status(404).json({
        success: false,
        code: 'TENANT_NOT_FOUND',
        message: 'No gym is connected to this domain.',
        host: candidateHosts(req)[0] || null
      });
    }

    const { gym, host, source } = resolved;

    const blocked = Gym.accessBlock(gym);
    if (blocked) {
      return res.status(blocked.status).json({ success: false, code: blocked.code, message: blocked.message });
    }

    const connection = await getTenantConnection(gym);

    req.tenant = gym;
    req.tenantConnection = connection;
    req.tenantHost = host;
    req.tenantSource = source;

    const store = {
      gym,
      connection,
      host,
      origin: host ? originForHost(host) : null,
      source
    };

    return storage.run(store, () => {
      bindEmitters(req, res);
      next();
    });
  } catch (error) {
    console.error('[tenant] resolution failed:', error);
    return res.status(500).json({ success: false, message: 'Could not resolve the gym for this request' });
  }
}

/**
 * Whether a browser Origin belongs to a registered gym (or a platform
 * subdomain). Used by the CORS check in index.js.
 */
async function isRegisteredOrigin(origin) {
  const host = Gym.normalizeHost(origin);
  if (!host) return false;
  if (await gymByHost(host)) return true;
  const slug = subdomainSlug(host);
  return !!(slug && (await gymBySlug(slug)));
}

/**
 * For handlers that receive requests carrying no site at all -- Stripe's
 * webhook, Google's OAuth callback -- and learn the gym from the payload
 * instead. Returns the gym (blocked gyms included, so the caller decides) or
 * null.
 */
async function findGymBySlug(slug) {
  return gymBySlug(slug);
}

module.exports = {
  resolveTenant,
  resolveGymForRequest,
  findGymBySlug,
  isRegisteredOrigin,
  invalidateTenantCache,
  candidateHosts
};
