// src/services/safepay/index.js
//
// Safepay (Pakistan): each gym connects its own Safepay account in Settings
// → Payments, and its members pay straight into the gym's bank account by
// card, JazzCash, Easypaisa or a bank app. GymsPilotPro never holds the
// money. Everything here runs for the gym in the current tenant context.
//
// The names below are a contract with the payment-link and auto-charge
// code; keep them. Other code reaches Safepay through the gateway registry
// (services/payments), whose Safepay provider wraps this module.
//
//   getSafepayConfig()            the gym's config, or null
//   createCheckout({ order, amount, currency, customer, returnUrl, cancelUrl,
//                    saveCard, autoPayConsent })        -> { url, tracker, ... }
//   chargeSavedMethod({ order, amount, currency, savedMethod })
//                                 -> { status: 'paid'|'failed'|'pending', tracker, reason }
//   fetchTrackerStatus(tracker)   -> 'paid'|'failed'|'pending'
//   verifyWebhook(rawBody, headers, secret)  -> the event, or throws

const shapes = require('./shapes');
const api = require('./api');
const { getSafepayConfig, storedSafepay } = require('./config');
const payments = require('./payments');
const cards = require('./cards');

module.exports = {
  // The contract.
  getSafepayConfig,
  createCheckout: payments.createCheckout,
  chargeSavedMethod: payments.chargeSavedMethod,
  fetchTrackerStatus: payments.fetchTrackerStatus,
  verifyWebhook: shapes.verifyWebhook,

  // The rest of the connector.
  storedSafepay,
  handleWebhookEvent: payments.handleWebhookEvent,
  verifyOrderPayment: payments.verifyOrderPayment,
  verifyTrackerPayment: payments.verifyTrackerPayment,
  applyTrackerPayment: payments.applyTrackerPayment,
  trackerDetails: payments.trackerDetails,
  autoChargeEnabled: payments.autoChargeEnabled,
  amountDue: payments.amountDue,
  listSavedMethods: cards.listSavedMethods,
  autoPayMethodFor: cards.autoPayMethodFor,
  removeSavedMethod: cards.removeSavedMethod,
  consentTextFor: cards.consentTextFor,
  savedMethodId: cards.savedMethodId,

  // Pure helpers and the HTTP layer, for the provider and the tests.
  SafepayError: shapes.SafepayError,
  SUPPORTED_CURRENCIES: shapes.SUPPORTED_CURRENCIES,
  toSafepayAmount: shapes.toSafepayAmount,
  fromSafepayAmount: shapes.fromSafepayAmount,
  mapTrackerState: shapes.mapTrackerState,
  readEvent: shapes.readEvent,
  api
};
