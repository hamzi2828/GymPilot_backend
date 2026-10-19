// src/controller/paymentWebhookController.js
//
// Payment gateways other than Stripe telling us about payments. Stripe's
// webhook stays where it always was (gymfolioPaymentController.handleWebhook).
//
// The gym is already in context, from the slug in the address each gym
// registers in its own gateway account (tenantFromSlugParam). The event is
// believed only if it is signed with THAT gym's webhook secret: an event for
// another gym, or signed by anyone else, is refused.

const safepay = require('../services/safepay');
const payments = require('../services/payments');
const { storedSafepay } = require('../services/safepay/config');
const { currentTenantSlug } = require('../platform/tenantContext');

const paymentWebhookController = {
  /**
   * POST /api/payments/safepay/webhook/:gymSlug
   *
   * Body: the raw bytes Safepay sent (express.raw), checked against the
   * X-SFPY-SIGNATURE header with the gym's Safepay webhook secret. Answers:
   *   200 { received: true, applied?, ignored? }   acknowledged (a payment
   *       delivered twice is applied once)
   *   400 bad or missing signature, or not JSON -- not acknowledged
   *   409 the payment is being recorded by another request right now:
   *       Safepay sends it again later
   *   500 the gym has no webhook secret saved, or recording failed:
   *       Safepay sends it again later
   */
  async safepay(req, res) {
    const slug = currentTenantSlug() || req.params.gymSlug;
    try {
      const { webhookSecret } = await storedSafepay();
      if (!webhookSecret) {
        console.error(`[safepay] webhook for ${slug} refused: no Safepay webhook secret saved under Settings → Payments`);
        return res.status(500).json({ received: false, message: 'Webhook secret not configured' });
      }

      let event;
      try {
        event = await payments.getProvider('safepay').verifyWebhook(req.body, req.headers, webhookSecret);
      } catch (error) {
        console.warn(`[safepay] webhook for ${slug} refused: ${error.message}`);
        return res.status(error.status === 409 ? 500 : 400).json({ received: false, message: error.message });
      }

      const result = await safepay.handleWebhookEvent(event);
      return res.status(200).json(result);
    } catch (error) {
      // Another request is recording this very payment, or the balance moved
      // under it: nothing is lost, the event is simply sent again later.
      if (error && (error.code === 'ACTIVATION_IN_PROGRESS' || error.code === 'BALANCE_CHANGED')) {
        return res.status(409).json({ received: false, inProgress: true, message: error.message });
      }
      console.error(`[safepay] webhook for ${slug} failed:`, error);
      return res.status(500).json({ received: false, message: 'Webhook handler failed' });
    }
  }
};

module.exports = paymentWebhookController;
