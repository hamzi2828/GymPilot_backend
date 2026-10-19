// src/services/billing/provider.js
//
// The one door from the billing side (payment links, the reminders job,
// automatic charges) to whichever online payment gateway the gym has chosen.
//
// Gateways are pluggable and picked per gym (Settings → Payments): the
// registry in services/payments/ answers `activeProvider()` -- the gym's
// chosen gateway when it is also fully configured, else null. Nothing here
// names a gateway: a payment link opens a checkout through that provider,
// and the due-date charge uses it only when it says it can
// (`capabilities.autoCharge`). With no provider, a payment link still works
// as a page showing the gym's bank / Raast details, and no card is charged.
//
// The registry is required lazily, so this file loads on its own; a test
// swaps the provider with setProviderForTests() instead of reaching a
// gateway.

const path = require('path');

const REGISTRY = path.join(__dirname, '..', 'payments');

// What a member reads on the "Pay now" button, by gateway, when the
// provider does not say so itself.
const MEMBER_LABELS = {
  safepay: 'Card, JazzCash, Easypaisa or any bank app',
  stripe: 'Card'
};

let override; // undefined: the real registry. null or a provider (or a function giving one): a test's.

/** Tests only: what activeProvider() answers from now on; undefined restores the registry. */
function setProviderForTests(provider) {
  override = provider;
}

function loadRegistry() {
  try {
    return require(REGISTRY);
  } catch (error) {
    // Only the registry itself being absent means "no gateways here"; a
    // broken module inside it is a real failure and is reported as one.
    const stack = (error && error.requireStack) || [];
    if (error && error.code === 'MODULE_NOT_FOUND' && stack[0] === __filename) return null;
    throw error;
  }
}

/**
 * The gym's online payment gateway, ready to take a payment, or null.
 * Never throws: a gateway that cannot be read is no gateway, and the member
 * is shown the other ways to pay.
 */
async function activeProvider() {
  if (override !== undefined) return (typeof override === 'function' ? await override() : override) || null;
  try {
    const registry = loadRegistry();
    if (!registry || typeof registry.activeProvider !== 'function') return null;
    return (await registry.activeProvider()) || null;
  } catch (error) {
    console.error('[billing] could not read the payment gateway:', error.message);
    return null;
  }
}

function capabilities(provider) {
  return (provider && provider.capabilities) || {};
}

/** Whether a provider can open a checkout a member pays on. */
function canCheckout(provider) {
  return !!provider && typeof provider.createCheckout === 'function' && capabilities(provider).checkout !== false;
}

/** Whether a provider can charge a saved card without the member present. */
function canAutoCharge(provider) {
  return !!provider && typeof provider.chargeSavedMethod === 'function' && capabilities(provider).autoCharge === true;
}

/** Whether a provider can keep a card for later (the "save my card" box). */
function canSaveCards(provider) {
  const caps = capabilities(provider);
  return !!provider && (caps.savedCards === true || caps.autoCharge === true);
}

/** What the member is told they can pay with online. */
function onlineLabel(provider) {
  if (!provider) return null;
  return provider.memberLabel || provider.onlineLabel || MEMBER_LABELS[provider.id] || provider.label || 'Pay online';
}

module.exports = {
  activeProvider,
  canCheckout,
  canAutoCharge,
  canSaveCards,
  onlineLabel,
  setProviderForTests,
  MEMBER_LABELS
};
