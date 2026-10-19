// src/services/payments/index.js
//
// The payment gateways a gym can take online payments through, and which
// one it has chosen. A gym uses ONE gateway at a time (Settings → Payments,
// `onlinePayments.provider`): Stripe for gyms outside Pakistan, Safepay in
// Pakistan, "generic" (bank transfer with an uploaded receipt) anywhere,
// more later. Checkout, payment links and automatic charges go
// through activeProvider() and never call a gateway directly, so adding a
// gateway is adding one module to ./providers and to PROVIDERS below.
//
// Every provider module has the same shape:
//
//   id, label, description, countries (['*'] or [] = not limited),
//   checkoutLabel, settingsKey  the Settings block its fields live in (null: none)
//   capabilities                { checkout, paymentLinks, receiptUpload,
//                                 savedCards, autoCharge, wallets, bankApps }
//   configFields                [{ name, label, type: 'text'|'secret'|
//                                 'select'|'boolean', secret, required,
//                                 options?, placeholder?, help? }]
//   isConfigured(settings?)     -> Promise<boolean>: may a new payment start
//   status(settings?)           -> Promise<{ available, code, reason }>
//   unavailableError(settings?) -> Promise<Error|null>: what a checkout
//                                  answers while it cannot take payments
//   testConnection(input?)      -> Promise<{ success, message, data? }>
//   createPurchaseCheckout({ userId, packageId, customerInfo, couponCode,
//                            saveCard, autoPayConsent })
//                               -> Promise<{ url, orderNumber, reference, orderId?, sessionId? }>
//   createCheckout({ order, amount, currency, customer, returnUrl,
//                    cancelUrl, saveCard, autoPayConsent })
//                               -> Promise<{ url, reference, ... }>  (may throw GATEWAY_UNSUPPORTED)
//   chargeSavedMethod({ order, amount, currency, savedMethod })
//                               -> Promise<{ status: 'paid'|'failed'|'pending', reference, reason, code? }>
//   fetchStatus(reference)      -> Promise<'paid'|'failed'|'pending'>
//   verifyOrder(order, { reference? })  (optional; gateways paid against an
//                                  order) -> Promise<{ paid, order }> for the
//                                  checkout success page
//   verifyWebhook(rawBody, headers, secret?) -> Promise<event>  (throws when not genuine)
//   webhookUrl(apiBase, slug)   -> the address the gym registers with the gateway

const Settings = require('../../models/settings');
const { PaymentGatewayError } = require('./errors');
const { gymSiteOrigin } = require('./site');

const PROVIDERS = [require('./providers/stripe'), require('./providers/safepay'), require('./providers/generic')];
const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);
// What onlinePayments.provider may be set to.
const CHOICES = ['none', ...PROVIDER_IDS];

const OFF_REASON = 'This gym does not take payments online.';
const OFF_CHECKOUT = "Online payment isn't available at this gym — please choose bank transfer, or pay at the front desk.";

function listProviders() {
  return [...PROVIDERS];
}

function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

async function settingsOrRead(settings) {
  if (settings !== undefined) return settings;
  return Settings.getSettings().catch(() => null);
}

/**
 * The gateway the gym has chosen: { id: 'none'|<provider id>, explicit }.
 * A gym from before the choice existed has none stored and reads as Stripe
 * when Stripe is on for it (its own switch, or the environment keys the
 * single-gym deployment used) and 'none' otherwise.
 */
async function selectedProviderId(settings) {
  const s = await settingsOrRead(settings);
  const stored = s && s.onlinePayments && s.onlinePayments.provider;
  if (stored && CHOICES.includes(stored)) return { id: stored, explicit: true };
  let stripeOn = !!(s && s.stripe && s.stripe.enabled);
  if (!stripeOn) {
    const { stripeConfig } = require('../stripeClient');
    stripeOn = (await stripeConfig().catch(() => ({ source: 'none' }))).source === 'env';
  }
  return { id: stripeOn ? 'stripe' : 'none', explicit: false };
}

/** The chosen gateway's module, set up or not; null for 'none'. */
async function chosenProvider(settings) {
  const { id } = await selectedProviderId(settings);
  return getProvider(id);
}

/** The gateway new online payments go through: chosen AND set up, else null. */
async function activeProvider(settings) {
  const s = await settingsOrRead(settings);
  const provider = await chosenProvider(s);
  if (!provider) return null;
  return (await provider.isConfigured(s)) ? provider : null;
}

/**
 * Whether members can pay online right now, and how:
 * { provider: id|null, available, checkout, code, reason, label }.
 * `checkout`: the gateway takes the payment on its own page (Stripe,
 * Safepay); the generic gateway is available without one -- members use
 * the bank-transfer checkout. A gym that never chose is answered by
 * Stripe, as it always was.
 */
async function onlineStatus(settings) {
  const s = await settingsOrRead(settings);
  const { id, explicit } = await selectedProviderId(s);
  const provider = getProvider(id) || (!explicit ? getProvider('stripe') : null);
  if (!provider) return { provider: null, available: false, checkout: false, code: 'ONLINE_PAYMENTS_OFF', reason: OFF_REASON, label: '' };
  const status = await provider.status(s);
  return {
    provider: provider.id,
    available: !!status.available,
    checkout: !!(status.available && provider.capabilities.checkout),
    autoCharge: !!provider.capabilities.autoCharge,
    code: status.code || null,
    reason: status.reason || '',
    label: provider.checkoutLabel
  };
}

/**
 * The gateway a new purchase goes through, or the error to answer with.
 * A gym that never chose and has no Stripe gets Stripe's own refusal, as it
 * always did; one that switched online payments off is told so.
 */
async function providerForCheckout(settings) {
  const s = await settingsOrRead(settings);
  const active = await activeProvider(s);
  if (active) return active;
  const { id, explicit } = await selectedProviderId(s);
  const chosen = getProvider(id) || (!explicit ? getProvider('stripe') : null);
  const error = chosen ? await chosen.unavailableError(s) : null;
  throw error || new PaymentGatewayError(OFF_CHECKOUT, 'ONLINE_PAYMENTS_OFF', 409);
}

/** For GET /settings/payment-gateways: every gateway, what it does, its fields, whether set up and chosen. */
async function describeProviders({ settings, apiBase = '', slug = '' } = {}) {
  const s = await settingsOrRead(settings);
  const { id: selected } = await selectedProviderId(s);
  const rows = [];
  for (const provider of PROVIDERS) {
    rows.push({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      countries: provider.countries,
      checkout_label: provider.checkoutLabel,
      capabilities: { ...provider.capabilities },
      settings_key: provider.settingsKey,
      config_fields: provider.configFields.map((field) => ({ ...field })),
      configured: await provider.isConfigured(s).catch(() => false),
      selected: provider.id === selected,
      webhook_url: apiBase ? provider.webhookUrl(apiBase, slug) : null
    });
  }
  return { data: rows, selected };
}

module.exports = {
  PROVIDER_IDS,
  CHOICES,
  PaymentGatewayError,
  gymSiteOrigin,
  listProviders,
  getProvider,
  selectedProviderId,
  chosenProvider,
  activeProvider,
  onlineStatus,
  providerForCheckout,
  describeProviders
};
