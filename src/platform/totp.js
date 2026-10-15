// src/platform/totp.js
//
// Authenticator-app codes for the platform panel's two-factor sign-in:
// TOTP as RFC 6238 has it -- HMAC-SHA1, 30-second steps, six digits -- the
// flavour every authenticator app (Google Authenticator, Microsoft
// Authenticator, 1Password, Authy) reads from an otpauth:// QR code. Node's
// crypto only; nothing here touches the database.
//
// Backup codes live here too: ten one-time codes shown once when the app is
// set up, kept only as hashes, for the day the phone is lost.

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side of now: a phone clock half a minute out, or a code
// typed as it rolled over, still works.
const WINDOW = 1;
const SECRET_BYTES = 20; // 160 bits, what RFC 4226 recommends for SHA-1
const BACKUP_CODE_COUNT = 10;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Bytes -> RFC 4648 base32, no padding (what otpauth:// URLs carry). */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 -> bytes. Spaces, dashes, padding and case are forgiven, as people type them. */
function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh secret, base32. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** RFC 4226 HOTP for one counter value. */
function hotp(secret, counter, digits = DIGITS) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step a moment falls in. */
function stepAt(timeMs = Date.now()) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

/** The code an app shows at `timeMs`. */
function totp(secret, timeMs = Date.now(), digits = DIGITS) {
  return hotp(secret, stepAt(timeMs), digits);
}

/**
 * Checks a typed code against the steps around now. Resolves to the step it
 * matched (the caller stores it, so the same code cannot be used twice) or
 * null. A step at or before `afterStep` never matches: that code was spent.
 */
function verifyTotp(secret, code, { timeMs = Date.now(), afterStep = -1 } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean) || !secret) return null;
  let key;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }
  const now = stepAt(timeMs);
  const typed = Buffer.from(clean);
  for (let delta = -WINDOW; delta <= WINDOW; delta += 1) {
    const step = now + delta;
    if (step <= afterStep) continue;
    if (crypto.timingSafeEqual(typed, Buffer.from(hotp(key, step)))) return step;
  }
  return null;
}

/** What the QR code says: an otpauth:// URL any authenticator app reads. */
function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Backup codes: ten characters from an alphabet with nothing that reads as
// something else (no 0/O, 1/I/L), shown as xxxxx-xxxxx. ~50 bits each.
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function normalizeBackupCode(code) {
  return String(code || '').toLowerCase().replace(/[\s-]/g, '');
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(`gympilot.platform.backup:${normalizeBackupCode(code)}`).digest('hex');
}

/** Fresh backup codes: `codes` to show once, `hashes` to keep. */
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let raw = '';
    for (let j = 0; j < 10; j += 1) raw += BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashBackupCode) };
}

/** Whether a typed value has the shape of a backup code rather than an app code. */
function looksLikeBackupCode(code) {
  return /^[a-z0-9]{10}$/.test(normalizeBackupCode(code)) && !/^\d+$/.test(normalizeBackupCode(code));
}

/** Index of the stored hash a typed backup code matches, or -1. */
function matchBackupCode(hashes, code) {
  if (!looksLikeBackupCode(code)) return -1;
  const typed = Buffer.from(hashBackupCode(code));
  let found = -1;
  (hashes || []).forEach((hash, index) => {
    const stored = Buffer.from(String(hash));
    if (stored.length === typed.length && crypto.timingSafeEqual(stored, typed)) found = index;
  });
  return found;
}

module.exports = {
  STEP_SECONDS,
  DIGITS,
  WINDOW,
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  stepAt,
  verifyTotp,
  otpauthUrl,
  generateBackupCodes,
  hashBackupCode,
  matchBackupCode,
  looksLikeBackupCode
};
