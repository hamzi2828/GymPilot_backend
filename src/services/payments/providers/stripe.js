// src/services/payments/providers/stripe.js
//
// Stripe, as one gateway of the registry. It wraps the existing Stripe code
// and changes none of it: a gym that chooses Stripe sells exactly as it
// always has (gymfolioPaymentService: Checkout sessions, subscriptions that
// Stripe renews itself, the Stripe webhook). Stripe renews its own
// subscriptions, so it offers no payment links or saved-card charges here.

const stripeClient = require('../../stripeClient');
const { PaymentGatewayError } = require('../errors');

const CARD_UNAVAILABLE = {
  STRIPE_NOT_CONFIGURED: 'Card payments are not set up at this gym yet.',
  STRIPE_WEBHOOK_NOT_CONFIGURED: 'Card payments are paused while this gym finishes connecting its Stripe account.'
};

function unsupported(what) {
  return new PaymentGatewayError(`${what} is not offered with Stripe: Stripe renews its own subscriptions.`, 'GATEWAY_UNSUPPORTED', 409);
}

module.exports = {
  id: 'stripe',
  label: 'Stripe',
  description: 'Cards worldwide. Subscriptions are renewed by Stripe itself.',
  // Stripe serves many countries; it is not limited to a list here.
  countries: [],
  checkoutLabel: 'Card',
  settingsKey: 'stripe',
  capabilities: { checkout: true, paymentLinks: false, receiptUpload: false, savedCards: false, autoCharge: false, wallets: false, bankApps: false },
  configFields: [
    { name: 'enabled', label: 'Take card payments through Stripe', type: 'boolean', secret: false, required: true },
    { name: 'publishableKey', label: 'Publishable key', type: 'text', secret: false, required: true, placeholder: 'pk_live_...' },
    { name: 'secretKey', label: 'Secret key', type: 'secret', secret: true, required: true, placeholder: 'sk_live_...' },
    { name: 'webhookSecret', label: 'Webhook signing secret', type: 'secret', secret: true, required: true, placeholder: 'whsec_...' }
  ],

  /** Whether a new card sale may start: keys and the webhook secret (stripeClient). */
  async isConfigured() {
    return (await stripeClient.cardPaymentsStatus()).available;
  },

  /** { available, code, reason } -- the reason is for members. */
  async status() {
    const status = await stripeClient.cardPaymentsStatus().catch(() => ({ available: false, code: 'STRIPE_NOT_CONFIGURED' }));
    return { available: !!status.available, code: status.available ? null : status.code, reason: status.available ? '' : status.reason || CARD_UNAVAILABLE[status.code] || CARD_UNAVAILABLE.STRIPE_NOT_CONFIGURED };
  },

  /** The error a checkout answers with while Stripe cannot take a sale -- the one it always gave. */
  async unavailableError() {
    try {
      await stripeClient.assertCardPaymentsAvailable();
    } catch (error) {
      return error;
    }
    return null;
  },

  /** Proves a secret key (typed, or the stored one) reaches a Stripe account. */
  async testConnection({ secretKey } = {}) {
    const Stripe = require('stripe');
    const key = String(secretKey || '').trim() || (await stripeClient.stripeConfig()).secretKey || '';
    if (!key) return { success: false, message: 'Enter a Stripe secret key, or save one first.' };
    try {
      const stripe = new Stripe(key, { apiVersion: stripeClient.API_VERSION });
      const account = await stripe.accounts.retrieve();
      const accountName =
        (account.settings && account.settings.dashboard && account.settings.dashboard.display_name) ||
        (account.business_profile && account.business_profile.name) ||
        account.email ||
        account.id;
      return { success: true, message: `Connected to ${accountName}`, data: { accountId: account.id, accountName, chargesEnabled: !!account.charges_enabled } };
    } catch (error) {
      return { success: false, message: (error && error.message) || 'Stripe rejected the key' };
    }
  },

  /**
   * A new purchase: exactly the Stripe Checkout the gym always had
   * (gymfolioPaymentService.createPackageCheckoutSession). Saving a card is
   * Stripe's own business there; saveCard is not used.
   */
  async createPurchaseCheckout({ userId, packageId, customerInfo, couponCode }) {
    const service = require('../../gymfolioPaymentService');
    const session = await service.createPackageCheckoutSession(userId, packageId, customerInfo, { couponCode });
    return { url: session.url, sessionId: session.sessionId, orderNumber: session.orderNumber, reference: session.sessionId };
  },

  async createCheckout() {
    throw unsupported('Paying an existing order by link');
  },

  async chargeSavedMethod() {
    return { status: 'failed', reference: null, tracker: null, reason: 'Stripe renews its own subscriptions; saved cards are not charged here.', code: 'GATEWAY_UNSUPPORTED' };
  },

  /** A Checkout session's state: 'paid' | 'failed' | 'pending'. */
  async fetchStatus(sessionId) {
    const stripe = await stripeClient.getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return 'paid';
    if (session.status === 'expired') return 'failed';
    return 'pending';
  },

  /** A Stripe event, checked against the gym's signing secret (or `secret`). */
  async verifyWebhook(rawBody, headers, secret) {
    const signingSecret = secret || (await stripeClient.stripeConfig()).webhookSecret;
    if (!signingSecret) throw new PaymentGatewayError('Webhook secret not configured', 'STRIPE_WEBHOOK_NOT_CONFIGURED', 409);
    const stripe = await stripeClient.getStripe();
    const signature = headers && (headers['stripe-signature'] || headers['Stripe-Signature']);
    return stripe.webhooks.constructEvent(rawBody, signature, signingSecret);
  },

  webhookUrl(apiBase, slug) {
    return slug ? `${apiBase}/api/gymfolio/payment/webhook/${slug}` : `${apiBase}/api/gymfolio/payment/webhook`;
  }
};
