// src/controller/backupController.js
//
// Settings → Data & backup. Everything here is for the gym's administrators
// only -- `settings` at manage AND the administrator role (routes/
// backupRoutes.js): a backup is every member's personal data at once, and a
// restore rewrites all of it.
//
//   POST /api/backups/download   the whole gym, now, as a .tar.gz
//                                (services/backupService.js), streamed
//
// Every call is a POST so the permission gate writes it to the audit log
// (middleware/requirePermission.js records writes, not reads); a download of
// the whole membership is exactly the kind of thing that trail is for.
//
// Why streamed: Vercel refuses a function response over 4.5 MB unless it is
// streamed, and streaming is on for every Node.js function. The archive is
// written to the response as it is read from the database, so neither the
// size limit nor the function's memory decides how big a gym can be.

const AdminAuditLog = require('../models/adminAuditLogModel');
const { currentTenant } = require('../platform/tenantContext');
const backups = require('../services/backupService');

function actorOf(req) {
  return { actorId: (req.user && req.user.id) || null, actorEmail: (req.user && req.user.email) || '', actorRole: req.roleSlug || '' };
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
      // pipeline), so the browser sees a broken download. The gate only
      // records a response that finished; this one did not, and a partial
      // copy of the data may still have left, so it is recorded here.
      console.error('[backups] download failed part-way:', error);
      AdminAuditLog.record({
        ...actorOf(req),
        method: req.method,
        path: req.originalUrl.split('?')[0],
        tab: 'settings',
        status: 500,
        body: { error: String(error.message || error).slice(0, 200) }
      });
    }
    return undefined;
  }
};

module.exports = backupController;
