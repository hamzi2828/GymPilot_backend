// src/services/secretBox.js
//
// Secrets at rest. A gym's Settings document carries that gym's own Stripe
// keys, SMTP password and messaging tokens. This seals each of them with
// AES-256-GCM on the way into the database and opens it again on the way
// out, so a database dump or a backup does not hand anyone a working key.
//
// It is applied through mongoose setters and getters on the secret paths
// (see models/settings.js), so no reader or writer has to know it exists.
//
// Stored format:  enc:v1:<iv>:<tag>:<data>   (each part base64)
//
// Anything WITHOUT that prefix is returned exactly as it is. That is what
// makes the rollout safe: a value written before this existed still reads
// back as the plaintext it always was, and is sealed the next time the
// settings are saved. Sealing is idempotent for the same reason -- a value
// read with .lean() (ciphertext) and written straight back is not sealed a
// second time.
//
// The key mirrors the fingerprint store (attendance/models/fingerprintModel.js):
// SETTINGS_ENCRYPTION_KEY, falling back to JWT_SECRET, run through scrypt with
// a salt that carries the gym id, so a value lifted from one gym's database
// cannot be opened with another's. The gym a single-gym deployment defaults
// to (DEFAULT_TENANT_SLUG) keeps the un-suffixed salt, exactly as the
// fingerprint store does.

const crypto = require('crypto');
const { currentTenant } = require('../platform/tenantContext');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
// Fixed salt: the key must be derivable again on every boot and across
// instances. The secret is what keeps this closed, not the salt.
const KEY_SALT = 'gympilot.settings.v1';

const keys = new Map(); // scope -> Buffer

function encryptionKey() {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Cannot protect settings secrets: set SETTINGS_ENCRYPTION_KEY (or JWT_SECRET) in .env');
  }

  const gym = currentTenant();
  const legacy = !gym || (process.env.DEFAULT_TENANT_SLUG && gym.slug === process.env.DEFAULT_TENANT_SLUG);
  const scope = legacy ? '__legacy__' : String(gym._id);

  let key = keys.get(scope);
  if (!key) {
    key = crypto.scryptSync(secret, legacy ? KEY_SALT : `${KEY_SALT}:${scope}`, 32);
    keys.set(scope, key);
  }
  return key;
}

/** Whether a stored value is one of ours. */
function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Plaintext -> 'enc:v1:<iv>:<tag>:<data>'. Empty stays empty (there is nothing
 * to protect, and '' must keep meaning "not set"); an already sealed value is
 * returned untouched.
 */
function seal(plain) {
  if (plain === undefined || plain === null) return plain;
  const text = String(plain);
  if (!text || isSealed(text)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/**
 * The plaintext behind a sealed value. A value that was never sealed comes
 * back as it is; a value that cannot be opened (the secret was rotated, or
 * the row was tampered with) reads as '' -- "not set" -- rather than taking
 * the settings screen and every outbound email down with it.
 */
function open(value) {
  if (!isSealed(value)) return value;

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return '';

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('[secretBox] could not open a sealed setting:', error.message);
    return '';
  }
}

/**
 * Schema options for a String path that must be sealed at rest. Option order
 * matters: mongoose applies setters last-defined-first, so `set` is listed
 * before `trim` to have the plaintext trimmed BEFORE it is sealed -- the
 * stored value then opens to exactly what the plain `trim: true` field held.
 */
function secretString({ trim = true } = {}) {
  return { type: String, default: '', set: seal, ...(trim ? { trim: true } : {}), get: open };
}

module.exports = { seal, open, isSealed, secretString, PREFIX };
