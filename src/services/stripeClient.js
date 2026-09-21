// src/services/stripeClient.js
//
// Stripe, per gym.
//
// Every gym on the platform sells memberships into its OWN Stripe account:
// the keys live in that gym's Settings (Settings → Stripe) and the client is
// built from them on demand.
//
// The environment's STRIPE_* keys are the platform's own. They apply to
// exactly one gym -- the one a single-gym deployment defaults to
// (DEFAULT_TENANT_SLUG) -- and for that gym they take precedence, so the
// deployment that existed before the platform keeps charging the account it
// always did. They are never a silent fallback for any other gym: a gym that
// has not set its keys up simply cannot take cards yet, rather than sending
// its members' money to the wrong account.

const Stripe = require('stripe');
const Settings = require('../models/settings');
const { currentTenant } = require('../platform/tenantContext');

// Before raising this to 2025-09-30.clover or later: from that version new
// subscriptions default to Stripe's flexible billing mode, where a trial does
// not move the billing date, and freezes (membershipService.pushStripeCharge,
// which moves the next charge with trial_end) are refused on them. Checkout
// subscriptions must then set `billing_mode: { type: 'classic' }` (in
// gymfolioPaymentService's subscription_data) to keep freezing possible.
const API_VERSION = '2023-10-16';

// One client per secret key. Keys change rarely; clients are cheap but not
// free to build on every request.
const clients = new Map(); // secretKey -> Stripe
const MAX_CLIENTS = 200;

function envKeysApplyHere() {
  const gym = currentTenant();
  const defaultSlug = process.env.DEFAULT_TENANT_SLUG;
  return !!(gym && defaultSlug && gym.slug === defaultSlug);
}

/**
 * The effective Stripe configuration for the gym in context.
 *
 * @returns {Promise<{secretKey: string, webhookSecret: string, publishableKey: string, source: 'gym'|'env'|'none', enabled: boolean}>}
 */
async function stripeConfig() {
  let settings = null;
  try {
    settings = await Settings.getSettings();
  } catch {
    settings = null;
  }
  const s = (settings && settings.stripe) || {};

  if (envKeysApplyHere() && process.env.STRIPE_SECRET_KEY) {
    return {
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || s.webhookSecret || '',
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || s.publishableKey || '',
      source: 'env',
      enabled: true
    };
  }

  if (s.enabled && s.secretKey) {
    return {
      secretKey: s.secretKey,
      webhookSecret: s.webhookSecret || '',
      publishableKey: s.publishableKey || '',
      source: 'gym',
      enabled: true
    };
  }

  return { secretKey: '', webhookSecret: '', publishableKey: '', source: 'none', enabled: false };
}

class StripeNotConfiguredError extends Error {
  constructor(message, code = 'STRIPE_NOT_CONFIGURED') {
    super(message || 'Card payments are not set up for this gym yet. Add the Stripe keys under Settings → Stripe.');
    this.code = code;
    this.status = 409;
  }
}

/** A Stripe client for the gym in context, or throws StripeNotConfiguredError. */
async function getStripe() {
  const cfg = await stripeConfig();
  if (!cfg.secretKey) throw new StripeNotConfiguredError();

  let client = clients.get(cfg.secretKey);
  if (!client) {
    client = new Stripe(cfg.secretKey, { apiVersion: API_VERSION });
    if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value);
    clients.set(cfg.secretKey, client);
  }
  return client;
}

// Why a gym cannot sell by card, in words its members can read. What the
// gym's staff must do about it is on Settings → Stripe.
const CARD_UNAVAILABLE = {
  STRIPE_NOT_CONFIGURED: 'Card payments are not set up at this gym yet.',
  STRIPE_WEBHOOK_NOT_CONFIGURED: 'Card payments are paused while this gym finishes connecting its Stripe account.'
};

/**
 * Whether card payments can be offered to this gym's members right now, and
 * if not, why.
 *
 * Keys alone are not enough: without the webhook signing secret Stripe
 * cannot tell us about anything that happens after the checkout page. A
 * subscription would then be recorded for its first term only (invoice.paid
 * never lands, so the member expires while Stripe keeps charging them), and
 * a buyer who closes the tab before the success page stays pending for
 * good. For the default gym the environment's STRIPE_WEBHOOK_SECRET counts,
 * exactly as stripeConfig() resolves it.
 *
 * @returns {Promise<{ available: boolean, code: string|null, reason: string }>}
 */
async function cardPaymentsStatus() {
  const cfg = await stripeConfig();
  if (!(cfg.secretKey && cfg.enabled)) {
    return { available: false, code: 'STRIPE_NOT_CONFIGURED', reason: CARD_UNAVAILABLE.STRIPE_NOT_CONFIGURED };
  }
  if (!cfg.webhookSecret) {
    return { available: false, code: 'STRIPE_WEBHOOK_NOT_CONFIGURED', reason: CARD_UNAVAILABLE.STRIPE_WEBHOOK_NOT_CONFIGURED };
  }
  return { available: true, code: null, reason: '' };
}

/** Whether card payments can be offered to this gym's members right now. */
async function cardPaymentsAvailable() {
  return (await cardPaymentsStatus()).available;
}

/**
 * Throws StripeNotConfiguredError unless a new card sale may start. Only
 * new sales are gated: verifying, refunding and cancelling what was already
 * sold keep working on the keys alone.
 */
async function assertCardPaymentsAvailable() {
  const { available, code } = await cardPaymentsStatus();
  if (available) return;
  if (code === 'STRIPE_WEBHOOK_NOT_CONFIGURED') {
    throw new StripeNotConfiguredError(
      'Card payments are not available yet: this gym has not finished connecting Stripe (the webhook signing secret is missing under Settings → Stripe).',
      code
    );
  }
  throw new StripeNotConfiguredError();
}

module.exports = {
  getStripe,
  stripeConfig,
  cardPaymentsAvailable,
  cardPaymentsStatus,
  assertCardPaymentsAvailable,
  StripeNotConfiguredError,
  API_VERSION
};
