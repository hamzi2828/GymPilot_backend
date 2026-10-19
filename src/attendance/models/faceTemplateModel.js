// src/attendance/models/faceTemplateModel.js
//
// The face a person registered at the front desk, for the desk's webcam to
// check them in by. Not a picture: the Windows desk finds the face (YuNet),
// lines it up and turns it into SFace feature vectors -- 128 numbers each,
// L2-normalised -- on the PC, and sends only those numbers. The server never
// sees an image. One row per person, holding the 1 to 10 vectors the desk took
// at enrolment.
//
// Encrypted at rest, for the reason fingerprint templates are: a face template
// is biometric data that cannot be reissued the way a password can. It is
// decrypted in exactly one place -- POST /api/desktop/face-templates, which
// hands the set to a signed-in front-desk PC so it can match locally, and
// keep matching while its connection is down.

const crypto = require('crypto');
const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');
const { currentTenant } = require('../../platform/tenantContext');

const ALGORITHM = 'aes-256-gcm';
// Fixed, and different from the fingerprint store's: the key has to be
// derivable again on every boot, and a face key must never open a finger.
const KEY_SALT = 'gympilot.face.v1';

// The one model whose vectors this server takes (OpenCV Zoo's SFace). Vectors
// from another model mean nothing beside these, so a desk sending one is
// refused rather than stored.
const FACE_MODEL = 'sface-2021dec';
const DIMENSIONS = 128;
const MAX_VECTORS = 10;

const keys = new Map(); // gym id -> Buffer

// The fingerprint store's secret (FINGERPRINT_ENCRYPTION_KEY, falling back to
// JWT_SECRET), derived once per gym, so faces lifted from one gym's database
// cannot be read with another's key. Faces are newer than per-gym keys, so
// there is no older, gym-less key to keep: outside a gym nothing is sealed.
function encryptionKey() {
  const secret = process.env.FINGERPRINT_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Cannot encrypt face templates: set FINGERPRINT_ENCRYPTION_KEY (or JWT_SECRET) in .env');
  }
  const gym = currentTenant();
  if (!gym) throw new Error('Face templates are sealed per gym, and no gym is in context.');

  const scope = String(gym._id);
  let key = keys.get(scope);
  if (!key) {
    key = crypto.scryptSync(secret, `${KEY_SALT}:${scope}`, 32);
    keys.set(scope, key);
  }
  return key;
}

/** number[][] -> "iv:tag:payload", the vectors as JSON, sealed for this gym. */
function encryptEmbeddings(vectors) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(vectors), 'utf8')), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * The vectors back, or null when they cannot be read here: another gym's,
 * sealed under a secret this server no longer has, or tampered with. One
 * unreadable face must not fail the whole download -- the caller skips it.
 */
function decryptEmbeddings(stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]);
    const vectors = JSON.parse(plain.toString('utf8'));
    return Array.isArray(vectors) ? vectors : null;
  } catch {
    return null;
  }
}

/**
 * What a desk sent as `embeddings`, if it is a face template this server
 * stores: 1 to MAX_VECTORS vectors of exactly DIMENSIONS finite numbers.
 * null otherwise -- strings that look like numbers included, and the
 * Infinity a JSON number too large becomes.
 */
function readEmbeddings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VECTORS) return null;
  for (const vector of value) {
    if (!Array.isArray(vector) || vector.length !== DIMENSIONS) return null;
    if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  }
  return value.map((vector) => vector.slice());
}

const faceTemplateSchema = new mongoose.Schema(
  {
    // Members are Users; staff are Trainers or staff Users -- the same pair
    // that identifies a fingerprint's owner.
    personType: { type: String, enum: ['member', 'staff'], required: true, index: true },
    personId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    // AES-256-GCM, "iv:tag:payload", of the JSON number[][]. Never returned
    // by a normal query -- `select: false` keeps it out of every find() that
    // does not ask for it.
    embeddings: { type: String, required: true, select: false },
    // Which model made the vectors (FACE_MODEL), and how many there are.
    model: { type: String, required: true },
    count: { type: Number, default: 0 },

    // The person agreed, at the desk, at this moment: the desk operator ticked
    // the consent box with them standing there. Re-enrolling records it again.
    consentAt: { type: Date, required: true },
    consentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    enrolledByName: { type: String, default: '' },
    device: { type: String, default: '' },

    isActive: { type: Boolean, default: true }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application. See the
    // note in attendanceModel.js.
    collection: 'gym_face_templates'
  }
);

// One face per person: enrolling again replaces it.
faceTemplateSchema.index({ personType: 1, personId: 1 }, { unique: true });

faceTemplateSchema.statics.encryptEmbeddings = encryptEmbeddings;
faceTemplateSchema.statics.decryptEmbeddings = decryptEmbeddings;
faceTemplateSchema.statics.readEmbeddings = readEmbeddings;
faceTemplateSchema.statics.FACE_MODEL = FACE_MODEL;

module.exports = tenantModel('FaceTemplate', faceTemplateSchema);
