// src/platform/middleware/tenantFromPayload.js
//
// Two requests arrive with no website attached: Google's OAuth redirect and
// Stripe's webhook. Both are sent by a third party to the API's own address,
// so neither the Origin nor the Host says which gym they concern. Each
// carries the answer in its payload instead -- the slug we put there when
// the flow began -- and these middlewares read it back.
//
// In both cases the slug only SELECTS a gym. What follows is still gated the
// same way it always was: Google's code exchange must succeed, Stripe's
// signature must verify against that gym's secret.

const Gym = require('../models/gymModel');
const { findGymBySlug } = require('./resolveTenant');
const { getTenantConnection } = require('../connections');
const { storage, originForHost, primaryHost } = require('../tenantContext');

// A gym's Stripe webhook records money its members have ALREADY paid, into
// the gym's own Stripe account: a renewal, a failed card, a cancellation.
// None of that stops because the gym's own GymsPilotPro subscription lapsed --
// Stripe goes on charging its members either way -- and an event
// acknowledged but not applied is lost for good. So a lapsed gym
// (SUBSCRIPTION_INACTIVE, the block its owner lifts by paying) still has its
// webhooks applied; nothing else about the gym is served. A suspended gym is
// a platform decision, so its events are refused with a 503 instead: Stripe
// retries them for up to three days, and they land if it is reinstated
// within that time.
const WEBHOOK_SERVED_WHILE_LAPSED = new Set(['SUBSCRIPTION_INACTIVE']);

function refuseWebhookForNow(res, gym, blocked) {
  console.warn(`[webhook] payment webhook for ${gym.slug} refused (${blocked.code}); the gateway will retry`);
  return res.status(503).json({ received: false, code: blocked.code, message: 'This gym is not being served right now; retry later.' });
}

async function contextForSlug(req, slug, { allowDefault = true, allowLapsed = false } = {}) {
  let gym = slug ? await findGymBySlug(slug) : null;
  if (!gym && allowDefault && process.env.DEFAULT_TENANT_SLUG) {
    gym = await findGymBySlug(process.env.DEFAULT_TENANT_SLUG);
  }
  if (!gym) return { gym: null };

  const blocked = Gym.accessBlock(gym);
  if (blocked && !(allowLapsed && WEBHOOK_SERVED_WHILE_LAPSED.has(blocked.code))) return { gym, blocked };

  const connection = await getTenantConnection(gym);
  req.tenant = gym;
  req.tenantConnection = connection;
  req.tenantHost = null;
  req.tenantSource = 'payload';

  const host = primaryHost(gym);
  return {
    gym,
    store: { gym, connection, host, origin: host ? originForHost(host) : null, source: 'payload' }
  };
}

/**
 * GET /auth/google/callback -- the gym slug rides in the OAuth `state` that
 * startGoogleOAuth wrote (see userController).
 */
async function tenantFromOAuthState(req, res, next) {
  let slug = null;
  try {
    const data = JSON.parse(decodeURIComponent(req.query.state || '{}'));
    slug = data && data.tenant ? String(data.tenant) : null;
  } catch {
    slug = null;
  }

  try {
    const { gym, blocked, store } = await contextForSlug(req, slug);
    if (!gym) return res.status(400).send('Could not tell which gym this sign-in belongs to.');
    if (blocked) return res.status(blocked.status).send(blocked.message);
    return storage.run(store, () => next());
  } catch (error) {
    console.error('[tenant] OAuth callback resolution failed:', error);
    return res.status(500).send('Sign-in failed. Please try again.');
  }
}

/**
 * POST /api/gymfolio/payment/webhook -- the slug is in the Checkout Session's
 * (and its PaymentIntent's) metadata, written when the session was created.
 *
 * The body is still the raw bytes here (express.raw runs first); it is parsed
 * once, unverified, purely to find the slug. Signature verification happens
 * in the controller, against the secret of the gym found.
 */
async function tenantFromStripeWebhook(req, res, next) {
  let slug = null;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
    const event = raw ? JSON.parse(raw) : null;
    const object = event && event.data && event.data.object;
    slug = object && object.metadata && object.metadata.tenantSlug ? String(object.metadata.tenantSlug) : null;
  } catch {
    slug = null;
  }

  try {
    const { gym, blocked, store } = await contextForSlug(req, slug, { allowLapsed: true });
    if (!gym) {
      // Acknowledged, not processed: a 4xx would make Stripe retry an event
      // that can never be routed.
      console.warn('[stripe] webhook event carries no known gym; ignored');
      return res.json({ received: true, ignored: 'no gym in event metadata' });
    }
    if (blocked) return refuseWebhookForNow(res, gym, blocked);
    return storage.run(store, () => next());
  } catch (error) {
    console.error('[tenant] webhook resolution failed:', error);
    return res.status(500).json({ success: false, message: 'Webhook handler failed' });
  }
}

/**
 * POST /api/gymfolio/payment/webhook/:slug -- each gym has its own webhook
 * URL registered in its own Stripe account, so the gym is right there in
 * the path. Signature verification (against that gym's secret) follows in
 * the controller. The same for POST /api/payments/safepay/webhook/:gymSlug,
 * registered in the gym's own Safepay account.
 */
async function tenantFromSlugParam(req, res, next) {
  try {
    const slug = req.params.slug || req.params.gymSlug;
    const { gym, blocked, store } = await contextForSlug(req, slug, { allowDefault: false, allowLapsed: true });
    if (!gym) return res.status(404).json({ received: false, message: 'Unknown gym' });
    if (blocked) return refuseWebhookForNow(res, gym, blocked);
    return storage.run(store, () => next());
  } catch (error) {
    console.error('[tenant] webhook slug resolution failed:', error);
    return res.status(500).json({ success: false, message: 'Webhook handler failed' });
  }
}

module.exports = { tenantFromOAuthState, tenantFromStripeWebhook, tenantFromSlugParam };
