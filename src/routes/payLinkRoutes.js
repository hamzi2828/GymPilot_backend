// src/routes/payLinkRoutes.js
//
// Payment links and the member's saved cards (services/billing/). Mounted
// from allRoutes, so it sits behind the tenant gate: the gym is the one whose
// site the request came from.
//
//   GET    /api/pay/:token                    public: the payment page's data
//   POST   /api/pay/:token/checkout           public: open the online checkout
//   POST   /api/pay/:token/proof              public: a bank-transfer receipt (photo or PDF)
//   GET    /api/billing/me/saved-methods      member: their saved cards
//   DELETE /api/billing/me/saved-methods/:id  member: remove one (auto-pay off)
//
// The staff route (POST /api/gymfolio/package-orders/:id/pay-link) lives
// with the other order actions in gymfolioRoutes.

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { clientKey } = require('../middleware/rateLimit');
const auth = require('../middleware/auth');
const { proofUploadSingle } = require('../helper/upload');
const payLinkController = require('../controller/payLinkController');

const router = express.Router();

const MINUTE = 60 * 1000;

function limiter(max, message) {
  return rateLimit({
    windowMs: 15 * MINUTE,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientKey,
    handler: (req, res, next, options) => res.status(options.statusCode).json({ success: false, code: 'RATE_LIMITED', message: options.message })
  });
}

// Reading the page: the member's browser polls it after paying (every few
// seconds for a minute or two), so it has room for that; guessing tokens is
// pointless anyway (a 144-bit signature).
const payPageLimiter = limiter(120, 'Too many requests for this payment page. Please wait a few minutes and try again.');
// Opening a checkout talks to the gateway; a loop here costs the gym.
const payCheckoutLimiter = limiter(20, 'Too many payment attempts. Please wait a few minutes and try again.');

router.get('/api/pay/:token', payPageLimiter, payLinkController.show);
router.post('/api/pay/:token/checkout', payCheckoutLimiter, payLinkController.checkout);
// The same file rules and allowance as the member's own receipt upload
// (helper/upload.js: a photo or a real PDF, at the image size limit;
// publicWriteLimiter: 20 in 15 minutes).
const payProofLimiter = limiter(20, 'Too many receipt uploads. Please wait a few minutes and try again.');
router.post('/api/pay/:token/proof', payProofLimiter, proofUploadSingle('proof'), payLinkController.proof);

// The member's own saved cards. /api/billing is also where the gym's own
// GymsPilotPro subscription lives (platform/routes/billingRoutes.js); none of
// its routes is under /me, so these are reached past it.
router.get('/api/billing/me/saved-methods', auth, payLinkController.listSavedMethods);
router.delete('/api/billing/me/saved-methods/:id', auth, payLinkController.removeSavedMethod);

module.exports = router;
module.exports.payPageLimiter = payPageLimiter;
module.exports.payCheckoutLimiter = payCheckoutLimiter;
module.exports.payProofLimiter = payProofLimiter;
