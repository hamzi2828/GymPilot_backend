// src/platform/services/platformSafepay.js
//
// A gym paying GymsPilotPro through GymsPilotPro's OWN Safepay account
// (platform_settings.safepay -- never the gym's keys, which are for its
// members' money). The HTTP calls are the gym connector's (services/safepay),
// handed the platform's keys:
//
//   openCheckout   the Billing tab's "Pay now": a Safepay hosted checkout
//                  for what the gym owes (platformPay.payTerms), recorded in
//                  platform_safepay_checkouts; Safepay sends the owner back
//                  to <gym site>/admin/settings?tab=billing&paid=1
//   handleEvent    the platform webhook (POST /api/platform/safepay/webhook,
//                  signed with the platform's webhook secret): a paid tracker
//                  is recorded once, through manualPayments.recordPayment
//                  (method 'safepay', the tracker as its reference), which
//                  extends the subscription as a payment typed in by hand does

const Gym = require('../models/gymModel');
const PlatformSettings = require('../models/platformSettingsModel');
const PlatformPayment = require('../models/platformPaymentModel');
const PlatformSafepayCheckout = require('../models/platformSafepayCheckoutModel');
const safepay = require('../../services/safepay');
const { gymSiteOrigin } = require('../../services/payments/site');
const manualPayments = require('./manualPayments');
const { PlatformPayError } = require('./platformPay');

// Checkouts one gym may open in a day: an owner pressing "Pay now" a few
// times is normal, a loop is not.
const MAX_CHECKOUTS_PER_DAY = 30;
const DAY_MS = 86400000;

/**
 * The platform's Safepay keys, or null when they cannot be used: switched on
 * (chosen) with both keys, `ready` with the webhook secret too.
 * `includeDisabled` also answers after Safepay stopped being the way, for
 * recording payments already made.
 */
async function platformSafepayConfig({ includeDisabled = false, settings } = {}) {
  const s = settings || (await PlatformSettings.getSettings());
  return safepay.getSafepayConfig({ settings: s, includeDisabled });
}

function billingTab(site, paid) {
  return `${site}/admin/settings?tab=billing${paid ? '&paid=1' : ''}`;
}

/**
 * Opens a Safepay hosted checkout for `terms` (platformPay.payTerms).
 * @returns {Promise<{ url: string, tracker: string }>}
 * @throws {PlatformPayError} 409 ONLINE_PAYMENT_OFF / NO_SITE_ADDRESS, 429 TOO_MANY_ATTEMPTS;
 *   SafepayError for a currency Safepay does not take or Safepay refusing
 */
async function openCheckout({ gym, terms, actor = null, settings, now = new Date() }) {
  const config = await platformSafepayConfig({ settings });
  if (!config || !config.ready) throw new PlatformPayError('Online payment is not available just now. Contact GymsPilotPro to pay.', 409, 'ONLINE_PAYMENT_OFF');
  const amountMinor = safepay.toSafepayAmount(terms.amount, terms.currency);
  const site = gymSiteOrigin();
  if (!site) throw new PlatformPayError('This gym has no web address for Safepay to send you back to. Contact GymsPilotPro to pay.', 409, 'NO_SITE_ADDRESS');

  const recent = await PlatformSafepayCheckout.countDocuments({ gymId: gym._id, createdAt: { $gte: new Date(now.getTime() - DAY_MS) } });
  if (recent >= MAX_CHECKOUTS_PER_DAY) throw new PlatformPayError('Too many payment attempts today. Please try again tomorrow, or contact GymsPilotPro.', 429, 'TOO_MANY_ATTEMPTS');

  const orderRef = `gpp-${gym.slug}-${now.getTime().toString(36)}`;
  const { token, tbt } = await safepay.openHostedSession(config, { amountMinor, currency: terms.currency, orderRef });
  await PlatformSafepayCheckout.create({
    tracker: token,
    orderRef,
    gymId: gym._id,
    gymSlug: gym.slug,
    environment: config.environment,
    amount: terms.amount,
    amountMinor,
    currency: terms.currency,
    billingCycle: terms.billingCycle,
    change: terms.change || null,
    openedBy: { id: actor && actor.id ? String(actor.id) : '', email: (actor && actor.email) || '' }
  });
  const url = safepay.hostedCheckoutUrl(config, { token, tbt, returnUrl: billingTab(site, true), cancelUrl: billingTab(site, false), orderRef });
  return { url, tracker: token };
}

function eventTime(event) {
  const data = (event && event.data) || {};
  const stamp = data.charged_at || (event && event.created_at);
  const seconds = stamp && Number(stamp.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/** What Safepay reported against what was asked: less, or another currency, is not applied. */
function moneyProblem(checkout, details) {
  if (details.amountMinor !== null && details.amountMinor !== undefined && Number.isFinite(Number(details.amountMinor)) && Number(details.amountMinor) < Number(checkout.amountMinor)) {
    return `Safepay reports ${details.amountMinor} minor units, ${checkout.amountMinor} were asked for`;
  }
  if (details.currency && checkout.currency && String(details.currency).toUpperCase() !== String(checkout.currency).toUpperCase()) {
    return `paid in ${details.currency}, ${checkout.currency} was asked for`;
  }
  return '';
}

/**
 * Records a tracker Safepay says is paid, once: a second delivery finds the
 * checkout paid with its payment on record. The payment's request id is
 * the tracker's, so two deliveries at the same moment record it once too
 * (manualPayments' unique index).
 */
async function applyPaid(checkout, details, now = new Date()) {
  if (checkout.status === 'paid' && checkout.paymentId && (await PlatformPayment.exists({ _id: checkout.paymentId }))) {
    return { applied: false, duplicate: true, gymId: checkout.gymId, result: 'already recorded' };
  }
  const problem = moneyProblem(checkout, details);
  if (problem) {
    console.error(`[platform-safepay] tracker ${checkout.tracker} for ${checkout.gymSlug}: ${problem}; not recorded. Check it in the Safepay dashboard.`);
    await PlatformSafepayCheckout.updateOne({ _id: checkout._id }, { $set: { error: `Not recorded: ${problem}`.slice(0, 500) } });
    return { applied: false, mismatch: true, gymId: checkout.gymId, result: `not recorded: ${problem}` };
  }
  const gym = await Gym.findByIdWithUri(checkout.gymId);
  if (!gym) {
    await PlatformSafepayCheckout.updateOne({ _id: checkout._id }, { $set: { status: 'paid', paidAt: now, error: 'Paid, but the gym no longer exists' } });
    return { applied: false, stray: true, gymId: checkout.gymId, result: 'paid, but the gym no longer exists' };
  }

  const at = details.at instanceof Date && !Number.isNaN(details.at.getTime()) && details.at.getTime() <= now.getTime() ? details.at : now;
  let outcome;
  try {
    outcome = await manualPayments.recordPayment({
      gym,
      input: {
        amount: checkout.amount,
        method: 'safepay',
        reference: checkout.tracker,
        receivedAt: at,
        note: 'Paid online through Safepay',
        requestId: `safepay:${checkout.tracker}`
      },
      actor: { _id: null, email: 'safepay' },
      change: checkout.change || null,
      now
    });
  } catch (error) {
    if (!(error instanceof manualPayments.ManualPaymentError)) throw error;
    // The money was taken but cannot be recorded here (the gym has moved to
    // Stripe since, say): kept as paid, with why, for the super admin.
    console.error(`[platform-safepay] tracker ${checkout.tracker} paid for ${gym.slug} but not recorded: ${error.message}`);
    await PlatformSafepayCheckout.updateOne({ _id: checkout._id }, { $set: { status: 'paid', paidAt: at, error: error.message.slice(0, 500) } });
    return { applied: false, stray: true, gymId: gym._id, gymSlug: gym.slug, result: `paid, not recorded: ${error.code}` };
  }
  await PlatformSafepayCheckout.updateOne({ _id: checkout._id }, { $set: { status: 'paid', paidAt: at, paymentId: outcome.payment._id, error: '' } });
  return { applied: !outcome.duplicate, duplicate: !!outcome.duplicate, gymId: gym._id, gymSlug: gym.slug, result: outcome.duplicate ? 'already recorded' : `recorded, paid until ${manualPayments.dayLabel(outcome.payment.periodTo)}` };
}

/**
 * A verified Safepay event (safepay.verifyWebhook with the platform's
 * secret), for a checkout a gym opened to pay GymsPilotPro. An event for
 * no such checkout is acknowledged and ignored.
 *
 * @returns {Promise<{ received: true, applied?, duplicate?, ignored?, gymId?, result }>}
 */
async function handleEvent(event, { settings, now = new Date() } = {}) {
  const info = safepay.readEvent(event);
  if (!info.tracker) return { received: true, ignored: 'no tracker in the event', result: 'ignored' };
  let checkout = await PlatformSafepayCheckout.findOne({ tracker: info.tracker }).lean();
  if (!checkout && info.orderRef) checkout = await PlatformSafepayCheckout.findOne({ orderRef: info.orderRef }).lean();
  if (!checkout) return { received: true, ignored: 'no GymsPilotPro payment for it', result: 'ignored' };

  const done = (extra) => ({ received: true, gymId: checkout.gymId, ...extra });
  if (info.outcome === 'paid') {
    const result = await applyPaid(checkout, { ...info, at: eventTime(event) }, now);
    return done(result);
  }
  if (info.outcome === 'failed') {
    await PlatformSafepayCheckout.updateOne({ _id: checkout._id, status: 'pending' }, { $set: { status: 'failed', error: (info.message || 'The payment did not go through').slice(0, 500) } });
    return done({ result: 'payment failed' });
  }
  if (info.outcome === 'refunded') {
    await PlatformSafepayCheckout.updateOne({ _id: checkout._id }, { $set: { status: 'refunded' } });
    console.warn(`[platform-safepay] tracker ${checkout.tracker} for ${checkout.gymSlug} was refunded, voided or reversed at Safepay. The subscription is unchanged; adjust it in the panel if it should be.`);
    return done({ result: 'refunded at Safepay; subscription unchanged' });
  }

  // A kind of event not handled above: Safepay is asked what happened.
  const config = await platformSafepayConfig({ settings, includeDisabled: true });
  if (!config) return done({ result: 'no platform Safepay keys to check it with' });
  const details = await safepay.trackerDetails(checkout.tracker, { config });
  if (details.status === 'paid') return done(await applyPaid(checkout, { ...details, at: now }, now));
  if (details.status === 'failed') {
    await PlatformSafepayCheckout.updateOne({ _id: checkout._id, status: 'pending' }, { $set: { status: 'failed', error: `Safepay reports ${details.state}` } });
  }
  return done({ result: `Safepay reports ${details.state || details.status}` });
}

module.exports = { platformSafepayConfig, openCheckout, handleEvent, applyPaid, MAX_CHECKOUTS_PER_DAY };
