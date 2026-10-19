// src/platform/services/payments/providers/safepay.js
//
// Safepay (Pakistan) as a way gyms pay GymsPilotPro: GymsPilotPro's OWN
// Safepay account, keys in platform_settings.safepay -- never a gym's, which
// are for its members' money (services/safepay/config.js). The HTTP calls
// are the gym connector's (services/safepay), handed these keys explicitly.

const safepay = require('../../../../services/safepay');

/** The keys as stored (secrets opened), complete or not. */
function storedOf(settings) {
  return safepay.storedSafepay(settings || null);
}

module.exports = {
  id: 'safepay',
  label: 'Safepay (Pakistan)',
  description: 'Card, JazzCash, Easypaisa or any bank app, into GymsPilotPro’s Safepay account.',
  checkoutLabel: 'Card, JazzCash, Easypaisa or any bank app',
  settingsKey: 'safepay',
  configFields: [
    {
      name: 'environment',
      label: 'Mode',
      type: 'select',
      required: true,
      options: [
        { value: 'sandbox', label: 'Test' },
        { value: 'production', label: 'Live' }
      ]
    },
    { name: 'publicKey', label: 'Public key', type: 'text', required: true, placeholder: 'sec_...' },
    { name: 'secretKey', label: 'Secret key', type: 'secret', required: true },
    { name: 'webhookSecret', label: 'Webhook secret', type: 'secret', required: true, help: 'Safepay dashboard → Developers → Endpoints → View shared secret.' }
  ],

  /** Both keys and the webhook secret saved. */
  async isConfigured(settings) {
    const cfg = await storedOf(settings);
    return !!(cfg.publicKey && cfg.secretKey && cfg.webhookSecret);
  },

  /**
   * A checkout token (the secret key works) and a payment session that is
   * never paid (the public key belongs to it), in the chosen mode. Typed
   * values are tested when given, the saved ones otherwise.
   */
  async testConnection({ publicKey, secretKey, environment } = {}, settings) {
    const stored = await storedOf(settings);
    const cfg = {
      environment: environment === 'production' || environment === 'sandbox' ? environment : stored.environment,
      publicKey: String(publicKey || '').trim() || stored.publicKey,
      secretKey: String(secretKey || '').trim() || stored.secretKey
    };
    if (!cfg.secretKey) return { success: false, message: 'Enter the Safepay secret key, or save one first.' };
    if (!cfg.publicKey) return { success: false, message: 'Enter the Safepay public key, or save one first.' };
    try {
      await safepay.api.createPassport(cfg);
      await safepay.api.createTracker(cfg, { amount: 10000, currency: 'PKR', mode: 'payment', orderRef: 'gymspilotpro-platform-test' });
      return { success: true, message: `Connected to Safepay (${cfg.environment === 'production' ? 'live' : 'test'}): both keys work.`, data: { environment: cfg.environment } };
    } catch (error) {
      return { success: false, message: (error && error.message) || 'Safepay refused the keys.' };
    }
  },

  webhookUrl(apiBase) {
    return `${apiBase}/api/platform/safepay/webhook`;
  }
};
