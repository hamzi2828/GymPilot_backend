// src/routes/backupRoutes.js
//
// Settings → Data & backup (controller/backupController.js). Mounted from
// allRoutes.js, so these run past the tenant gate, for the gym whose site the
// request came from.
//
// A backup or a restore is for the gym's administrators only: `settings` at
// manage is not enough on its own, since a role can be given that without
// being trusted with every member's data at once. The permission gate comes
// first so a refused attempt is in the audit log too.

const express = require('express');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const requireAdmin = require('../middleware/requireAdmin');
const backupController = require('../controller/backupController');

const router = express.Router();
const ownerOnly = [auth, requirePermission('settings', 'manage'), requireAdmin];

router.post('/api/backups/download', ...ownerOnly, backupController.download);
router.get('/api/backups', ...ownerOnly, backupController.list);
router.post('/api/backups/run', ...ownerOnly, backupController.run);
router.post('/api/backups/:id/download', ...ownerOnly, backupController.downloadStored);
router.post('/api/backups/uploads', ...ownerOnly, backupController.grantUpload);
router.post('/api/backups/uploads/:id/complete', ...ownerOnly, backupController.completeUpload);
router.post('/api/backups/restore/preview', ...ownerOnly, backupController.previewRestore);
router.post('/api/backups/restore', ...ownerOnly, backupController.restore);

// The daily backup of every gym, for Vercel Cron (which only sends GET) and
// anything else holding CRON_SECRET. /api/jobs/* is exempt from the tenant
// gate (index.js): it loops over every gym itself.
router.get('/api/jobs/backups', backupController.runDaily);
router.post('/api/jobs/backups', backupController.runDaily);

module.exports = router;
