// src/services/billing/payLinks.js
//
// The payment link a member is sent for one unpaid order:
//
//   <gym site>/pay/GPP1.<order id>.<expiry unix seconds>.<signature>
//
// No sign-in: the link is the key, and it opens exactly one order -- the
// page shows that order (gym, first name, package, amount, dates) and can
// start a checkout for it, nothing else. It is signed with the server
// secret (QR_TOKEN_SECRET, falling back to JWT_SECRET, as the desk codes
// are) over the gym, the order and the expiry, so it cannot be made up,
// pointed at another order, carried to another gym or kept alive longer.
// It expires a week after the order's last day to pay (metadata.lastDay;
// an order without one -- an ad-hoc link staff sent -- a week from today).
//
// The same order always gets the same link while its dates stand, so every
// reminder carries one address. Changing the secret ends every link sent.

const crypto = require('crypto');
const T = require('../../attendance/services/timeUtils');
const { currentTenantId, currentTenant, siteUrlFor } = require('../../platform/tenantContext');
const { metadataOf, linkLastDay, isDueRenewal, isOpen } = require('./dueRenewals');

const VERSION = 'GPP1';
const SIGNATURE_LENGTH = 24;
const PAY_PATH = '/pay';
const FORMAT = /^GPP1\.([0-9a-fA-F]{24})\.(\d{1,12})\.([A-Za-z0-9_-]{24})$/;

function secret() {
  const value = process.env.QR_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error('Cannot sign payment links: set QR_TOKEN_SECRET (or JWT_SECRET)');
  return value;
}

function signature(tenantId, orderId, exp) {
  return crypto
    .createHmac('sha256', secret())
    .update(['pay-link', tenantId, orderId, exp].join('|'))
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

/** When an order's link stops working: the end of the gym's day, a week after its last day to pay. */
function linkExpiry(order, now = new Date()) {
  const lastDay = metadataOf(order, 'lastDay') || T.dateKey(now);
  return T.lastMomentOfLocalDay(linkLastDay(lastDay));
}

/** The link for an order, in the gym in context: { token, url, expiresAt }. */
function issuePayLink(order, now = new Date()) {
  const expiresAt = linkExpiry(order, now);
  const exp = String(Math.floor(expiresAt.getTime() / 1000));
  const id = String(order._id).toLowerCase();
  const token = `${VERSION}.${id}.${exp}.${signature(currentTenantId() || '', id, exp)}`;
  return { token, url: payUrl(token), expiresAt: new Date(Number(exp) * 1000) };
}

/**
 * The gym site's page for a token, on the gym's PRIMARY domain from its
 * platform record (tenantContext.siteUrlFor, as the platform's own emailed
 * links are built) -- never Settings.siteUrl, and never whichever of its
 * hosts a request happened to arrive on, so a link is the same however it
 * was made.
 */
function payUrl(token) {
  return `${siteUrlFor(currentTenant())}${PAY_PATH}/${token}`;
}

/**
 * Reads a token in the gym in context:
 *   { ok: true, orderId, expiresAt }                   signed here, still good
 *   { ok: false, reason: 'invalid' }                   not a token, tampered with, or another gym's
 *   { ok: false, reason: 'expired', orderId, expiresAt } genuine, but past its week
 * The signature is checked before the time, so only a link this gym really
 * issued is ever called expired.
 */
function verifyPayToken(input, now = Date.now()) {
  const match = FORMAT.exec(String(input || '').trim().slice(0, 200));
  if (!match) return { ok: false, reason: 'invalid' };
  const [, rawId, expText, sig] = match;
  const orderId = rawId.toLowerCase();

  let expected;
  try {
    expected = Buffer.from(signature(currentTenantId() || '', orderId, expText));
  } catch {
    // No secret: nothing can have been issued, so nothing verifies.
    return { ok: false, reason: 'invalid' };
  }
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };

  const expiresAt = new Date(Number(expText) * 1000);
  if (expiresAt.getTime() < now) return { ok: false, reason: 'expired', orderId, expiresAt };
  return { ok: true, orderId, expiresAt };
}

/**
 * The link the member's own order list shows as "Pay now": on a renewal
 * still waiting to be paid by payment link, while its link works; null on
 * every other order. A declined automatic charge leaves the order open
 * (payment 'failed', status 'pending'), so the link stays.
 */
function payLinkUrlFor(order, now = new Date()) {
  if (!order || !isOpen(order)) return null;
  // A renewal sent by link, or an order whose transfer receipt came through one.
  if (!isDueRenewal(order) && metadataOf(order, 'proofVia') !== 'pay_link') return null;
  const link = issuePayLink(order, now);
  return link.expiresAt.getTime() > now.getTime() ? link.url : null;
}

/** Orders as the API sends them, each with its `pay_link_url` (null when it has none). */
function withPayLinks(orders, now = new Date()) {
  return (orders || []).map((order) => {
    const plain = order && typeof order.toJSON === 'function' ? order.toJSON() : order;
    return { ...plain, pay_link_url: payLinkUrlFor(order, now) };
  });
}

module.exports = { VERSION, PAY_PATH, issuePayLink, payUrl, verifyPayToken, linkExpiry, payLinkUrlFor, withPayLinks };
