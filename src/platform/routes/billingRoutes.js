// src/platform/routes/billingRoutes.js
//
// A gym paying the platform. Mounted by index.js at /api/billing, AFTER the
// tenant gate (resolveTenant), so every request here already belongs to one
// gym; `auth` proves who inside it is asking and the Settings permission
// says whether they may look (view) or pay (manage).

const express = require('express');
const router = express.Router();

const auth = require('../../middleware/auth');
const requirePermission = require('../../middleware/requirePermission');
const billingController = require('../controllers/billingController');

router.get('/subscription', auth, requirePermission('settings', 'view'), billingController.subscription);
router.post('/checkout', auth, requirePermission('settings', 'manage'), billingController.checkout);
router.post('/portal', auth, requirePermission('settings', 'manage'), billingController.portal);

module.exports = router;
