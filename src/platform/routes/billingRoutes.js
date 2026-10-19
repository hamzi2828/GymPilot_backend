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
const { paymentLimiter, clientKey } = require('../../middleware/rateLimit');
const { platformReceiptUploadSingle } = require('../../helper/upload');
const { rateLimit } = require('express-rate-limit');

// Receipts: the allowance a member's receipt upload has (20 in a quarter of
// an hour) -- plenty for an owner, not for a loop.
const receiptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  handler: (req, res, next, options) => res.status(options.statusCode).json({ success: false, code: 'RATE_LIMITED', message: 'Too many receipt uploads. Please wait a few minutes and try again.' })
});

router.get('/subscription', auth, requirePermission('settings', 'view'), billingController.subscription);
router.post('/checkout', auth, requirePermission('settings', 'manage'), billingController.checkout);
router.post('/portal', auth, requirePermission('settings', 'manage'), billingController.portal);
// Paying GymsPilotPro through its own Safepay account (the way the super
// admin chose): opens Safepay's page. Limited like the other payment starts.
router.post('/pay', paymentLimiter, auth, requirePermission('settings', 'manage'), billingController.pay);
// A bank-transfer receipt for GymsPilotPro to check: signed in first, so
// nobody else's file reaches the disk.
router.post('/receipt', receiptLimiter, auth, requirePermission('settings', 'manage'), platformReceiptUploadSingle('receipt'), billingController.receipt);
// The plan picker: what the gym can move to, and moving it.
router.get('/plans', auth, requirePermission('settings', 'view'), billingController.plans);
router.post('/change-plan', auth, requirePermission('settings', 'manage'), billingController.changePlan);

module.exports = router;
