// src/platform/routes/platformRoutes.js
//
// Mounted at /api/platform by index.js -- BEFORE the tenant gate, because
// none of this belongs to a gym. Every route past /auth/login needs a
// platform (super admin) token; a gym's JWT is refused here.

const express = require('express');
const router = express.Router();

const { platformAuth } = require('../middleware/platformAuth');
const { platformLoginLimiter, twoFactorLimiter, passwordResetLimiter, passwordResetConfirmLimiter, demoRequestLimiter, paymentLimiter } = require('../../middleware/rateLimit');
const { warmPlatformModels } = require('../models');
const { imageUploadChecked } = require('../../helper/upload');
const { platformDatabaseName, tenantDatabasePrefix } = require('../dbNames');

const authController = require('../controllers/platformAuthController');
const twoFactorAppController = require('../controllers/platformTwoFactorController');
const gymsController = require('../controllers/gymsController');
const plansController = require('../controllers/plansController');
const addonsController = require('../controllers/addonsController');
const platformSettingsController = require('../controllers/platformSettingsController');
const demoRequestsController = require('../controllers/demoRequestsController');
const signupController = require('../controllers/signupController');

router.use((req, res, next) => {
  warmPlatformModels();
  next();
});

// Auth
router.post('/auth/login', platformLoginLimiter, authController.login);
router.post('/auth/login/2fa', twoFactorLimiter, authController.verifyTwoFactor);
router.post('/auth/forgot-password', passwordResetLimiter, authController.forgotPassword);
router.post('/auth/reset-password', passwordResetConfirmLimiter, authController.resetPassword);
router.get('/auth/me', platformAuth, authController.me);
router.put('/auth/password', platformAuth, authController.changePassword);
router.put('/auth/two-factor', platformAuth, authController.setTwoFactor);
// Authenticator app: limited like the sign-in code step, since enable and
// disable take a code too.
router.post('/auth/two-factor/app/setup', platformAuth, twoFactorAppController.setup);
router.post('/auth/two-factor/app/enable', twoFactorLimiter, platformAuth, twoFactorAppController.enable);
router.post('/auth/two-factor/app/disable', twoFactorLimiter, platformAuth, twoFactorAppController.disable);
router.post('/auth/logout', platformAuth, authController.logout);

// Public: what the marketing site (GymPilot_marketing) reads and posts.
// No session; nothing here says anything about a gym.
router.get('/public/plans', plansController.publicPlans);
router.get('/public/addons', addonsController.publicAddons);
// The domain gyms get their web address under (`<slug>.<root>`), so checkout
// can show it -- or say there is none yet -- and whether checkout can take
// payment and build the gym itself (self_serve_signup) or sends a request
// for the panel to act on. Nothing secret: a yes or no, never why.
router.get('/public/config', async (req, res) => {
  const selfServe = await signupController
    .selfServeAvailable()
    .then((result) => result.available)
    .catch(() => false);
  res.json({ success: true, data: { root_domain: process.env.PLATFORM_ROOT_DOMAIN || '', self_serve_signup: selfServe } });
});

// Stripe's callback. Public by necessity -- the signature is the proof --
// and raw, because a parsed body no longer matches what was signed.
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), platformSettingsController.webhook);
router.post('/public/demo-requests', demoRequestLimiter, demoRequestsController.submit);
// Sign up and pay in one go. Limited like the other payment starts: each
// one opens a Stripe page. The status is polled by the success page.
router.post('/public/signup', paymentLimiter, signupController.start);
router.get('/public/signup/:id/status', signupController.status);

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
router.get('/gyms/:id/domains/status', gymsController.domainsStatus);
router.patch('/gyms/:id/status', gymsController.setStatus);
router.put('/gyms/:id/subscription', gymsController.updateSubscription);
router.get('/gyms/:id/payments', gymsController.listPayments);
router.post('/gyms/:id/payments', gymsController.recordPayment);
router.post('/gyms/:id/reset-owner-password', gymsController.resetOwnerPassword);

// Plans
router.get('/plans', plansController.list);
router.post('/plans', plansController.create);
router.put('/plans/:id', plansController.update);
router.delete('/plans/:id', plansController.remove);

// How gyms pay GymsPilotPro: the way chosen, the platform's own Stripe and
// Safepay keys, its bank accounts, the reminders to gym owners.
router.get('/settings', platformSettingsController.get);
router.put('/settings', platformSettingsController.update);
router.get('/settings/payment-gateways', platformSettingsController.paymentGateways);
router.post('/settings/stripe/test', platformSettingsController.testStripe);
router.post('/settings/bank-accounts', platformSettingsController.addBankAccount);
router.put('/settings/bank-accounts/:id', platformSettingsController.updateBankAccount);
router.delete('/settings/bank-accounts/:id', platformSettingsController.removeBankAccount);
router.post('/settings/bank-accounts/:id/qr', imageUploadChecked('qrCode'), platformSettingsController.uploadBankAccountQr);
router.delete('/settings/bank-accounts/:id/qr', platformSettingsController.removeBankAccountQr);
router.post('/settings/:gatewayId/test', platformSettingsController.testGateway);

// Add-ons sold beside the plans
router.get('/addons', addonsController.list);
router.post('/addons', addonsController.create);
router.put('/addons/:id', addonsController.update);
router.delete('/addons/:id', addonsController.remove);

// Demo requests from the marketing site
router.get('/demo-requests', demoRequestsController.list);
router.get('/demo-requests/:id', demoRequestsController.get);
router.patch('/demo-requests/:id', demoRequestsController.update);
router.delete('/demo-requests/:id', demoRequestsController.remove);

module.exports = router;
