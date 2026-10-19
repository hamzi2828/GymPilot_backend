// src/services/billing/savedMethods.js
//
// The cards a member saved, with their consent, to be charged on each due
// date: `user.billing.savedMethods[]` (written by the gateway when a
// checkout saves a card; `select: false` on the user). Never card data --
// the gateway's token for the card (sealed at rest), and what may be shown:
// brand, last four digits, expiry, when and to what the member agreed.
//
// Listing and removing go through the gateway connector's own helpers
// (services/safepay listSavedMethods / removeSavedMethod -- removing also
// deletes the card from the member's Safepay wallet) when it is there, and
// read and pull the member's record directly otherwise. Either way removal
// takes the card off the member at once, so automatic payment stops.
//
// The due-date charge picks its card here (autoPayMethod: auto-pay on,
// saved through the gym's current gateway, not past its expiry) and hands
// it over as stored, token sealed: the gateway opens it.

const User = require('../../models/user');

/** The gateway connector's saved-card helpers, or null when this build has none. */
function connector() {
  try {
    const safepay = require('../safepay');
    return typeof safepay.listSavedMethods === 'function' && typeof safepay.removeSavedMethod === 'function' ? safepay : null;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

/** The member's saved cards as stored (tokens still sealed), or []. */
async function savedMethodsOf(userId) {
  if (!userId) return [];
  const member = await User.findById(userId).select('+billing').lean();
  const methods = member && member.billing && member.billing.savedMethods;
  return Array.isArray(methods) ? methods.filter((method) => method && method.id) : [];
}

/** What the member is shown of a saved card: nothing a payment could be made with. */
function savedMethodView(method) {
  return {
    id: String(method.id),
    provider: method.provider || '',
    brand: method.brand || '',
    last4: method.last4 || '',
    exp_month: method.expMonth ?? null,
    exp_year: method.expYear ?? null,
    auto_pay: method.autoPay !== false,
    consent_at: method.consentAt || null,
    consent_text: method.consentText || '',
    created_at: method.createdAt || null
  };
}

/** The member's cards for GET /api/billing/me/saved-methods. */
async function listSavedMethods(userId) {
  const helpers = connector();
  if (helpers) return helpers.listSavedMethods(userId);
  return (await savedMethodsOf(userId)).map(savedMethodView);
}

/** Whether a card's expiry month has passed (an unknown expiry is not). */
function isExpired(method, now = new Date()) {
  const year = Number(method && method.expYear);
  const month = Number(method && method.expMonth);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return false;
  const fullYear = year < 100 ? 2000 + year : year;
  // Good to the last day of its expiry month.
  return new Date(Date.UTC(fullYear, month, 1)).getTime() <= now.getTime();
}

/**
 * The card to charge on the due date at this gateway: the first one with
 * automatic payment on, saved through `providerId`. `{ method, reason }`:
 * a reason when the member has none that can be used.
 */
function autoPayMethod(methods, providerId, now = new Date()) {
  const usable = (methods || []).filter((method) => method && method.autoPay !== false && (!method.provider || method.provider === providerId));
  if (!usable.length) return { method: null, reason: 'no saved card with automatic payment' };
  const current = usable.find((method) => !isExpired(method, now));
  if (!current) return { method: null, reason: 'saved card expired', expired: usable[0] };
  return { method: current, reason: null };
}

/**
 * Removes one of the member's saved cards. Automatic payment stops at once.
 * @returns {Promise<boolean>} whether the member had it
 */
async function removeSavedMethod(userId, id) {
  const wanted = String(id || '');
  if (!wanted) return false;
  const helpers = connector();
  if (helpers) return !!(await helpers.removeSavedMethod(userId, wanted));
  const method = (await savedMethodsOf(userId)).find((entry) => String(entry.id) === wanted);
  if (!method) return false;
  await User.updateOne({ _id: userId }, { $pull: { 'billing.savedMethods': { id: method.id } } }, { strict: false });
  return true;
}

module.exports = { savedMethodsOf, savedMethodView, listSavedMethods, isExpired, autoPayMethod, removeSavedMethod };
