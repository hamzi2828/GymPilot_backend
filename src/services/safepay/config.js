// src/services/safepay/config.js
//
// The current gym's Safepay account, read from its own Settings (Settings →
// Payments). Each gym connects ITS OWN Safepay account: there is no
// platform-wide key and no fallback to another gym's, so a gym that has not
// connected one simply cannot take payments through Safepay yet.

const Settings = require('../../models/settings');

/**
 * The gym's Safepay settings as they are stored (secrets opened), whether or
 * not they are complete: { enabled, environment, publicKey, secretKey,
 * webhookSecret }.
 */
async function storedSafepay(settings) {
  let s = settings;
  if (s === undefined) s = await Settings.getSettings().catch(() => null);
  const block = (s && s.safepay) || {};
  return {
    enabled: !!block.enabled,
    environment: block.environment === 'production' ? 'production' : 'sandbox',
    publicKey: String(block.publicKey || '').trim(),
    secretKey: String(block.secretKey || '').trim(),
    webhookSecret: String(block.webhookSecret || '').trim()
  };
}

/**
 * The current gym's Safepay config, or null when it cannot be used.
 *
 * Usable means switched on with both keys saved. `ready` adds the webhook's
 * shared secret: without it Safepay cannot tell us about a payment made
 * after the member closes the tab, so new payments are only started when it
 * is there (payments/providers/safepay isConfigured).
 *
 * `{ includeDisabled: true }` also returns a gym's keys after it switched
 * Safepay off -- for recording payments members already made (the webhook,
 * the return page), never for starting new ones.
 *
 * @returns {Promise<null|{ enabled, environment, publicKey, secretKey, webhookSecret, ready }>}
 */
async function getSafepayConfig({ includeDisabled = false, settings } = {}) {
  const cfg = await storedSafepay(settings);
  if (!cfg.secretKey || !cfg.publicKey) return null;
  if (!cfg.enabled && !includeDisabled) return null;
  return { ...cfg, ready: !!cfg.webhookSecret };
}

module.exports = { getSafepayConfig, storedSafepay };
