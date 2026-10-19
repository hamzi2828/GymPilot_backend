// src/attendance/services/deskCode.js
//
// The rotating code a front-desk screen shows for members to scan with their
// own phone. The Windows desk app and the web kiosk both ask for a fresh one
// every REFRESH_AFTER_SECONDS (POST /api/desktop/checkin-code) and draw it as
// a QR code; the member's signed-in phone sends it back with
// POST /api/attendance/me/checkin, and the visit is recorded at that desk.
//
//   GPD1.<desk token id>.<expiry unix seconds>.<signature>
//
// It names the desk, never a person: the person is whoever is signed in on the
// phone that scanned it. It is signed with the server secret and tied to the
// gym and to the one desk token it was issued for, so it cannot be made up,
// carried to another gym, or moved to another desk. It is good for a minute,
// so a photo of the screen sent to a friend at home is stale almost at once.

const crypto = require('crypto');
const { currentTenantId } = require('../../platform/tenantContext');

const VERSION = 'GPD1';
const VALID_SECONDS = 60;
// A code scanned in its last moments still has to reach the server: the
// phone's clock, the network and the screen's refresh all take a little.
const GRACE_SECONDS = 5;
const REFRESH_AFTER_SECONDS = 20;
const SIGNATURE_LENGTH = 24;
// The website page a phone's ordinary camera opens: <gym site>/checkin?c=<code>.
const CHECKIN_PATH = '/checkin';

const FORMAT = /^GPD1\.([0-9a-fA-F]{24})\.(\d{1,12})\.([A-Za-z0-9_-]{24})$/;

function secret() {
  const value = process.env.QR_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error('Cannot sign desk codes: set QR_TOKEN_SECRET (or JWT_SECRET)');
  return value;
}

function signature(tenantId, deskTokenId, exp) {
  return crypto
    .createHmac('sha256', secret())
    .update(['desk-code', tenantId, deskTokenId, exp].join('|'))
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

/** A fresh code for this desk token, in the gym in context. */
function issueDeskCode(deskTokenId, now = Date.now()) {
  const exp = Math.floor(now / 1000) + VALID_SECONDS;
  const id = String(deskTokenId);
  const sig = signature(currentTenantId() || '', id, String(exp));
  return { code: `${VERSION}.${id}.${exp}.${sig}`, expiresAt: new Date(exp * 1000) };
}

/**
 * The code in what a phone sent: the bare code, or the check-in page's
 * address with the code in its `c` parameter (what the QR code holds, and
 * what a phone's camera opens). Anything else comes back as it was, to fail
 * the format check.
 */
function codeFrom(input) {
  const text = String(input || '').trim().slice(0, 2048);
  if (text.startsWith(VERSION + '.')) return text;
  const match = /[?&]c=([^&#\s]*)/.exec(text);
  if (!match) return text;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
  } catch {
    return '';
  }
}

/**
 * Reads a scanned code in the gym in context:
 *   { ok: true, deskTokenId }        signed here, for that desk, still good
 *   { ok: false, reason: 'invalid' } not a code, tampered with, or another gym's
 *   { ok: false, reason: 'expired' } genuine, but the screen has moved on
 * The signature is checked before the time, so only a code this gym really
 * issued is ever called expired.
 */
function verifyDeskCode(input, now = Date.now()) {
  const match = FORMAT.exec(codeFrom(input));
  if (!match) return { ok: false, reason: 'invalid' };
  const [, deskTokenId, expText, sig] = match;

  let expected;
  try {
    expected = Buffer.from(signature(currentTenantId() || '', deskTokenId, expText));
  } catch {
    // No secret configured: nothing can have been issued, so nothing verifies.
    return { ok: false, reason: 'invalid' };
  }
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid' };
  }

  if ((Number(expText) + GRACE_SECONDS) * 1000 < now) return { ok: false, reason: 'expired' };
  return { ok: true, deskTokenId: deskTokenId.toLowerCase() };
}

module.exports = {
  issueDeskCode,
  verifyDeskCode,
  codeFrom,
  VALID_SECONDS,
  GRACE_SECONDS,
  REFRESH_AFTER_SECONDS,
  CHECKIN_PATH
};
