// src/platform/vercelDomains.js
//
// Adds a gym's domain to the website's Vercel project so the site answers
// on it without anyone opening the Vercel dashboard. Optional: it does
// nothing unless VERCEL_TOKEN and VERCEL_PROJECT_ID are set, and a failure
// never stops the domain being saved on the gym -- the panel shows what
// happened and what DNS record the gym's owner has to create.
//
//   VERCEL_TOKEN       a token with access to the project
//   VERCEL_PROJECT_ID  the frontend project (prj_...) or its name
//   VERCEL_TEAM_ID     when the project belongs to a team (optional)

const API = 'https://api.vercel.com';
const TIMEOUT_MS = 15000;

function configured() {
  return !!(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID);
}

function teamQuery() {
  return process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : '';
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}${teamQuery()}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// Public suffixes that take two labels, so "ironworks.com.pk" is a root
// domain just as "ironworks.com" is. Not the whole public suffix list --
// the ones gyms here actually register under.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.pk', 'org.pk', 'net.pk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za',
  'co.in', 'net.in', 'org.in', 'com.sa', 'com.qa', 'com.bh', 'com.kw', 'com.om', 'com.eg',
  'com.tr', 'com.ng', 'co.ke', 'com.my', 'com.sg', 'com.ph', 'com.bd', 'com.br', 'com.mx', 'co.jp'
]);

/** Where the registrable domain starts: 2 labels from the end, or 3 under a two-label suffix. */
function rootLabels(parts) {
  return parts.length >= 3 && TWO_LABEL_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
}

/** "ironworks.com" or "ironworks.co.uk" -- not "app.ironworks.com", not "localhost:3000". */
function isApex(host) {
  const clean = String(host || '').toLowerCase().trim();
  if (!clean || clean.includes(':') || /^[\d.]+$/.test(clean)) return false;
  const parts = clean.split('.');
  return parts.length >= 2 && parts.length === rootLabels(parts);
}

/** What the owner has to put in DNS for this host. */
function dnsAdvice(host) {
  const parts = String(host).split('.');
  return isApex(host)
    ? { type: 'A', name: '@', value: '76.76.21.21', note: 'Point the root domain at Vercel with an A record.' }
    : { type: 'CNAME', name: parts.slice(0, Math.max(1, parts.length - rootLabels(parts))).join('.'), value: 'cname.vercel-dns.com', note: 'Point the subdomain at Vercel with a CNAME.' };
}

/**
 * The www twin a root domain needs on the project too. Gyms store hosts
 * without www (gymModel.normalizeHost strips it, and the API matches
 * www.ironworks.com to ironworks.com by itself), but Vercel only serves the
 * names it has been given -- so without this, whoever types the www address
 * gets Vercel's 404.
 */
function wwwTwinOf(host) {
  return isApex(host) ? `www.${String(host).toLowerCase().trim()}` : null;
}

/**
 * Adds a host to the project -- a root domain together with its www twin
 * (reported under `www`). Resolves to a status object; never rejects.
 * { host, added, verified, verification: [...], dns, error, www? }
 *
 * `added` with `verified: false` means Vercel has the host but will not
 * serve it until the TXT record in `verification` exists.
 */
async function addDomain(host) {
  const result = await addOne(host);
  const twin = wwwTwinOf(result.host);
  if (twin && !result.skipped) result.www = await addOne(twin);
  return result;
}

async function addOne(host) {
  const clean = String(host || '').toLowerCase().trim();
  if (!configured()) return { host: clean, added: false, skipped: 'Vercel is not connected (VERCEL_TOKEN / VERCEL_PROJECT_ID)', dns: dnsAdvice(clean) };
  try {
    const project = encodeURIComponent(process.env.VERCEL_PROJECT_ID);
    let r = await call('POST', `/v10/projects/${project}/domains`, { name: clean });
    if (!r.ok && r.json && r.json.error && r.json.error.code === 'domain_already_in_use') {
      // Already on this project: fine, read its state.
      r = await call('GET', `/v9/projects/${project}/domains/${encodeURIComponent(clean)}`);
    }
    if (!r.ok) {
      return { host: clean, added: false, error: (r.json && r.json.error && r.json.error.message) || `Vercel answered ${r.status}`, dns: dnsAdvice(clean) };
    }
    const d = r.json || {};
    return {
      host: clean,
      added: true,
      verified: d.verified !== false,
      // Present when Vercel wants a TXT record before it will serve the host.
      verification: Array.isArray(d.verification) ? d.verification.map((v) => ({ type: v.type, domain: v.domain, value: v.value })) : [],
      dns: dnsAdvice(clean)
    };
  } catch (error) {
    return { host: clean, added: false, error: error.message, dns: dnsAdvice(clean) };
  }
}

/** Removes a host from the project, and a root domain's www twin with it. Best effort. */
async function removeDomain(host) {
  const result = await removeOne(host);
  const twin = wwwTwinOf(result.host);
  // A twin that was never added answers 404, which counts as removed.
  if (twin && configured()) result.www = await removeOne(twin);
  return result;
}

async function removeOne(host) {
  const clean = String(host || '').toLowerCase().trim();
  if (!configured() || !clean) return { host: clean, removed: false };
  try {
    const r = await call('DELETE', `/v9/projects/${encodeURIComponent(process.env.VERCEL_PROJECT_ID)}/domains/${encodeURIComponent(clean)}`);
    return { host: clean, removed: r.ok || r.status === 404 };
  } catch (error) {
    return { host: clean, removed: false, error: error.message };
  }
}

/** Current state of a host on the project: is DNS pointing here yet? */
async function domainStatus(host) {
  const clean = String(host || '').toLowerCase().trim();
  if (!configured()) return { host: clean, connected: false, skipped: 'Vercel is not connected', dns: dnsAdvice(clean) };
  try {
    const project = encodeURIComponent(process.env.VERCEL_PROJECT_ID);
    const [domain, config] = await Promise.all([
      call('GET', `/v9/projects/${project}/domains/${encodeURIComponent(clean)}`),
      call('GET', `/v6/domains/${encodeURIComponent(clean)}/config`)
    ]);
    if (!domain.ok) return { host: clean, connected: false, on_project: false, dns: dnsAdvice(clean) };
    return {
      host: clean,
      connected: true,
      on_project: true,
      verified: domain.json.verified !== false,
      misconfigured: !!(config.ok && config.json && config.json.misconfigured),
      verification: Array.isArray(domain.json.verification) ? domain.json.verification.map((v) => ({ type: v.type, domain: v.domain, value: v.value })) : [],
      dns: dnsAdvice(clean)
    };
  } catch (error) {
    return { host: clean, connected: false, error: error.message, dns: dnsAdvice(clean) };
  }
}

module.exports = { configured, addDomain, removeDomain, domainStatus, dnsAdvice, isApex, wwwTwinOf };
