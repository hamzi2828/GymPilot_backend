// src/services/backupJobs.js
//
// Stored backups: the daily one for every gym (/api/jobs/backups), "Back up
// now" from Settings → Data & backup, and the one a restore takes first.
//
// Each is the owner's download (services/backupService.js), encrypted as it
// is written (services/backupCrypto.js) and stored in the Blob store as it
// is encrypted (services/backupStorage.js) -- nothing holds the whole file --
// then listed in platform_backups (platform/models/platformBackupModel.js).
//
// Kept: the newest BACKUP_KEEP_DAILY (default 7) of each kind per gym. Older
// ones are removed from the store and the list after each new one.
//
// Needs both the store and the key. Without either nothing is stored and
// the reason is given -- to the cron's answer, and to the owner's screen --
// rather than failing, or worse, storing a backup anyone could read.

const PlatformBackup = require('../platform/models/platformBackupModel');
const { currentTenant } = require('../platform/tenantContext');
const backups = require('./backupService');
const backupCrypto = require('./backupCrypto');
const storage = require('./backupStorage');
const { PassThrough, Transform } = require('stream');

// A daily backup this recent means today's is done: a second call of the
// cron (a retry, a manual run) does not make another.
const DAILY_EVERY_MS = 20 * 60 * 60 * 1000;

/** How many of each kind to keep per gym (BACKUP_KEEP_DAILY, 1-90, default 7). */
function keepCount(env = process.env) {
  const n = parseInt(env.BACKUP_KEEP_DAILY, 10);
  return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 7;
}

/**
 * Whether stored backups can be made here: { ready, storage, key, reason }.
 * `reason` is for the platform's operator (it names the setting).
 */
function readiness(env = process.env) {
  const hasStorage = storage.configured(env);
  const hasKey = backupCrypto.keyConfigured(env);
  let reason = null;
  if (!hasStorage) reason = 'File storage is not configured on the server (BLOB_READ_WRITE_TOKEN is not set).';
  else if (!hasKey) reason = 'Backups cannot be encrypted: BACKUP_ENCRYPTION_KEY is not set on the server.';
  return { ready: !reason, storage: hasStorage, key: hasKey, reason };
}

function notReady(state) {
  const error = new Error(state.reason);
  error.status = 409;
  error.code = 'BACKUPS_NOT_CONFIGURED';
  return error;
}

// Counts the bytes that go by.
function byteCounter() {
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      counter.bytes += chunk.length;
      done(null, chunk);
    }
  });
  counter.bytes = 0;
  return counter;
}

function stampOf(when) {
  return when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Makes, encrypts and stores a backup of the gym in context, and lists it.
 * `kind`: 'daily', 'manual' or 'pre-restore'. Resolves with the list entry.
 * Throws (status 409) when the server cannot store backups.
 */
async function storeBackup({ kind, actor = null, now = new Date() }) {
  const state = readiness();
  if (!state.ready) throw notReady(state);
  const gym = currentTenant();
  if (!gym) throw new Error('[backup] No gym in context');

  const pathname = `${gym.slug}/backups/${kind}/${gym.slug}-${stampOf(now)}.gpbackup`;
  const counter = byteCounter();
  const upload = new PassThrough();
  // The store reads the upload stream while the archive is written into it.
  // If the store gives up, the stream is destroyed so the writing stops too
  // (otherwise it would wait for ever on a reader that has gone).
  const saving = storage.save(pathname, upload).catch((error) => {
    upload.destroy(error);
    throw error;
  });
  let manifest;
  try {
    manifest = await backups.writeGymArchive({ trigger: kind, now }, backupCrypto.encryptStream(String(gym._id)), counter, upload);
  } catch (error) {
    // The upload stream has been destroyed with the error, so the store
    // gives up too; its own rejection says nothing more.
    saving.catch(() => {});
    throw error;
  }
  const stored = await saving;

  const entry = await PlatformBackup.create({
    gymId: gym._id,
    gymSlug: gym.slug,
    kind,
    url: stored.url,
    pathname: stored.pathname,
    size: counter.bytes,
    takenAt: new Date(manifest.createdAt),
    documents: manifest.documents,
    collections: manifest.collections.map((c) => ({ name: c.name, documents: c.documents })),
    createdBy: actor ? { id: String(actor.id || ''), email: String(actor.email || '') } : undefined
  });
  await prune(gym);
  return entry;
}

/**
 * Removes this gym's backups beyond the newest keepCount() of each kind.
 * The list entry goes only once the file is gone from the store, so nothing
 * is ever left in the store unlisted; a file the store cannot remove now is
 * tried again after the next backup.
 */
async function prune(gym, { keep = keepCount() } = {}) {
  const removed = [];
  for (const kind of PlatformBackup.schema.statics.KINDS) {
    const old = await PlatformBackup.find({ gymId: gym._id, kind }).sort({ createdAt: -1 }).skip(keep).select('_id url').lean();
    if (!old.length) continue;
    try {
      await storage.remove(old.map((b) => b.url));
    } catch (error) {
      console.error(`[backups] could not remove old backups of ${gym.slug}:`, error.message);
      continue;
    }
    await PlatformBackup.deleteMany({ _id: { $in: old.map((b) => b._id) } });
    removed.push(...old.map((b) => String(b._id)));
  }
  return removed;
}

/** The gym in context's stored backups, newest first, as the owner sees them. */
async function listBackups() {
  const gym = currentTenant();
  const rows = await PlatformBackup.find({ gymId: gym._id }).sort({ createdAt: -1 }).lean();
  return rows.map(publicBackup);
}

function publicBackup(row) {
  return {
    id: String(row._id),
    kind: row.kind,
    createdAt: row.createdAt,
    takenAt: row.takenAt,
    size: row.size,
    documents: row.documents,
    collections: (row.collections || []).length,
    createdBy: row.createdBy && row.createdBy.email ? row.createdBy.email : null
  };
}

/**
 * The daily run for one gym (inside its tenant context). Skips, with the
 * reason, a gym that already has today's backup.
 */
async function dailyBackup({ dryRun = false, now = new Date() } = {}) {
  const gym = currentTenant();
  const recent = await PlatformBackup.findOne({ gymId: gym._id, kind: 'daily', createdAt: { $gt: new Date(now.getTime() - DAILY_EVERY_MS) } })
    .select('_id createdAt')
    .lean();
  if (recent) return { skipped: 'backed up in the last 20 hours', last: recent.createdAt };
  if (dryRun) return { would: 'back up' };
  const entry = await storeBackup({ kind: 'daily', now });
  return { backup: String(entry._id), size: entry.size, documents: entry.documents };
}

module.exports = {
  keepCount,
  readiness,
  storeBackup,
  prune,
  listBackups,
  publicBackup,
  dailyBackup
};
