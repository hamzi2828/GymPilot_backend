// src/routes/mobileRoutes.js
//
// Mounted at /api/mobile by index.js, BEFORE the tenant gate: a member
// signing in on the phone app has not told us which gym they belong to yet.
// Their username does that (see controller/mobileAuthController.js).
//
// Everything else the app needs is the gym's ordinary API, called with the
// token from here and an `X-Tenant-Slug` header.

const express = require('express');
const router = express.Router();

const { loginLimiter } = require('../middleware/rateLimit');
const { warmPlatformModels } = require('../platform/models');
const mobileAuthController = require('../controller/mobileAuthController');

router.use((req, res, next) => {
  warmPlatformModels();
  next();
});

router.post('/auth/login', loginLimiter, mobileAuthController.login);
router.get('/branding', mobileAuthController.branding);

module.exports = router;
