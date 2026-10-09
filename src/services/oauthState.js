// src/services/oauthState.js
//
// The `state` that travels to Google and back during sign-in.
//
// It says which gym started the sign-in (Google answers to the API's own
// address, which names no gym) and where to send the person afterwards. It
// used to be plain JSON that anybody could write, and nothing tied the
// answer coming back to the browser that had asked. That allows a sign-in
// to be finished in somebody else's browser: an attacker starts one with
// their own Google account, stops before the last step, and gets a victim
// to open the final link -- who is then signed in to the attacker's account
// without knowing, and may put their own details and payments into it.
//
// Two things close that:
//
//   * the state is signed, so its gym and its return address are the ones
//     this server wrote;
//   * it carries a random value that is also left in the browser as a
//     cookie when the sign-in starts. Only the browser that started it has
//     the cookie, so only that browser can finish it.
//
// The state stays JSON with `tenant` in it, because the tenant resolver
// (platform/middleware/tenantFromPayload.js) reads that field to choose the
// gym's database before the callback runs. What it reads is checked here
// afterwards: a state whose gym was altered no longer matches its signature.
//
// The key is derived from JWT_SECRET under its own purpose label, as the
// unsubscribe links' is, so nothing signed here can stand in for anything
// else signed with that secret.

const crypto = require('crypto');

const PURPOSE = 'gympilot:google-oauth-state:v1';
const COOKIE_NAME = 'gp_oauth';
// Long enough to pick an account and type a password at Google.
const COOKIE_TTL_MS = 10 * 60 * 1000;

function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Cannot sign the sign-in state: set JWT_SECRET');
  return crypto.createHmac('sha256', secret).update(PURPOSE).digest();
}

function signature({ tenant, nonce, returnUrl, platformType }) {
  return crypto
    .createHmac('sha256', signingKey())
    .update(JSON.stringify([tenant || '', nonce || '', returnUrl || '', platformType || '']))
    .digest('base64url');
}

function sameText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/**
 * A new state for a sign-in started at `tenant` (the gym's slug).
 *
 * `state` comes back percent-encoded once, and is encoded once more when it
 * is put in the URL like any other query value. Both readers -- the tenant
 * resolver and verify() below -- decode what Express has already decoded
 * once, so a return address with a `%` in it reaches them intact.
 *
 * @returns {{ state: string, nonce: string }} `nonce` goes into the
 *   browser's cookie.
 */
function issue({ returnUrl = '/', platformType = '', tenant = null } = {}) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const data = { returnUrl: String(returnUrl || '/'), platformType: String(platformType || ''), tenant: tenant || null, nonce };
  return { state: encodeURIComponent(JSON.stringify({ ...data, sig: signature(data) })), nonce };
}

/**
 * What a state that came back says, or null when it is not one this server
 * wrote for this browser and this gym.
 *
 * @param {string} state        the query value, as Express handed it over
 * @param {string} cookieNonce  the value of the browser's COOKIE_NAME cookie
 * @param {string|null} tenant  the slug of the gym the request resolved to
 */
function verify(state, cookieNonce, tenant) {
  let data;
  try {
    data = JSON.parse(decodeURIComponent(String(state || '')));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || typeof data.nonce !== 'string' || typeof data.sig !== 'string') return null;
  if (!sameText(data.sig, signature(data))) return null;
  if (!sameText(data.nonce, cookieNonce)) return null;
  if ((data.tenant || null) !== (tenant || null)) return null;
  return { returnUrl: typeof data.returnUrl === 'string' ? data.returnUrl : '/', platformType: data.platformType || '', tenant: data.tenant || null };
}

/** The value of one cookie from a request, without a cookie parser. */
function readCookie(req, name = COOKIE_NAME) {
  const header = String((req && req.headers && req.headers.cookie) || '');
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

/**
 * How the cookie is set. Lax: Google sends the browser back with a
 * top-level navigation, which is exactly what Lax still carries a cookie
 * on, and nothing a page embeds or posts can. Only for the two sign-in
 * routes, and never readable by script.
 */
function cookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', secure: !!(req && req.protocol === 'https'), path: '/auth/google', maxAge: COOKIE_TTL_MS };
}

module.exports = { COOKIE_NAME, COOKIE_TTL_MS, issue, verify, readCookie, cookieOptions };
