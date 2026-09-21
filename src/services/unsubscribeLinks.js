// src/services/unsubscribeLinks.js
//
// The unsubscribe link at the foot of a newsletter email. It carries a
// signature of the address and the gym, and POST /api/newsletter/unsubscribe
// wants it back: without it anyone could take anyone off the list by typing
// their email into the page, and a link from one gym's email does nothing at
// another gym.
//
// The key is derived from JWT_SECRET under its own purpose label rather than
// being JWT_SECRET itself, so nothing signed here can stand in for anything
// else signed with that secret. The links do not expire: an unsubscribe link
// has to keep working for as long as the email sits in somebody's inbox.

const crypto = require('crypto');
const { currentTenantId } = require('../platform/tenantContext');

const PURPOSE = 'gympilot:newsletter-unsubscribe:v1';
const TOKEN_LENGTH = 32;

function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Cannot sign unsubscribe links: set JWT_SECRET');
  return crypto.createHmac('sha256', secret).update(PURPOSE).digest();
}

function normaliseEmail(email) {
  return String(email || '').toLowerCase().trim();
}

/** The token for this address at this gym (the gym in context by default). */
function unsubscribeToken(email, tenantId = currentTenantId()) {
  return crypto
    .createHmac('sha256', signingKey())
    .update(`${tenantId || ''}|${normaliseEmail(email)}`)
    .digest('base64url')
    .slice(0, TOKEN_LENGTH);
}

/** Whether `token` is the one issued for this address at this gym. */
function verifyUnsubscribeToken(email, token, tenantId = currentTenantId()) {
  if (!normaliseEmail(email) || typeof token !== 'string' || !token.trim()) return false;
  const expected = Buffer.from(unsubscribeToken(email, tenantId));
  const given = Buffer.from(token.trim());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** The full link for the email footer: `<site>/unsubscribe?email=…&token=…`. */
function unsubscribeUrl(siteOrigin, email, tenantId = currentTenantId()) {
  const params = new URLSearchParams({ email: normaliseEmail(email), token: unsubscribeToken(email, tenantId) });
  return `${String(siteOrigin || '').replace(/\/+$/, '')}/unsubscribe?${params.toString()}`;
}

module.exports = { unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl };
