// src/platform/services/payments/index.js
//
// How gyms pay GymsPilotPro for their subscription, and which way the super
// admin has chosen -- the platform's twin of src/services/payments (how a
// gym's members pay the gym), read from platform_settings instead of a
// gym's Settings. ONE way at a time (`onlinePayments.provider`):
//
//   generic  bank transfer to GymsPilotPro's accounts + an uploaded receipt,
//            approved by the super admin
//   safepay  GymsPilotPro's own Safepay account (card, JazzCash, Easypaisa,
//            bank apps)
//   stripe   GymsPilotPro's own Stripe account (as it always was)
//   none     the super admin records payments by hand
//
// Choosing never switches Stripe off: a gym Stripe already bills keeps
// being billed (and its webhook keeps landing) whatever is chosen later.
//
// Every provider module has the same shape:
//
//   id, label, description, checkoutLabel (what the gym is shown),
//   settingsKey                  the platform_settings block its fields live in (null: none)
//   configFields                 [{ name, label, type: 'text'|'secret'|'select'|'boolean',
//                                   required, options?, placeholder?, help? }]
//   isConfigured(settings)       -> boolean | Promise<boolean>: set up enough to take a payment
//   testConnection(input, settings) -> Promise<{ success, message, data? }>
//   webhookUrl(apiBase)          -> the address to register with the gateway, or null

const PlatformSettings = require('../../models/platformSettingsModel');

const PROVIDERS = [require('./providers/stripe'), require('./providers/safepay'), require('./providers/generic')];
const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);
// What onlinePayments.provider may be set to.
const CHOICES = ['none', ...PROVIDER_IDS];

function listProviders() {
  return [...PROVIDERS];
}

function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

async function settingsOrRead(settings) {
  if (settings !== undefined && settings !== null) return settings;
  return PlatformSettings.getSettings();
}

/**
 * The way chosen: { id: 'none'|<provider id>, explicit }. Nothing stored
 * (a platform from before the choice existed) reads as Stripe when its
 * "charge gyms through Stripe" switch is on, and 'none' otherwise -- what
 * the Billing tab offered until now.
 */
function selectedFrom(settings) {
  const stored = settings && settings.onlinePayments && settings.onlinePayments.provider;
  if (stored && CHOICES.includes(stored)) return { id: stored, explicit: true };
  return { id: settings && settings.stripe && settings.stripe.enabled ? 'stripe' : 'none', explicit: false };
}

async function selectedProviderId(settings) {
  return selectedFrom(await settingsOrRead(settings));
}

/** The chosen provider when it is set up, else null ('none' is always null). */
async function activeProvider(settings) {
  const s = await settingsOrRead(settings);
  const provider = getProvider(selectedFrom(s).id);
  if (!provider) return null;
  return (await provider.isConfigured(s)) ? provider : null;
}

/**
 * For GET /api/platform/settings/payment-gateways: every way, its fields,
 * whether it is set up and which one is chosen -- the gym side's shape.
 * The gateways' own `enabled` switches are not fields: choosing one sets it.
 */
async function describeProviders({ settings, apiBase = '' } = {}) {
  const s = await settingsOrRead(settings);
  const { id: selected } = selectedFrom(s);
  const data = [];
  for (const provider of PROVIDERS) {
    data.push({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      checkout_label: provider.checkoutLabel,
      settings_key: provider.settingsKey,
      config_fields: provider.configFields.map((field) => ({ ...field, ...(field.options ? { options: field.options.map((o) => ({ ...o })) } : {}) })),
      configured: !!(await Promise.resolve(provider.isConfigured(s)).catch(() => false)),
      selected: provider.id === selected,
      webhook_url: apiBase ? provider.webhookUrl(apiBase) : null
    });
  }
  return { data, selected };
}

module.exports = {
  PROVIDER_IDS,
  CHOICES,
  listProviders,
  getProvider,
  selectedFrom,
  selectedProviderId,
  activeProvider,
  describeProviders
};
