// src/platform/services/platformStripe.js
//
// Stripe for the platform itself -- the account GymPilot charges gyms into.
//
// Deliberately has no environment fallback. The STRIPE_* variables belong to
// the default gym (see services/stripeClient.js), and quietly borrowing them
// here would bill a gym's customers into that gym's own account. The platform
// is configured in the panel or it is not configured at all.

const Stripe = require('stripe');
const PlatformSettings = require('../models/platformSettingsModel');
const { API_VERSION } = require('../../services/stripeClient');

// One client per secret key; keys change rarely.
const clients = new Map();

class PlatformStripeNotConfiguredError extends Error {
  constructor(message) {
    super(message || 'The platform has no Stripe keys yet. Add them under System → Stripe.');
    this.code = 'PLATFORM_STRIPE_NOT_CONFIGURED';
    this.status = 409;
  }
}

/** @returns {Promise<{secretKey, publishableKey, webhookSecret, enabled}>} */
async function platformStripeConfig() {
  const settings = await PlatformSettings.getSettings();
  const s = (settings && settings.stripe) || {};
  return {
    secretKey: s.secretKey || '',
    publishableKey: s.publishableKey || '',
    webhookSecret: s.webhookSecret || '',
    enabled: !!s.enabled
  };
}

/**
 * Whether gyms can pay the platform by card right now: keys saved AND the
 * "charge gyms through Stripe" switch on. The switch is what lets keys sit
 * in the panel, tested, before anyone is sent to a checkout.
 */
async function platformBillingAvailable() {
  const cfg = await platformStripeConfig();
  if (!cfg.secretKey) return { available: false, reason: 'The platform has no Stripe keys yet. Add them under System → Stripe.' };
  if (!cfg.enabled) return { available: false, reason: 'Charging gyms through Stripe is switched off under System → Stripe.' };
  return { available: true, reason: '' };
}

/** A Stripe client on the platform's own account, or throws. */
async function getPlatformStripe(secretKeyOverride) {
  const secretKey = secretKeyOverride || (await platformStripeConfig()).secretKey;
  if (!secretKey) throw new PlatformStripeNotConfiguredError();

  let client = clients.get(secretKey);
  if (!client) {
    client = new Stripe(secretKey, { apiVersion: API_VERSION });
    if (clients.size >= 20) clients.delete(clients.keys().next().value);
    clients.set(secretKey, client);
  }
  return client;
}

/** Drops cached clients, so saved keys take effect on the next call. */
function forgetPlatformStripe() {
  clients.clear();
}

module.exports = {
  getPlatformStripe,
  platformStripeConfig,
  platformBillingAvailable,
  forgetPlatformStripe,
  PlatformStripeNotConfiguredError
};
