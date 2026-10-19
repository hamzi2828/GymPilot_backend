// src/services/billing/savedMethods.js
//
// The cards a member saved, with their consent, to be charged on each due
// date: `user.billing.savedMethods[]` (written by the gateway when a
// checkout saves a card). Never card data -- the gateway's token for the
// card (sealed at rest), and what may be shown: brand, last four digits,
// expiry, when and to what the member agreed.
//
// Gateway-neutral on purpose: listing and removing are about the member's
// own record. Removing stops automatic payment at once -- the card is gone
// from the member before anything else is tried -- and then, best effort,
// asks the gateway the card belongs to to forget it as well.

const User = require('../../models/user');
const { activeProvider } = require('./provider');

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
  const method = (await savedMethodsOf(userId)).find((entry) => String(entry.id) === wanted);
  if (!method) return false;

  const pull = () => User.updateOne({ _id: userId }, { $pull: { 'billing.savedMethods': { id: method.id } } }, { strict: false });
  const warn = (error) => console.warn(`[billing] card ${wanted} removed here but not at the gateway: ${error.message}`);

  // The gateway the card belongs to, if it is still the gym's, is asked to
  // forget it too; failing that leaves only an unusable token at the gateway.
  const gateway = await activeProvider();
  const ours = gateway && (!method.provider || gateway.id === method.provider);
  if (ours && typeof gateway.forgetSavedMethod === 'function') {
    // Off the member first, so no charge can use it while the gateway answers.
    await pull();
    await Promise.resolve().then(() => gateway.forgetSavedMethod({ userId, savedMethod: method })).catch(warn);
    return true;
  }
  if (ours && typeof gateway.removeSavedMethod === 'function') {
    // A gateway that takes the card off the member itself, then forgets it.
    await Promise.resolve().then(() => gateway.removeSavedMethod(userId, wanted)).catch(warn);
  }
  // Whatever the gateway said, the member's record no longer has it.
  await pull();
  return true;
}

module.exports = { savedMethodsOf, savedMethodView, isExpired, autoPayMethod, removeSavedMethod };
