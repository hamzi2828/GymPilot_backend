// src/platform/services/payments/providers/stripe.js
//
// Stripe as a way gyms pay GymsPilotPro: the platform's own Stripe account
// (services/platformStripe.js), exactly as it always worked -- Checkout,
// the customer portal, subscriptions Stripe renews itself, the platform
// webhook. Nothing here changes that; it only describes it for the
// Payments page and says whether the keys are in.

const { getPlatformStripe } = require('../../platformStripe');

module.exports = {
  id: 'stripe',
  label: 'Stripe (international)',
  description: 'Cards worldwide. Stripe renews the subscription itself.',
  checkoutLabel: 'Card',
  settingsKey: 'stripe',
  configFields: [
    { name: 'publishableKey', label: 'Publishable key', type: 'text', required: true, placeholder: 'pk_live_...' },
    { name: 'secretKey', label: 'Secret key', type: 'secret', required: true, placeholder: 'sk_live_...' },
    { name: 'webhookSecret', label: 'Webhook signing secret', type: 'secret', required: true, placeholder: 'whsec_...' }
  ],

  /** Both secrets saved: a checkout can start, and the webhook can record it. */
  isConfigured(settings) {
    const s = (settings && settings.stripe) || {};
    return !!(s.secretKey && s.webhookSecret);
  },

  /** Asks Stripe who the key (typed, else saved) belongs to. */
  async testConnection({ secretKey } = {}) {
    try {
      const stripe = await getPlatformStripe(String(secretKey || '').trim());
      const account = await stripe.accounts.retrieve();
      const name = (account.settings && account.settings.dashboard && account.settings.dashboard.display_name) || (account.business_profile && account.business_profile.name) || account.email || account.id;
      return { success: true, message: `Connected to ${name}.`, data: { accountId: account.id, accountName: name, chargesEnabled: !!account.charges_enabled } };
    } catch (error) {
      return { success: false, message: (error && error.message) || 'Stripe refused those keys' };
    }
  },

  webhookUrl(apiBase) {
    return `${apiBase}/api/platform/stripe/webhook`;
  }
};
