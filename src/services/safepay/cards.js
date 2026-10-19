// src/services/safepay/cards.js
//
// A member's saved card, kept so the gym can charge it on each due date.
//
// A card is only ever saved by Safepay itself, on its own checkout page (the
// member types the card there and passes 3-D Secure); GymsPilotPro never sees
// the number. What is kept on the member (user.billing.savedMethods) is
// Safepay's token for the card, sealed at rest, with what may be shown --
// brand, last four digits, expiry -- and the consent the member gave.
//
// It happens only when everything says yes: the member ticked "save my card
// and pay automatically" and agreed (autoPayConsent), the gym has
// billing.autoCharge on, and the checkout was for a member account. The
// checkout opened the session for a Safepay customer made for the member;
// once its payment is in, that customer's wallet holds the card
// (docs: Manage tokens -- GET /user/customers/v1/{customer}/wallet/).

const crypto = require('crypto');
const User = require('../../models/user');
const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const { parseAmount } = require('../../helper/money');
const { seal, open } = require('../secretBox');
const { gymSiteName } = require('../gymName');
const api = require('./api');
const shapes = require('./shapes');
const { getSafepayConfig } = require('./config');

// The most cards kept per member; the oldest goes first.
const MAX_SAVED_METHODS = 5;

/** A saved card's id: stable for the same card, so saving it twice keeps one. */
function savedMethodId(token) {
  return `sm_${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24)}`;
}

function periodWords(order) {
  const details = (order && order.packageDetails) || {};
  const billing = details.billing || {};
  if (billing.mode === 'recurring') {
    const count = Number(billing.intervalCount) || 1;
    const unit = billing.interval || 'month';
    return count === 1 ? unit : `${count} ${unit}s`;
  }
  if (Number(details.durationDays) > 0) return `${Number(details.durationDays)} days`;
  return String(details.period || 'month').replace(/^(per|every)\s+/i, '').trim() || 'month';
}

/**
 * The sentence the member agreed to, with the card filled in:
 * "I allow <Gym name> to charge my saved card <brand> •••• <last4> for my
 * membership (<amount> <currency> every <period>) on each due date. I can
 * turn this off anytime in my account."
 */
async function consentTextFor(order, card) {
  const gym = await gymSiteName();
  const price = parseAmount(order && order.packageDetails && order.packageDetails.price);
  const amount = price === null ? Number(order && order.payment && order.payment.amount) || 0 : price;
  const currency = String((order && order.payment && order.payment.currency) || '').toUpperCase();
  const shown = amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return (
    `I allow ${gym} to charge my saved card ${card.brand || 'card'} •••• ${card.last4 || '????'} ` +
    `for my membership (${shown} ${currency} every ${periodWords(order)}) on each due date. ` +
    'I can turn this off anytime in my account.'
  );
}

/**
 * After a paid tracker that asked to save the card: reads the card from the
 * member's Safepay wallet and keeps it on the member as their auto-pay card
 * (any card saved before stops being charged automatically). Saving the
 * same card again refreshes its consent rather than adding a second copy.
 *
 * @param {object} order   the paid order
 * @param {object} record  its tracker record (payment.safepay.trackers[])
 * @returns {Promise<object|null>} the saved method as stored (token sealed), or null
 */
async function storeSavedCard(order, record) {
  if (!order || !order.userId || !record || !record.customerToken) return null;
  if (!(record.saveCard && record.autoPayConsent)) return null;
  const { autoChargeEnabled } = require('./payments');
  if (!(await autoChargeEnabled())) return null;

  const config = await getSafepayConfig({ includeDisabled: true });
  if (!config) return null;

  const cards = shapes.walletEntries(await api.listWallet(config, record.customerToken));
  if (!cards.length) {
    console.warn(`[safepay] tracker ${record.token} asked to save the card, but Safepay's wallet for ${record.customerToken} is empty`);
    return null;
  }
  // Newest first; entries without a date keep the wallet's order, last newest.
  const ordered = cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => (b.card.createdAt ? b.card.createdAt.getTime() : 0) - (a.card.createdAt ? a.card.createdAt.getTime() : 0) || b.index - a.index)
    .map((entry) => entry.card);

  const member = await User.findById(order.userId).select('+billing');
  if (!member) return null;
  const existing = (member.billing && Array.isArray(member.billing.savedMethods) && member.billing.savedMethods) || [];
  const known = new Set(existing.map((method) => method.id));
  const card = ordered.find((entry) => !known.has(savedMethodId(entry.token))) || ordered[0];
  const id = savedMethodId(card.token);
  const now = new Date();
  const consentText = await consentTextFor(order, card);

  // Only one card is charged automatically: the one just agreed to.
  if (existing.length) {
    await User.updateOne({ _id: member._id }, { $set: { 'billing.savedMethods.$[].autoPay': false } });
  }
  if (known.has(id)) {
    await User.updateOne(
      { _id: member._id, 'billing.savedMethods.id': id },
      { $set: { 'billing.savedMethods.$.autoPay': true, 'billing.savedMethods.$.consentAt': now, 'billing.savedMethods.$.consentText': consentText } }
    );
  } else {
    const method = {
      id,
      provider: 'safepay',
      token: seal(card.token),
      customerToken: record.customerToken,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      autoPay: true,
      consentAt: now,
      consentText,
      createdAt: now
    };
    await User.updateOne(
      { _id: member._id, 'billing.savedMethods.id': { $ne: id } },
      { $push: { 'billing.savedMethods': { $each: [method], $slice: -MAX_SAVED_METHODS } } }
    );
  }
  await PackageOrder.updateOne(
    { _id: order._id, 'payment.safepay.trackers.token': record.token },
    { $set: { 'payment.safepay.trackers.$.savedMethodId': id } }
  );

  const saved = await User.findById(member._id).select('+billing').lean();
  return ((saved && saved.billing && saved.billing.savedMethods) || []).find((method) => method.id === id) || null;
}

/**
 * The member's saved cards, safe to show them: no token, no customer.
 * @returns {Promise<Array<{ id, provider, brand, last4, exp_month, exp_year, auto_pay, consent_at, consent_text, created_at }>>}
 */
async function listSavedMethods(userId) {
  const member = await User.findById(userId).select('+billing').lean();
  const methods = (member && member.billing && member.billing.savedMethods) || [];
  return methods.map((method) => ({
    id: method.id,
    provider: method.provider,
    brand: method.brand || '',
    last4: method.last4 || '',
    exp_month: method.expMonth ?? null,
    exp_year: method.expYear ?? null,
    auto_pay: method.autoPay !== false,
    consent_at: method.consentAt || null,
    consent_text: method.consentText || '',
    created_at: method.createdAt || null
  }));
}

/**
 * The member's auto-pay card, ready for chargeSavedMethod (token opened), or null.
 */
async function autoPayMethodFor(userId) {
  const member = await User.findById(userId).select('+billing');
  const methods = (member && member.billing && member.billing.savedMethods) || [];
  const method = methods.find((entry) => entry && entry.autoPay !== false && entry.provider === 'safepay');
  if (!method) return null;
  const plain = method.toObject ? method.toObject({ getters: false }) : { ...method };
  return { ...plain, token: open(String(plain.token || '')) };
}

/**
 * Removes a saved card from the member (auto-pay stops at once) and, best
 * effort, from the member's Safepay wallet.
 * @returns {Promise<boolean>} whether the member had it
 */
async function removeSavedMethod(userId, id) {
  const member = await User.findById(userId).select('+billing');
  const methods = (member && member.billing && member.billing.savedMethods) || [];
  const method = methods.find((entry) => entry && entry.id === String(id));
  if (!method) return false;
  await User.updateOne({ _id: member._id }, { $pull: { 'billing.savedMethods': { id: method.id } } });
  const token = open(String((method.toObject ? method.toObject({ getters: false }) : method).token || ''));
  if (token && method.customerToken) {
    const config = await getSafepayConfig({ includeDisabled: true }).catch(() => null);
    if (config) {
      await api.deleteWalletMethod(config, method.customerToken, token).catch((error) => {
        console.warn(`[safepay] card ${method.id} removed here but not from Safepay's wallet: ${error.message}`);
      });
    }
  }
  return true;
}

module.exports = { MAX_SAVED_METHODS, savedMethodId, consentTextFor, storeSavedCard, listSavedMethods, autoPayMethodFor, removeSavedMethod };
