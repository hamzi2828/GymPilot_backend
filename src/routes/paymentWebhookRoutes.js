// src/routes/paymentWebhookRoutes.js -- mounted at /api/payments (index.js)
//
// Webhooks from payment gateways other than Stripe, one address per gym:
//
//   POST /api/payments/safepay/webhook/:gymSlug
//
// Like Stripe's, these arrive from the gateway's servers with no website
// attached: index.js leaves the body unparsed for them (the signature is
// over the exact bytes sent) and lets them past the tenant gate; the gym is
// read from the slug, and the controller checks the signature with that
// gym's secret.

const express = require('express');
const { tenantFromSlugParam } = require('../platform/middleware/tenantFromPayload');
const paymentWebhookController = require('../controller/paymentWebhookController');

const router = express.Router();

router.post(
  '/safepay/webhook/:gymSlug',
  // Whatever content type Safepay labels it with, the bytes are kept as sent.
  express.raw({ type: () => true, limit: '1mb' }),
  tenantFromSlugParam,
  paymentWebhookController.safepay
);

module.exports = router;
