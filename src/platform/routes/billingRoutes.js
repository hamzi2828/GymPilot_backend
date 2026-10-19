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
const { paymentLimiter } = require('../../middleware/rateLimit');

router.get('/subscription', auth, requirePermission('settings', 'view'), billingController.subscription);
router.post('/checkout', auth, requirePermission('settings', 'manage'), billingController.checkout);
router.post('/portal', auth, requirePermission('settings', 'manage'), billingController.portal);
// Paying GymsPilotPro through its own Safepay account (the way the super
// admin chose): opens Safepay's page. Limited like the other payment starts.
router.post('/pay', paymentLimiter, auth, requirePermission('settings', 'manage'), billingController.pay);
// The plan picker: what the gym can move to, and moving it.
router.get('/plans', auth, requirePermission('settings', 'view'), billingController.plans);
router.post('/change-plan', auth, requirePermission('settings', 'manage'), billingController.changePlan);

module.exports = router;
