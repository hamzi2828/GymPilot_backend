// src/platform/routes/platformRoutes.js
//
// Mounted at /api/platform by index.js -- BEFORE the tenant gate, because
// none of this belongs to a gym. Every route past /auth/login needs a
// platform (super admin) token; a gym's JWT is refused here.

const express = require('express');
const router = express.Router();

const { platformAuth } = require('../middleware/platformAuth');
const { loginLimiter, passwordResetLimiter, passwordResetConfirmLimiter } = require('../../middleware/rateLimit');
const { warmPlatformModels } = require('../models');
const { platformDatabaseName, tenantDatabasePrefix } = require('../dbNames');

const authController = require('../controllers/platformAuthController');
const gymsController = require('../controllers/gymsController');
const plansController = require('../controllers/plansController');

router.use((req, res, next) => {
  warmPlatformModels();
  next();
});

// Auth
router.post('/auth/login', loginLimiter, authController.login);
router.post('/auth/login/2fa', loginLimiter, authController.verifyTwoFactor);
router.post('/auth/forgot-password', passwordResetLimiter, authController.forgotPassword);
router.post('/auth/reset-password', passwordResetConfirmLimiter, authController.resetPassword);
router.get('/auth/me', platformAuth, authController.me);
router.put('/auth/password', platformAuth, authController.changePassword);
router.put('/auth/two-factor', platformAuth, authController.setTwoFactor);

router.use(platformAuth);

// How this deployment names things -- shown in the panel's forms.
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      platform_database: platformDatabaseName(),
      tenant_database_prefix: tenantDatabasePrefix(),
      root_domain: process.env.PLATFORM_ROOT_DOMAIN || '',
      default_tenant_slug: process.env.DEFAULT_TENANT_SLUG || ''
    }
  });
});

// Overview
router.get('/overview', gymsController.overview);
router.get('/audit', gymsController.auditLog);

// Gyms
router.get('/gyms', gymsController.list);
router.post('/gyms', gymsController.create);
router.get('/gyms/:id', gymsController.get);
router.put('/gyms/:id', gymsController.update);
router.delete('/gyms/:id', gymsController.remove);
router.get('/gyms/:id/stats', gymsController.stats);
router.get('/gyms/:id/admins', gymsController.listAdmins);
router.put('/gyms/:id/domains', gymsController.updateDomains);
router.patch('/gyms/:id/status', gymsController.setStatus);
router.put('/gyms/:id/subscription', gymsController.updateSubscription);
router.post('/gyms/:id/reset-owner-password', gymsController.resetOwnerPassword);

// Plans
router.get('/plans', plansController.list);
router.post('/plans', plansController.create);
router.put('/plans/:id', plansController.update);
router.delete('/plans/:id', plansController.remove);

module.exports = router;
