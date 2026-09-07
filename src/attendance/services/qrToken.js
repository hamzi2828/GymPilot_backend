// src/attendance/services/qrToken.js
//
// The QR code a member shows at the door. A short signed token rather than
// a bare id: anyone can read a QR code off a phone screen, so what it
// carries must not be something that stays valid forever or can be made up
// for another member. It is signed with the server secret, tied to the gym,
// and expires within two days -- the account page fetches a fresh one every
// time it is opened, so a member's code quietly rotates.
//
//   GPQ1.<personType>.<personId>.<expiry unix seconds>.<signature>

const crypto = require('crypto');
const { currentTenantId } = require('../../platform/tenantContext');

const VERSION = 'GPQ1';
const VALID_SECONDS = 2 * 24 * 60 * 60;
const SIGNATURE_LENGTH = 24;

function secret() {
  const value = process.env.QR_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error('Cannot sign QR tokens: set QR_TOKEN_SECRET (or JWT_SECRET)');
  return value;
}

function signature(tenantId, personType, personId, exp) {
  return crypto
    .createHmac('sha256', secret())
    .update([tenantId, personType, personId, exp].join('|'))
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

function issueQrToken({ personType, personId }) {
  const tenantId = currentTenantId() || '';
  const exp = Math.floor(Date.now() / 1000) + VALID_SECONDS;
  const id = String(personId);
  const sig = signature(tenantId, personType, id, String(exp));
  return {
    token: `${VERSION}.${personType}.${id}.${exp}.${sig}`,
    expiresAt: new Date(exp * 1000)
  };
}

/** @returns {{personType: 'member'|'staff', personId: string}|null} */
function verifyQrToken(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const [, personType, personId, expText, sig] = parts;
  if (personType !== 'member' && personType !== 'staff') return null;
  if (!/^[0-9a-fA-F]{24}$/.test(personId)) return null;
  const exp = parseInt(expText, 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;

  const expected = signature(currentTenantId() || '', personType, personId, expText);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { personType, personId };
}

module.exports = { issueQrToken, verifyQrToken, VALID_SECONDS };
