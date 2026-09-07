// src/attendance/models/fingerprintModel.js
//
// One enrolled finger. The template is a DigitalPersona enrolment template
// produced on the front-desk PC (the desktop app fuses four scans locally and
// sends only the finished template), stored here encrypted at rest.
//
// Why encrypted: a fingerprint template is biometric data that cannot be
// reissued the way a password can. It is decrypted in exactly one place --
// GET/POST /api/desktop/templates, which hands the set to a signed-in
// front-desk PC so it can match scans locally. See the desktop app's README
// for why matching happens there rather than here.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
// Fixed salt: the key must be derivable again on every boot and across
// instances, so it cannot be random per-process. The secret itself is what
// keeps this closed, not the salt.
const KEY_SALT = 'gympilot.fingerprint.v1';

const { currentTenant } = require('../../platform/tenantContext');

// One derived key per gym, so a template lifted from one gym's database
// cannot be decrypted with another's. The gym a single-gym deployment
// defaults to keeps the original derivation: its templates were written
// with it, and re-keying biometric data in place is not something to do
// silently in a migration.
const keys = new Map(); // scope -> Buffer

// Prefers a purpose-made secret, and falls back to JWT_SECRET so a fresh
// checkout works without extra setup. Set FINGERPRINT_ENCRYPTION_KEY in
// production: rotating the JWT secret would otherwise make every stored
// template unreadable.
function encryptionKey() {
  const secret = process.env.FINGERPRINT_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'Cannot encrypt fingerprint templates: set FINGERPRINT_ENCRYPTION_KEY (or JWT_SECRET) in .env'
    );
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

function encryptTemplate(base64Template) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(String(base64Template), 'utf8')),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  // iv:tag:payload -- self-describing, so a row carries everything needed to
  // read it back without a side table.
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptTemplate(stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 3) return null;

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(parts[0], 'base64')
    );
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64')),
      decipher.final()
    ]);
    return plain.toString('utf8');
  } catch (err) {
    // Wrong key (secret rotated) or a tampered row. One unreadable finger
    // must not fail the whole template download -- the caller skips it.
    return null;
  }
}

const fingerprintSchema = new mongoose.Schema(
  {
    // Members are Users; staff are Trainers. Both punch on the same reader,
    // so both live in one table and the pair (personType, personId) is what
    // identifies whose finger this is.
    personType: {
      type: String,
      enum: ['member', 'staff'],
      required: true,
      index: true
    },
    personId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },

    // 1-10, matching FingerNames.All in the desktop app.
    fingerIndex: { type: Number, required: true, min: 1, max: 10 },

    // AES-256-GCM, "iv:tag:payload". Never returned by a normal query --
    // `select: false` keeps it out of every find() that does not ask.
    template: { type: String, required: true, select: false },

    samplesAccepted: { type: Number, default: 0 },
    samplesTotal: { type: Number, default: 0 },

    enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    enrolledByName: { type: String, default: '' },
    enrolledDevice: { type: String, default: '' },

    isActive: { type: Boolean, default: true }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application. See the
    // note in attendanceModel.js.
    collection: 'gym_fingerprints'
  }
);

// One row per finger per person: re-enrolling the same finger replaces it
// rather than leaving two templates that both match.
fingerprintSchema.index({ personType: 1, personId: 1, fingerIndex: 1 }, { unique: true });

fingerprintSchema.statics.encryptTemplate = encryptTemplate;
fingerprintSchema.statics.decryptTemplate = decryptTemplate;

module.exports =
  tenantModel('Fingerprint', fingerprintSchema);
