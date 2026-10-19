// src/platform/services/platformStripe.js
//
// Stripe for the platform itself -- the account GymsPilotPro charges gyms into.
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
    super(message || 'The platform has no Stripe keys yet. Add them under System → Payments.');
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
 * Whether the platform's Stripe account can be used at all: keys saved AND
 * the "charge gyms through Stripe" switch on. The switch is what lets keys
 * sit in the panel, tested, before anyone is sent to a checkout. This is
 * the gate for what Stripe already bills -- the customer portal, a plan
 * change on a running subscription -- and for self-serve sign-up, which
 * always pays by card: choosing another way for gyms to pay never switches
 * it off.
 */
async function platformStripeAvailable() {
  const cfg = await platformStripeConfig();
  if (!cfg.secretKey) return { available: false, reason: 'The platform has no Stripe keys yet. Add them under System → Payments.' };
  if (!cfg.enabled) return { available: false, reason: 'Charging gyms through Stripe is switched off under System → Payments.' };
  return { available: true, reason: '' };
}

/**
 * Whether a gym can START paying the platform by card from its Billing tab:
 * Stripe usable (above) AND Stripe the way gyms pay (System → Payments,
 * services/payments). A platform that never chose reads as Stripe while
 * Stripe is switched on, so it answers as it always did.
 */
async function platformBillingAvailable() {
  const usable = await platformStripeAvailable();
  if (!usable.available) return usable;
  // Required here: the registry's Stripe provider requires this file.
  const { selectedFrom } = require('./payments');
  const { id } = selectedFrom(await PlatformSettings.getSettings());
  if (id !== 'stripe') return { available: false, reason: 'Gyms pay GymsPilotPro another way now, not by card through Stripe (System → Payments).' };
  return usable;
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
  platformStripeAvailable,
  forgetPlatformStripe,
  PlatformStripeNotConfiguredError
};
