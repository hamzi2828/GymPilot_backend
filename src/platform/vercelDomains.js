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

/** What the owner has to put in DNS for this host. */
function dnsAdvice(host) {
  const parts = String(host).split('.');
  const apex = parts.length <= 2;
  return apex
    ? { type: 'A', name: '@', value: '76.76.21.21', note: 'Point the root domain at Vercel with an A record.' }
    : { type: 'CNAME', name: parts[0], value: 'cname.vercel-dns.com', note: 'Point the subdomain at Vercel with a CNAME.' };
}

/**
 * Adds a host to the project. Resolves to a status object; never rejects.
 * { host, added, configured, verified, verification: [...], dns, error }
 */
async function addDomain(host) {
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

/** Removes a host from the project. Best effort. */
async function removeDomain(host) {
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

module.exports = { configured, addDomain, removeDomain, domainStatus, dnsAdvice };
