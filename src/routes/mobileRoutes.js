// src/routes/mobileRoutes.js
//
// Mounted at /api/mobile by index.js, BEFORE the tenant gate: a member
// signing in on the phone app has not told us which gym they belong to yet.
// Their username does that (see controller/mobileAuthController.js).
//
// Everything else the app needs is the gym's ordinary API, called with the
// token from here and an `X-Tenant-Slug` header -- except the push-token
// routes at the bottom, which are the app's own.

const express = require('express');
const router = express.Router();

const { loginLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const auth = require('../middleware/auth');
const { warmPlatformModels } = require('../platform/models');
const { resolveTenant } = require('../platform/middleware/resolveTenant');
const mobileAuthController = require('../controller/mobileAuthController');

router.use((req, res, next) => {
  warmPlatformModels();
  next();
});

// Before anyone is signed in. The username -- or, for the second step, the
// gym slug the first step handed back -- says which gym.
router.post('/auth/login', loginLimiter, mobileAuthController.login);
router.post('/auth/login/2fa', loginLimiter, mobileAuthController.verifyTwoFactor);
router.post('/auth/forgot', passwordResetLimiter, mobileAuthController.forgot);
router.get('/branding', mobileAuthController.branding);

// Signed in. This router sits before the gate in index.js, so the gate's
// own middleware is applied here by hand, in the same order: resolveTenant
// reads the app's X-Tenant-Slug, opens that gym's database and enters its
// context; auth then checks the token against that gym. auth has to come
// second -- it compares the token's `tid` with req.tenant and reads the
// account's session state from the gym's own database, neither of which
// exists until the tenant is resolved.
router.post('/push/register', resolveTenant, auth, mobileAuthController.registerPush);
router.delete('/push/register', resolveTenant, auth, mobileAuthController.unregisterPush);

module.exports = router;
