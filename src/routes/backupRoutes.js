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

module.exports = router;
