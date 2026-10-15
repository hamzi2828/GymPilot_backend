// src/platform/routes/deskLinkRoutes.js
//
// Mounted at /api/desk-link by index.js, BEFORE the tenant gate: the
// Windows app redeeming a code has not told us its gym -- the code does.
// See controllers/deskLinkController.js for the whole flow.
//
// The admin panel's routes do belong to a gym, so the gate's own middleware
// is applied to them here by hand, in its order: resolveTenant (which gym's
// site the request came from, refusing a suspended one), then auth (a staff
// session issued by that same gym).

const express = require('express');
const { rateLimit } = require('express-rate-limit');

const auth = require('../../middleware/auth');
const { clientKey } = require('../../middleware/rateLimit');
const { resolveTenant } = require('../middleware/resolveTenant');
const { warmPlatformModels } = require('../models');
const controller = require('../controllers/deskLinkController');

const router = express.Router();

const MINUTE = 60 * 1000;

// Same JSON refusal the other limiters send: the desk app and the panel
// both read `message`.
function limiter(options) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientKey,
    handler: (req, res, next, opts) => {
      res.status(opts.statusCode).json({ success: false, code: 'TOO_MANY_ATTEMPTS', message: opts.message });
    },
    ...options
  });
}

// Redeeming is where a code could be guessed. Failures only, per address:
// a gym linking five desks in a row is never stopped, and ten wrong codes
// in fifteen minutes make 2^40 codes a hopeless search.
const redeemLimiter = limiter({
  windowMs: 15 * MINUTE,
  max: 10,
  skipSuccessfulRequests: true,
  message: 'Too many wrong codes from this connection. Wait 15 minutes, then try again with a new code.'
});

// Asking for codes: generous for a person, a ceiling for a script.
const createLimiter = limiter({
  windowMs: 60 * MINUTE,
  max: 30,
  message: 'Too many link codes asked for. Wait a while and try again.'
});

router.use((req, res, next) => {
  warmPlatformModels();
  next();
});

// The Windows app: no gym, no session -- the code is both.
router.post('/redeem', redeemLimiter, controller.redeem);

// The admin panel's Desk app page.
router.get('/', resolveTenant, auth, controller.overview);
router.post('/codes', resolveTenant, auth, createLimiter, controller.createCode);
router.post('/desks/:id/unlink', resolveTenant, auth, controller.unlink);

module.exports = router;
