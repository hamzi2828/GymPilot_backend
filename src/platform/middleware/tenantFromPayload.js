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

async function contextForSlug(req, slug, { allowDefault = true } = {}) {
  let gym = slug ? await findGymBySlug(slug) : null;
  if (!gym && allowDefault && process.env.DEFAULT_TENANT_SLUG) {
    gym = await findGymBySlug(process.env.DEFAULT_TENANT_SLUG);
  }
  if (!gym) return { gym: null };

  const blocked = Gym.accessBlock(gym);
  if (blocked) return { gym, blocked };

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
    const { gym, blocked, store } = await contextForSlug(req, slug);
    if (!gym) {
      // Acknowledged, not processed: a 4xx would make Stripe retry an event
      // that can never be routed.
      console.warn('[stripe] webhook event carries no known gym; ignored');
      return res.json({ received: true, ignored: 'no gym in event metadata' });
    }
    if (blocked) {
      console.warn(`[stripe] webhook for ${gym.slug} ignored: ${blocked.code}`);
      return res.json({ received: true, ignored: blocked.code });
    }
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
 * the controller.
 */
async function tenantFromSlugParam(req, res, next) {
  try {
    const { gym, blocked, store } = await contextForSlug(req, req.params.slug, { allowDefault: false });
    if (!gym) return res.status(404).json({ received: false, message: 'Unknown gym' });
    if (blocked) {
      console.warn(`[stripe] webhook for ${gym.slug} ignored: ${blocked.code}`);
      return res.json({ received: true, ignored: blocked.code });
    }
    return storage.run(store, () => next());
  } catch (error) {
    console.error('[tenant] webhook slug resolution failed:', error);
    return res.status(500).json({ success: false, message: 'Webhook handler failed' });
  }
}

module.exports = { tenantFromOAuthState, tenantFromStripeWebhook, tenantFromSlugParam };
