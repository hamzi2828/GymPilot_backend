// src/services/payments/providers/safepay.js
//
// Safepay (Pakistan), as one gateway of the registry: the gym's own Safepay
// account, so members pay straight into the gym's bank account. Wraps
// services/safepay, which holds the API calls, the webhook and the saved
// cards.

const safepay = require('../../safepay');
const { storedSafepay } = require('../../safepay/config');
const { frontendOrigin } = require('../../../platform/tenantContext');
const { PaymentGatewayError } = require('../errors');
const { createPendingPurchase, closeUnopened } = require('../purchase');

const UNAVAILABLE = {
  SAFEPAY_NOT_CONFIGURED: 'Online payments are not set up at this gym yet.',
  SAFEPAY_WEBHOOK_NOT_CONFIGURED: 'Online payments are paused while this gym finishes connecting its Safepay account.',
  SAFEPAY_CURRENCY_UNSUPPORTED: "Online payments aren't available in this gym's currency."
};

const CHECKOUT_UNAVAILABLE = "Online payment isn't available at this gym — please choose bank transfer, or pay at the front desk.";

/** Where the member lands after Safepay's page, for an order: the gym site's checkout pages. */
function checkoutReturnUrls(order) {
  const site = String(frontendOrigin() || '').replace(/\/+$/, '');
  const id = encodeURIComponent(String(order._id));
  return {
    returnUrl: `${site}/checkout/success?provider=safepay&order=${id}`,
    cancelUrl: `${site}/checkout/cancel?order=${id}`
  };
}

async function status(settings) {
  const Settings = require('../../../models/settings');
  const s = settings === undefined ? await Settings.getSettings().catch(() => null) : settings;
  const cfg = await safepay.getSafepayConfig({ settings: s });
  let code = null;
  if (!cfg) code = 'SAFEPAY_NOT_CONFIGURED';
  else if (!cfg.ready) code = 'SAFEPAY_WEBHOOK_NOT_CONFIGURED';
  else if (!safepay.SUPPORTED_CURRENCIES.includes(String((s && s.currency) || '').toUpperCase())) code = 'SAFEPAY_CURRENCY_UNSUPPORTED';
  return { available: !code, code, reason: code ? UNAVAILABLE[code] : '' };
}

module.exports = {
  id: 'safepay',
  label: 'Safepay',
  description: 'Pakistan: card, JazzCash, Easypaisa or any bank app (Raast), paid straight into the gym’s own account. Payment links and optional automatic card payments.',
  countries: ['PK'],
  currencies: safepay.SUPPORTED_CURRENCIES,
  checkoutLabel: 'Card, JazzCash, Easypaisa or any bank app',
  settingsKey: 'safepay',
  capabilities: { checkout: true, paymentLinks: true, receiptUpload: false, savedCards: true, autoCharge: true, wallets: true, bankApps: true },
  configFields: [
    { name: 'enabled', label: 'Take online payments through Safepay', type: 'boolean', secret: false, required: true },
    {
      name: 'environment',
      label: 'Environment',
      type: 'select',
      secret: false,
      required: true,
      options: [
        { value: 'sandbox', label: 'Sandbox (test payments)' },
        { value: 'production', label: 'Production (real payments)' }
      ]
    },
    { name: 'publicKey', label: 'API key (public)', type: 'text', secret: false, required: true, placeholder: 'sec_...' },
    { name: 'secretKey', label: 'Secret key', type: 'secret', secret: true, required: true },
    { name: 'webhookSecret', label: 'Webhook shared secret', type: 'secret', secret: true, required: true, help: 'Safepay dashboard → Developers → Endpoints → View shared secret.' }
  ],

  /** Whether a new payment may start: switched on, both keys and the webhook secret, a currency Safepay takes. */
  async isConfigured(settings) {
    return (await status(settings)).available;
  },

  /** { available, code, reason } -- the reason is for members. */
  status,

  async unavailableError(settings) {
    const { available, code } = await status(settings);
    return available ? null : new PaymentGatewayError(CHECKOUT_UNAVAILABLE, code, 409);
  },

  /**
   * Checks keys against Safepay in the chosen environment: a checkout token
   * (the secret key works) and a payment session (the API key belongs to
   * it). The session is never paid and simply expires. Typed values are
   * tested when given, the saved ones otherwise. The webhook secret cannot
   * be checked this way: it is checked on the first event Safepay sends.
   */
  async testConnection({ publicKey, secretKey, environment } = {}) {
    const stored = await storedSafepay();
    const cfg = {
      environment: environment === 'production' || environment === 'sandbox' ? environment : stored.environment,
      publicKey: String(publicKey || '').trim() || stored.publicKey,
      secretKey: String(secretKey || '').trim() || stored.secretKey
    };
    if (!cfg.secretKey) return { success: false, message: 'Enter the Safepay secret key, or save one first.' };
    if (!cfg.publicKey) return { success: false, message: 'Enter the Safepay API key (public), or save one first.' };
    try {
      await safepay.api.createPassport(cfg);
      const { token } = await safepay.api.createTracker(cfg, { amount: 10000, currency: 'PKR', mode: 'payment', orderRef: 'gymspilotpro-connection-test' });
      return {
        success: true,
        message: `Connected to Safepay (${cfg.environment}): both keys work.`,
        data: { environment: cfg.environment, tracker: token }
      };
    } catch (error) {
      return { success: false, message: (error && error.message) || 'Safepay refused the keys.' };
    }
  },

  /**
   * A new purchase: a pending order (payments/purchase.js), then Safepay's
   * hosted checkout for it. The member returns to the gym site's
   * /checkout/success?provider=safepay&order=<orderId>.
   */
  async createPurchaseCheckout({ userId, packageId, customerInfo = {}, couponCode, saveCard = false, autoPayConsent = false }) {
    const unavailable = await this.unavailableError();
    if (unavailable) throw unavailable;
    const order = await createPendingPurchase({ userId, packageId, customerInfo, couponCode, provider: 'safepay' });
    try {
      const result = await safepay.createCheckout({
        order,
        amount: order.payment.amount,
        currency: order.payment.currency,
        customer: { name: customerInfo.fullName, email: customerInfo.email, phone: customerInfo.phone },
        ...checkoutReturnUrls(order),
        saveCard,
        autoPayConsent
      });
      return { url: result.url, orderId: String(order._id), orderNumber: order.orderNumber, reference: result.tracker, tracker: result.tracker, saveCard: result.saveCard };
    } catch (error) {
      await closeUnopened(order, error);
      throw error;
    }
  },

  /** Pays an existing order (or its balance): safepay.createCheckout, `reference` = the tracker. */
  async createCheckout(args = {}) {
    const order = args.order;
    const urls = args.returnUrl && args.cancelUrl ? {} : checkoutReturnUrls(order);
    const result = await safepay.createCheckout({ ...urls, ...args });
    return { ...result, reference: result.tracker };
  },

  /** safepay.chargeSavedMethod, `reference` = the tracker. */
  async chargeSavedMethod(args = {}) {
    const result = await safepay.chargeSavedMethod(args);
    return { ...result, reference: result.tracker };
  },

  /** 'paid' | 'failed' | 'pending' for a tracker. */
  fetchStatus(tracker) {
    return safepay.fetchTrackerStatus(tracker);
  },

  /** The event, checked with `secret` (default: the gym's stored webhook secret). */
  async verifyWebhook(rawBody, headers, secret) {
    const key = secret || (await storedSafepay()).webhookSecret;
    return safepay.verifyWebhook(rawBody, headers, key);
  },

  webhookUrl(apiBase, slug) {
    return `${apiBase}/api/payments/safepay/webhook/${slug || ''}`;
  },

  checkoutReturnUrls
};
