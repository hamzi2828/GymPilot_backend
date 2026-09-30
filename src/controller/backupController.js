// src/controller/backupController.js
//
// Settings → Data & backup. Everything here is for the gym's administrators
// only -- `settings` at manage AND the administrator role (routes/
// backupRoutes.js): a backup is every member's personal data at once, and a
// restore rewrites all of it.
//
//   POST /api/backups/download      the whole gym, now, as a .tar.gz
//                                   (services/backupService.js), streamed
//   GET  /api/backups               the stored backups, and whether this
//                                   server can make them
//   POST /api/backups/run           "Back up now": a stored backup
//   POST /api/backups/:id/download  a stored backup, decrypted here and
//                                   streamed as the same .tar.gz
//   POST /api/backups/uploads       to restore from a file: an upload grant
//                                   (see below)
//   POST /api/backups/uploads/:id/complete   the file has arrived
//   POST /api/backups/restore/preview        what a backup holds (dry run)
//   POST /api/backups/restore                restore it (services/backupRestore.js)
//
// and, for the scheduler rather than a person,
//
//   GET/POST /api/jobs/backups      the daily backup of every active gym
//                                   (Authorization: Bearer <CRON_SECRET>)
//
// Everything that hands data out or changes anything is a POST, so the
// permission gate writes it to the audit log (middleware/requirePermission.js
// records writes, not reads); a download of the whole membership is exactly
// the kind of thing that trail is for.
//
// Why streamed: Vercel refuses a function response over 4.5 MB unless it is
// streamed, and streaming is on for every Node.js function. An archive is
// written to the response as it is read (from the database, or from the
// store through the decryption), so neither the size limit nor the
// function's memory decides how big a gym can be.
//
// Uploading a file to restore from: the same 4.5 MB cap applies to request
// bodies, and streaming does not lift it. So the file goes from the browser
// straight to the Blob store, with a client token good for one path -- the
// mechanism the admin pages use for big images (controller/
// uploadController.js). But the store is public and the file is the whole
// membership in plain text, so the browser encrypts it first, in the stored
// backups' own format (services/backupCrypto.js), with a file key this
// server derives from BACKUP_ENCRYPTION_KEY for this gym and hands over with
// the grant. The store only ever holds ciphertext, and the server opens it
// exactly as it opens any stored backup.

const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const AdminAuditLog = require('../models/adminAuditLogModel');
const PlatformBackup = require('../platform/models/platformBackupModel');
const { currentTenant } = require('../platform/tenantContext');
const backups = require('../services/backupService');
const backupCrypto = require('../services/backupCrypto');
const backupJobs = require('../services/backupJobs');
const backupRestore = require('../services/backupRestore');
const storage = require('../services/backupStorage');
const { ownBlobUrl } = require('../helper/blobUpload');

// The largest file that can be uploaded to restore from. A gym whose
// compressed backup is bigger than this could not be restored inside one
// function call anyway.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const UPLOAD_FOLDER = 'backups/uploads';

function actorOf(req) {
  return { actorId: (req.user && req.user.id) || null, actorEmail: (req.user && req.user.email) || '', actorRole: req.roleSlug || '' };
}

// A streamed response that broke part-way never "finishes", so the gate's
// audit entry is never written; a partial copy of the data may still have
// left, so it is recorded here.
function auditBrokenDownload(req, error) {
  AdminAuditLog.record({
    ...actorOf(req),
    method: req.method,
    path: req.originalUrl.split('?')[0],
    tab: 'settings',
    status: 500,
    body: { error: String((error && error.message) || error).slice(0, 200) }
  });
}

function sendError(res, error, fallback) {
  const status = Number(error && error.status) || 500;
  const shown = status < 500 || (error && error.expose);
  if (!shown) console.error(`[backups] ${fallback}:`, error);
  return res.status(status).json({
    success: false,
    code: (error && error.code) || undefined,
    message: shown ? error.message : fallback
  });
}

async function findOwnBackup(id, { ready = true } = {}) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) return null;
  // The gym is part of the query: another gym's id is simply not found.
  const filter = { _id: id, gymId: currentTenant()._id };
  if (ready) filter.status = { $ne: 'pending' };
  return PlatformBackup.findOne(filter).lean();
}

const notFound = (res) => res.status(404).json({ success: false, message: 'Backup not found' });

/**
 * Streams `source` to the response as a download named `filename` -- but
 * only once its first bytes exist. Anything that goes wrong before that (the
 * wrong key, not a backup at all) is still answered as an ordinary error;
 * after it, the download can only be cut off.
 */
async function streamDownload(req, res, source, filename) {
  const iterator = source[Symbol.asyncIterator]();
  let first;
  try {
    first = await iterator.next();
  } catch (error) {
    source.destroy();
    return sendError(res, error, 'The backup could not be read');
  }
  res.status(200);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  async function* rest() {
    if (!first.done) yield first.value;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  try {
    await pipeline(Readable.from(rest(), { objectMode: false }), res);
  } catch (error) {
    console.error('[backups] download failed part-way:', error);
    auditBrokenDownload(req, error);
  }
  return undefined;
}

// The scheduler's shared secret, compared in constant time. Without
// CRON_SECRET the route refuses everything, as /api/jobs/reminders does.
function cronRefusal(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { status: 503, message: 'Scheduled jobs are disabled: CRON_SECRET is not configured.' };
  const header = req.headers.authorization || '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(secret);
  const ok = presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
  return ok ? null : { status: 401, message: 'Unauthorized' };
}

const backupController = {
  // POST /api/backups/download
  download: async (req, res) => {
    const gym = currentTenant();
    const now = new Date();
    try {
      // Reach the database before the first byte goes out: a failure here
      // can still be answered properly, one mid-stream can only cut it off.
      await backups.tenantDb().command({ ping: 1 });
    } catch (error) {
      console.error('[backups] download could not start:', error);
      return res.status(503).json({ success: false, message: 'The database could not be reached. Please try again in a moment.' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${backups.archiveFileName(gym && gym.slug, now)}"`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      await backups.writeGymArchive({ trigger: 'download', now }, res);
    } catch (error) {
      // The response is already under way (and has been destroyed by the
      // pipeline), so the browser sees a broken download.
      console.error('[backups] download failed part-way:', error);
      auditBrokenDownload(req, error);
    }
    return undefined;
  },

  // GET /api/backups
  list: async (req, res) => {
    try {
      const state = backupJobs.readiness();
      return res.status(200).json({
        success: true,
        data: {
          ready: state.ready,
          reason: state.reason,
          keep: backupJobs.keepCount(),
          backups: await backupJobs.listBackups()
        }
      });
    } catch (error) {
      return sendError(res, error, 'Could not list the backups');
    }
  },

  // POST /api/backups/run
  run: async (req, res) => {
    try {
      const entry = await backupJobs.storeBackup({ kind: 'manual', actor: req.user });
      return res.status(201).json({ success: true, message: 'Backup stored', data: backupJobs.publicBackup(entry.toObject ? entry.toObject() : entry) });
    } catch (error) {
      return sendError(res, error, 'The backup could not be stored');
    }
  },

  // POST /api/backups/:id/download
  downloadStored: async (req, res) => {
    const gym = currentTenant();
    let entry;
    let source;
    try {
      entry = await findOwnBackup(req.params.id);
      if (!entry || entry.kind === 'upload') return notFound(res);
      if (!backupCrypto.keyConfigured()) {
        return res.status(409).json({ success: false, code: 'BACKUPS_NOT_CONFIGURED', message: 'Backups cannot be opened: BACKUP_ENCRYPTION_KEY is not set on the server.' });
      }
      source = await storage.open(entry.url);
    } catch (error) {
      return sendError(res, error, 'The backup could not be fetched from storage');
    }
    const decrypted = backupCrypto.decryptStream(String(gym._id));
    pipeline(source, decrypted).catch((error) => decrypted.destroy(error));
    return streamDownload(req, res, decrypted, backups.archiveFileName(gym.slug, new Date(entry.takenAt || entry.createdAt)));
  },

  // POST /api/backups/uploads { size }
  //
  // Grants one upload: where it goes, a client token for exactly that path,
  // and the header and key the browser encrypts the file with.
  grantUpload: async (req, res) => {
    try {
      const state = backupJobs.readiness();
      if (!state.ready) return res.status(409).json({ success: false, code: 'BACKUPS_NOT_CONFIGURED', message: state.reason });
      const size = Number(req.body && req.body.size);
      if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ success: false, message: 'The file is empty.' });
      if (size > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ success: false, code: 'FILE_TOO_LARGE', message: `Backups over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB cannot be uploaded here.` });
      }
      const gym = currentTenant();
      // The encrypted file: the header, the file, and a tag per chunk.
      const sealedBytes = backupCrypto.HEADER_BYTES + size + (Math.floor(size / backupCrypto.CHUNK_BYTES) + 1) * backupCrypto.TAG_BYTES;
      const pathname = `${gym.slug}/${UPLOAD_FOLDER}/${crypto.randomBytes(16).toString('hex')}.gpbackup`;
      const { header, fileKey } = backupCrypto.newFileKey(String(gym._id));
      const clientToken = await storage.uploadToken(pathname, sealedBytes);
      const entry = await PlatformBackup.create({
        gymId: gym._id,
        gymSlug: gym.slug,
        kind: 'upload',
        status: 'pending',
        pathname,
        size: sealedBytes,
        createdBy: { id: String((req.user && req.user.id) || ''), email: String((req.user && req.user.email) || '') }
      });
      return res.status(201).json({
        success: true,
        data: {
          uploadId: String(entry._id),
          pathname,
          clientToken,
          header: header.toString('base64'),
          key: fileKey.toString('base64'),
          chunkBytes: backupCrypto.CHUNK_BYTES
        }
      });
    } catch (error) {
      return sendError(res, error, 'The upload could not be started');
    }
  },

  // POST /api/backups/uploads/:id/complete { url }
  completeUpload: async (req, res) => {
    try {
      const entry = await findOwnBackup(req.params.id, { ready: false });
      if (!entry || entry.kind !== 'upload') return notFound(res);
      const gym = currentTenant();
      // Only the file this upload was granted: on the store, in this gym's
      // folder, at exactly the path the token was for.
      const url = ownBlobUrl(req.body && req.body.url, gym.slug, UPLOAD_FOLDER);
      if (!url || new URL(url).pathname !== `/${entry.pathname}`) {
        return res.status(400).json({ success: false, message: 'That is not the file this upload was for.' });
      }
      await PlatformBackup.updateOne({ _id: entry._id }, { $set: { url, status: 'ready' } });
      return res.status(200).json({ success: true, data: { id: String(entry._id) } });
    } catch (error) {
      return sendError(res, error, 'The upload could not be finished');
    }
  },

  // POST /api/backups/restore/preview { backupId }
  previewRestore: async (req, res) => {
    try {
      const entry = await findOwnBackup(req.body && req.body.backupId);
      if (!entry) return notFound(res);
      if (!backupCrypto.keyConfigured()) {
        return res.status(409).json({ success: false, code: 'BACKUPS_NOT_CONFIGURED', message: 'Backups cannot be opened: BACKUP_ENCRYPTION_KEY is not set on the server.' });
      }
      const data = await backupRestore.previewRestore(entry, { actorId: req.user && req.user.id });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return sendError(res, error, 'The backup could not be read');
    }
  },

  // POST /api/backups/restore { backupId, confirm }
  restore: async (req, res) => {
    try {
      const entry = await findOwnBackup(req.body && req.body.backupId);
      if (!entry) return notFound(res);
      const data = await backupRestore.restoreBackup(entry, { confirm: req.body && req.body.confirm, actor: req.user });
      return res.status(200).json({ success: true, message: 'Restored', data });
    } catch (error) {
      return sendError(res, error, 'The restore failed');
    }
  },

  // GET/POST /api/jobs/backups
  runDaily: async (req, res) => {
    // The time budget counts from here, as the reminders job's does.
    const startedAt = Date.now();
    const refusal = cronRefusal(req);
    if (refusal) return res.status(refusal.status).json({ success: false, message: refusal.message });

    // Nothing can be stored: say why, and stop. Not an error -- the cron
    // runs whether or not the platform has set backups up yet.
    const state = backupJobs.readiness();
    if (!state.ready) {
      console.warn(`[jobs] daily backups skipped: ${state.reason}`);
      return res.status(200).json({ success: true, skipped: state.reason, gyms: {} });
    }

    try {
      const { scheduleActiveGyms, dailyJobPace } = require('../platform/jobs');
      const dryRun = req.query.dryRun === '1';
      // ?gym=<slug>: that one gym only, a catch-up.
      const slug = typeof req.query.gym === 'string' ? req.query.gym.toLowerCase().trim() : '';
      const { concurrency, budgetMs } = dailyJobPace();
      const { gyms, schedule } = await scheduleActiveGyms(() => backupJobs.dailyBackup({ dryRun }), {
        job: 'backups',
        record: !dryRun,
        slug: slug || null,
        concurrency,
        budgetMs,
        startedAt
      });
      if (slug && !Object.keys(gyms).length) {
        return res.status(404).json({ success: false, message: `No active gym "${slug}".` });
      }
      if (schedule.deferred.length) {
        console.warn(`[jobs] backup time budget used; ${schedule.deferred.length} gym(s) left for the next run: ${schedule.deferred.join(', ')}`);
      }
      return res.status(200).json({ success: true, dryRun, keep: backupJobs.keepCount(), gyms, schedule });
    } catch (error) {
      console.error('[jobs] backups failed:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }
};

module.exports = backupController;
