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
  constructor() {
    super('Card payments are not set up for this gym yet. Add the Stripe keys under Settings → Stripe.');
    this.code = 'STRIPE_NOT_CONFIGURED';
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

/** Whether card payments can be offered to this gym's members right now. */
async function cardPaymentsAvailable() {
  const cfg = await stripeConfig();
  return !!(cfg.secretKey && cfg.enabled);
}

module.exports = { getStripe, stripeConfig, cardPaymentsAvailable, StripeNotConfiguredError, API_VERSION };
