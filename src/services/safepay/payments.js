// src/services/safepay/payments.js
//
// Taking a payment through the current gym's Safepay account, and applying
// it to the order it is for.
//
// Every Safepay payment belongs to a tracker ("payment session"). The order
// exists first; each checkout opened for it (and each saved-card charge) is
// a tracker recorded on the order (payment.safepay.trackers), with what it
// was for and how much it asked:
//
//   purpose 'order'    pays the order: it is activated through the same path
//                      a Stripe payment takes (gymfolioPaymentService.
//                      activateFromEvent -> membershipService.markPaidAndActivate:
//                      the term continues from the end of the running one,
//                      the coupon is counted, the invoice is numbered, the
//                      member gets their confirmation).
//   purpose 'balance'  pays what is still owed on a part-paid order: one more
//                      installment, like money taken at the desk.
//
// The webhook, the return page and a saved-card charge can all learn of the
// same payment. Each applies it only while its tracker is not yet recorded
// as paid, and an order is activated once (activationClaim), so a payment
// delivered twice is counted once.
//
// Amounts are never taken from the browser: the caller decides what is owed
// from the order, and Safepay's reports are checked against what was asked.

const mongoose = require('mongoose');
const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Settings = require('../../models/settings');
const { partsSoFar, nextPart, paidSoFar, round2 } = require('../../gymfolio/services/orderMoney');
const api = require('./api');
const shapes = require('./shapes');
const { getSafepayConfig } = require('./config');

const { SafepayError } = shapes;

// A member can open checkout for one order again and again; past this many
// sessions something is wrong, and the gym is asked to look.
const MAX_TRACKERS_PER_ORDER = 40;

/* -------------------------------- helpers -------------------------------- */

function trackersOf(order) {
  const safepay = order && order.payment && order.payment.safepay;
  return (safepay && Array.isArray(safepay.trackers) && safepay.trackers) || [];
}

function trackerRecord(order, token) {
  return trackersOf(order).find((record) => record && record.token === token) || null;
}

async function loadOrder(orderOrId) {
  const id = orderOrId && orderOrId._id ? orderOrId._id : orderOrId;
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  return PackageOrder.findById(id);
}

function orderRefOf(order) {
  return order.orderNumber || String(order._id);
}

async function billingSettings() {
  const settings = await Settings.getSettings().catch(() => null);
  return {
    settings,
    autoCharge: !!(settings && settings.billing && settings.billing.autoCharge && settings.billing.autoCharge.enabled)
  };
}

/** Whether the gym has switched automatic (merchant-initiated) card charges on. */
async function autoChargeEnabled() {
  return (await billingSettings()).autoCharge;
}

function isWebAddress(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** What an order still needs paid online, and for which purpose; null when nothing. */
function amountDue(order) {
  const payment = (order && order.payment) || {};
  if (payment.status === 'paid') {
    const balance = round2(payment.balanceDue || 0);
    return balance > 0 ? { purpose: 'balance', amount: balance } : null;
  }
  if (['pending', 'failed'].includes(payment.status) && order.status !== 'cancelled') {
    const amount = round2(payment.amount);
    return amount > 0 ? { purpose: 'order', amount } : null;
  }
  return null;
}

function nameParts(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { firstName: 'Member', lastName: '-' };
  return { firstName: words[0].slice(0, 60), lastName: (words.slice(1).join(' ') || '-').slice(0, 60) };
}

// Safepay's customers take an international number ("+923331234567"). A
// local Pakistani mobile ("0333 1234567") is written that way; anything else
// that is not already international is left out rather than sent wrong.
function internationalPhone(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  if (/^03\d{9}$/.test(digits)) return `+92${digits.slice(1)}`;
  if (/^92\d{10}$/.test(digits)) return `+${digits}`;
  return '';
}

/* ---------------------------- saved-card customer ---------------------------- */

/**
 * The Safepay customer a member's cards are saved under: the one an earlier
 * saved card used, else a new one.
 */
async function customerFor(config, order, customer = {}) {
  const User = require('../../models/user');
  const member = order.userId
    ? await User.findById(order.userId).select('+billing firstName lastName email phone').catch(() => null)
    : null;
  const known = member && member.billing && Array.isArray(member.billing.savedMethods)
    ? member.billing.savedMethods.find((method) => method && method.provider === 'safepay' && method.customerToken)
    : null;
  if (known) return known.customerToken;

  const name = customer.name || (member && [member.firstName, member.lastName].filter(Boolean).join(' ')) || (order.customerInfo && order.customerInfo.fullName) || '';
  const { firstName, lastName } = nameParts(name);
  return api.createCustomer(config, {
    firstName,
    lastName,
    email: customer.email || (member && member.email) || (order.customerInfo && order.customerInfo.email) || undefined,
    phone: internationalPhone(customer.phone || (member && member.phone) || (order.customerInfo && order.customerInfo.phone)) || undefined,
    country: 'PK'
  });
}

/* --------------------------------- checkout -------------------------------- */

/**
 * Opens a Safepay hosted checkout for what an order still needs paid: the
 * order itself while it is unpaid, or its balance once it is paid in part.
 *
 * @param {object} args
 * @param {object} args.order       a PackageOrder (document or id), already saved
 * @param {number} [args.amount]    major units; must be what the order owes (checked)
 * @param {string} [args.currency]  defaults to the order's
 * @param {{ name?, email?, phone? }} [args.customer]
 * @param {string} args.returnUrl   where Safepay sends the member after paying
 * @param {string} args.cancelUrl   ...and after cancelling
 * @param {boolean} [args.saveCard]       save the card for automatic payments
 * @param {boolean} [args.autoPayConsent] the member agreed to them -- BOTH are
 *   needed, and the gym's billing.autoCharge must be on, and the order must
 *   belong to a member account; otherwise no card is saved
 * @returns {Promise<{ url: string, tracker: string, saveCard: boolean, purpose: 'order'|'balance', amount: number, currency: string }>}
 * @throws {SafepayError} 409 SAFEPAY_NOT_CONFIGURED / ORDER_NOT_PAYABLE /
 *   SAFEPAY_CURRENCY_UNSUPPORTED, 400 AMOUNT_MISMATCH / INVALID_RETURN_URL,
 *   502 from Safepay
 */
async function createCheckout({ order: orderOrId, amount, currency, customer = {}, returnUrl, cancelUrl, saveCard = false, autoPayConsent = false } = {}) {
  const config = await getSafepayConfig();
  if (!config) {
    throw new SafepayError('Online payments are not set up at this gym yet.', 'SAFEPAY_NOT_CONFIGURED', 409);
  }
  const order = await loadOrder(orderOrId);
  if (!order) throw new SafepayError('We could not find this order.', 'ORDER_NOT_FOUND', 404);
  const due = amountDue(order);
  if (!due) throw new SafepayError('This order has nothing left to pay online.', 'ORDER_NOT_PAYABLE', 409);
  if (amount !== undefined && amount !== null && round2(amount) !== due.amount) {
    throw new SafepayError(`This order owes ${due.amount}, not ${round2(amount)}.`, 'AMOUNT_MISMATCH', 400);
  }
  if (!isWebAddress(returnUrl) || !isWebAddress(cancelUrl)) {
    throw new SafepayError('The return and cancel addresses must be web addresses.', 'INVALID_RETURN_URL', 400);
  }
  if (trackersOf(order).length >= MAX_TRACKERS_PER_ORDER) {
    throw new SafepayError('Too many payment attempts have been made for this order. Please contact the gym.', 'TOO_MANY_ATTEMPTS', 429);
  }

  const code = String(currency || order.payment.currency || '').toUpperCase();
  const amountMinor = shapes.toSafepayAmount(due.amount, code);

  // A card is saved only with the member's say-so, at a gym that charges
  // saved cards, for an account the card can be kept on.
  const saving = !!(saveCard && autoPayConsent && order.userId && (await autoChargeEnabled()));
  const customerToken = saving ? await customerFor(config, order, customer) : null;

  const orderRef = orderRefOf(order);
  const { token } = await api.createTracker(config, { amount: amountMinor, currency: code, mode: 'payment', customer: customerToken, orderRef });
  // For Safepay's dashboard and its webhooks; the payment works without it.
  await api.addMetadata(config, token, orderRef).catch((error) => {
    console.warn(`[safepay] metadata for ${token} (${orderRef}) not saved: ${error.message}`);
  });
  const tbt = await api.createPassport(config);

  await PackageOrder.updateOne(
    { _id: order._id },
    {
      $set: { 'payment.provider': 'safepay', 'payment.safepay.tracker': token },
      $push: {
        'payment.safepay.trackers': {
          token,
          purpose: due.purpose,
          kind: 'checkout',
          amount: due.amount,
          amountMinor,
          currency: code,
          status: 'pending',
          saveCard: saving,
          autoPayConsent: saving,
          customerToken,
          createdAt: new Date()
        }
      }
    }
  );

  // {TRACKER} in an address is this payment's reference (as Stripe's
  // {CHECKOUT_SESSION_ID}), for a page that must ask about this one payment.
  const withRef = (address) => String(address).split('{TRACKER}').join(encodeURIComponent(token));
  const url = api.checkoutUrl(config, { tracker: token, tbt, redirectUrl: withRef(returnUrl), cancelUrl: withRef(cancelUrl), orderRef, customer: customerToken, saveCard: saving });
  return { url, tracker: token, saveCard: saving, purpose: due.purpose, amount: due.amount, currency: code };
}

/* ------------------------------ applying payments ----------------------------- */

function moneyMatches(record, details, what) {
  if (details.amountMinor !== null && details.amountMinor !== undefined && Number.isFinite(Number(details.amountMinor))) {
    if (Number(details.amountMinor) < Number(record.amountMinor)) {
      console.error(`[safepay] ${what}: Safepay reports ${details.amountMinor} minor units, ${record.amountMinor} were asked for; not applied. Check the payment in the Safepay dashboard.`);
      return false;
    }
  }
  if (details.currency && record.currency && String(details.currency).toUpperCase() !== String(record.currency).toUpperCase()) {
    console.error(`[safepay] ${what}: paid in ${details.currency}, ${record.currency} was asked for; not applied.`);
    return false;
  }
  return true;
}

// The tracker paid, on an order that cannot take it: already paid by another
// tracker (the member paid twice), or refunded or cancelled since. The money
// was taken either way, so the tracker is recorded as paid, and the log says
// what the gym must do about it.
async function recordStrayPayment(order, token, at, reason) {
  await PackageOrder.updateOne(
    { _id: order._id, 'payment.safepay.trackers': { $elemMatch: { token, status: { $ne: 'paid' } } } },
    { $set: { 'payment.safepay.trackers.$.status': 'paid', 'payment.safepay.trackers.$.paidAt': at, 'payment.safepay.trackers.$.error': reason.slice(0, 300) } }
  );
  console.warn(`[safepay] tracker ${token} paid on order ${order._id} (${order.orderNumber}), which ${reason}. Refund it from the Safepay dashboard if it should not have been taken.`);
}

async function applyOrderPayment(order, record, { fee, net, at, what }) {
  const service = require('../gymfolioPaymentService');
  const token = record.token;
  await service.activateFromEvent(order, what, async (o) => {
    o.payment.method = 'online';
    o.payment.provider = 'safepay';
    if (!o.payment.safepay) o.payment.safepay = { trackers: [] };
    o.payment.safepay.tracker = token;
    o.payment.safepay.fee = fee;
    o.payment.safepay.net = net;
    o.payment.lastPaymentError = '';
    const own = trackerRecord(o, token);
    if (own) {
      own.status = 'paid';
      own.paidAt = at;
      own.fee = fee;
      own.net = net;
      own.error = '';
    }
    return { transactionId: token, paidAt: at };
  });

  const after = await PackageOrder.findById(order._id);
  const mine = trackerRecord(after, token);
  if (mine && mine.status === 'paid' && after.payment.safepay && after.payment.safepay.tracker === token && after.payment.status === 'paid') {
    // Activated -- by this caller, or by another that learnt of the same
    // payment at the same moment (the webhook and the return page).
    return { applied: true, order: after };
  }
  const why =
    after.payment.status === 'paid'
      ? `was already paid (tracker ${after.payment.safepay && after.payment.safepay.tracker})`
      : `is ${after.payment.status} / ${after.status}`;
  await recordStrayPayment(after, token, at, `paid, but the order ${why}`);
  return { applied: false, stray: true, order: await PackageOrder.findById(order._id) };
}

async function applyBalancePayment(order, record, { fee, net, at, what }) {
  const token = record.token;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fresh = await PackageOrder.findById(order._id);
    const mine = trackerRecord(fresh, token);
    if (!mine || mine.status === 'paid') return { applied: false, duplicate: true, order: fresh };
    if (fresh.payment.status !== 'paid') {
      await recordStrayPayment(fresh, token, at, `paid a balance, but the order is ${fresh.payment.status}`);
      return { applied: false, stray: true, order: fresh };
    }

    const paying = round2(record.amount);
    const balance = round2(fresh.payment.balanceDue || 0);
    const parts = partsSoFar(fresh.payment, { firstAt: fresh.createdAt });
    parts.push({
      ...nextPart(fresh.payment, parts, paying),
      method: 'online',
      at,
      by: null,
      note: `Paid online through Safepay (${token})`.slice(0, 200)
    });

    const updated = await PackageOrder.findOneAndUpdate(
      {
        _id: fresh._id,
        'payment.status': 'paid',
        'payment.balanceDue': fresh.payment.balanceDue,
        'payment.safepay.trackers': { $elemMatch: { token, status: { $ne: 'paid' } } }
      },
      {
        $set: {
          'payment.installments': parts,
          'payment.amountPaid': round2(paidSoFar(fresh.payment) + paying),
          'payment.balanceDue': round2(Math.max(0, balance - paying)),
          'payment.lastPaidAt': at,
          'payment.safepay.trackers.$.status': 'paid',
          'payment.safepay.trackers.$.paidAt': at,
          'payment.safepay.trackers.$.fee': fee,
          'payment.safepay.trackers.$.net': net
        }
      },
      { new: true }
    );
    if (updated) {
      if (paying > balance) {
        console.warn(`[safepay] ${what}: ${paying} paid against a balance of ${balance} on ${fresh.orderNumber}; the difference is credit to refund or keep.`);
      }
      return { applied: true, order: updated };
    }
    // The balance moved under us (the desk took a payment at the same
    // moment): read it again and record this one on top.
  }
  const { MembershipError } = require('../../gymfolio/services/membershipService');
  throw new MembershipError('The balance changed while this payment was being recorded. Send the event again later.', 409, 'BALANCE_CHANGED');
}

/**
 * Applies a tracker Safepay says is paid to the order it belongs to, once.
 *
 * @param {object} orderOrId
 * @param {string} token  the tracker
 * @param {{ amountMinor?, currency?, feeMinor?, netMinor?, at?, what? }} [details]
 *   what Safepay reported; an amount below what was asked is not applied
 * @returns {Promise<{ applied: boolean, duplicate?: boolean, stray?: boolean, mismatch?: boolean, order }>}
 */
async function applyTrackerPayment(orderOrId, token, details = {}) {
  const order = await loadOrder(orderOrId);
  if (!order) return { applied: false, order: null };
  const record = trackerRecord(order, token);
  if (!record) return { applied: false, unknown: true, order };
  if (record.status === 'paid') return { applied: false, duplicate: true, order };

  const what = details.what || `safepay tracker ${token}`;
  if (!moneyMatches(record, details, what)) return { applied: false, mismatch: true, order };

  const at = details.at instanceof Date && !Number.isNaN(details.at.getTime()) ? details.at : new Date();
  const fee = shapes.fromSafepayAmount(details.feeMinor, record.currency);
  const net = shapes.fromSafepayAmount(details.netMinor, record.currency);
  const result =
    record.purpose === 'balance'
      ? await applyBalancePayment(order, record, { fee, net, at, what })
      : await applyOrderPayment(order, record, { fee, net, at, what });

  if (result.applied && record.saveCard && record.autoPayConsent && record.customerToken) {
    // The payment is recorded whatever happens here.
    const { storeSavedCard } = require('./cards');
    await storeSavedCard(result.order, record).catch((error) => {
      console.error(`[safepay] card from ${token} not saved for order ${order.orderNumber}: ${error.message}`);
    });
  }
  return result;
}

/** A tracker Safepay says failed. The order stays payable: the member may try again. */
async function markTrackerFailed(orderOrId, token, message = '') {
  const order = await loadOrder(orderOrId);
  if (!order) return null;
  const reason = String(message || 'The payment did not go through').slice(0, 300);
  await PackageOrder.updateOne(
    { _id: order._id, 'payment.safepay.trackers': { $elemMatch: { token, status: 'pending' } } },
    { $set: { 'payment.safepay.trackers.$.status': 'failed', 'payment.safepay.trackers.$.error': reason } }
  );
  if (order.payment.status !== 'paid') {
    await PackageOrder.updateOne({ _id: order._id, 'payment.status': { $in: ['pending', 'failed'] } }, { $set: { 'payment.lastPaymentError': reason } });
  }
  return PackageOrder.findById(order._id);
}

/* --------------------------------- status --------------------------------- */

/**
 * What Safepay says about a tracker now: 'paid' | 'failed' | 'pending'.
 * Uses the gym's keys even after it switched Safepay off (the money may
 * already have been taken).
 */
async function fetchTrackerStatus(tracker) {
  return (await trackerDetails(tracker)).status;
}

/** fetchTrackerStatus with the money and card Safepay reports. */
async function trackerDetails(tracker) {
  const config = await getSafepayConfig({ includeDisabled: true });
  if (!config) throw new SafepayError('This gym has no Safepay keys saved.', 'SAFEPAY_NOT_CONFIGURED', 409);
  const body = await api.fetchTracker(config, tracker);
  const found = shapes.trackerOf(body) || {};
  return { status: shapes.mapTrackerState(found.state), state: found.state || null, ...shapes.trackerMoney(body), card: shapes.trackerCard(body) };
}

/**
 * The return page's question: has this order been paid? Answered from the
 * order (the webhook may already have recorded it), else from Safepay for
 * the order's latest open tracker -- which is then applied as the webhook
 * would apply it.
 *
 * A new purchase whose session Safepay has closed unpaid (cancelled,
 * expired) is closed too, as an expired Stripe checkout is; an order a
 * payment link is for stays payable.
 *
 * @returns {Promise<{ paid: boolean, order }>}
 */
async function verifyOrderPayment(orderOrId) {
  const order = await loadOrder(orderOrId);
  if (!order) return { paid: false, order: null };
  if (order.payment.status === 'paid') return { paid: true, order };

  const open = trackersOf(order).filter((record) => record.purpose === 'order' && record.status !== 'paid');
  const latest = open[open.length - 1];
  if (!latest) return { paid: false, order };
  return settleWithSafepay(order, latest);
}

/**
 * The same question for one payment (`tracker`): the page a balance payment
 * returns to asks about that payment, not the order (already paid). A
 * tracker that is not this order's is never paid.
 */
async function verifyTrackerPayment(orderOrId, tracker) {
  const order = await loadOrder(orderOrId);
  if (!order) return { paid: false, order: null };
  const record = trackerRecord(order, tracker);
  if (!record) return { paid: false, order };
  if (record.status === 'paid') return { paid: true, order };
  return settleWithSafepay(order, record);
}

// Asks Safepay about a tracker that is not recorded as paid, and records
// what it says: applied when paid; marked when the session closed unpaid,
// which also closes a new purchase (not an order a payment link is for).
async function settleWithSafepay(order, record) {
  const details = await trackerDetails(record.token);
  if (details.status === 'paid') {
    const result = await applyTrackerPayment(order, record.token, { ...details, what: `return page, tracker ${record.token}` });
    const fresh = result.order || (await loadOrder(order._id));
    const mine = trackerRecord(fresh, record.token);
    return { paid: !!(mine && mine.status === 'paid'), order: fresh };
  }
  let current = order;
  if (details.status === 'failed') {
    current = (await markTrackerFailed(order, record.token, `Safepay closed the payment session (${details.state || 'unpaid'})`)) || order;
    const dueFor = current.metadata && typeof current.metadata.get === 'function' ? current.metadata.get('dueFor') : current.metadata && current.metadata.dueFor;
    if (record.purpose === 'order' && !dueFor && ['pending', 'failed'].includes(current.payment.status)) {
      current =
        (await PackageOrder.findOneAndUpdate(
          { _id: current._id, 'payment.status': { $in: ['pending', 'failed'] } },
          { $set: { 'payment.status': 'failed', status: 'cancelled', 'payment.lastPaymentError': 'The payment session closed before payment was completed' } },
          { new: true }
        )) || current;
    }
  }
  return { paid: false, order: current };
}

/* ---------------------------- saved-card charges ---------------------------- */

/**
 * Charges a member's saved card for what an order owes, with no member
 * present (Safepay mode `unscheduled_cof`, a merchant-initiated payment).
 * On 'paid' the order is marked paid through the shared path (activation,
 * receipt) before this returns.
 *
 * Never throws for a charge that simply could not be made -- the answer
 * says why, so the caller can send the payment link instead.
 *
 * @param {{ order, amount, currency?, savedMethod }} args  `savedMethod` as
 *   stored on the member (user.billing.savedMethods[]): its token may be
 *   sealed, it is opened here
 * @returns {Promise<{ status: 'paid'|'failed'|'pending', tracker: string|null, reason: string, code?: string }>}
 */
async function chargeSavedMethod({ order: orderOrId, amount, currency, savedMethod } = {}) {
  const refuse = (reason, code) => ({ status: 'failed', tracker: null, reason, code });

  const config = await getSafepayConfig();
  if (!config || !config.ready) return refuse('Safepay is not set up for this gym.', 'SAFEPAY_NOT_CONFIGURED');
  if (!(await autoChargeEnabled())) return refuse('Automatic card payments are switched off for this gym.', 'AUTO_CHARGE_OFF');

  const order = await loadOrder(orderOrId);
  if (!order) return refuse('The order was not found.', 'ORDER_NOT_FOUND');
  const due = amountDue(order);
  if (!due) return refuse('This order has nothing left to pay.', 'ORDER_NOT_PAYABLE');
  if (amount !== undefined && amount !== null && round2(amount) !== due.amount) {
    return refuse(`This order owes ${due.amount}, not ${round2(amount)}.`, 'AMOUNT_MISMATCH');
  }

  const { open } = require('../secretBox');
  const method = savedMethod || {};
  const token = method.token ? open(String(method.token)) : '';
  if (method.provider && method.provider !== 'safepay') return refuse('That saved card is not a Safepay card.', 'SAVED_METHOD_INVALID');
  if (method.autoPay === false) return refuse('Automatic payments are off for that card.', 'AUTO_PAY_OFF');
  if (!token || !method.customerToken) return refuse('The saved card cannot be used.', 'SAVED_METHOD_INVALID');

  let amountMinor;
  const code = String(currency || order.payment.currency || '').toUpperCase();
  try {
    amountMinor = shapes.toSafepayAmount(due.amount, code);
  } catch (error) {
    return refuse(error.message, error.code);
  }

  const orderRef = orderRefOf(order);
  let tracker;
  try {
    ({ token: tracker } = await api.createTracker(config, { amount: amountMinor, currency: code, mode: 'unscheduled_cof', customer: method.customerToken, orderRef }));
  } catch (error) {
    return refuse(error.message, error.code || 'SAFEPAY_ERROR');
  }
  await PackageOrder.updateOne(
    { _id: order._id },
    {
      $set: { 'payment.provider': 'safepay', 'payment.safepay.tracker': tracker },
      $push: {
        'payment.safepay.trackers': {
          token: tracker,
          purpose: due.purpose,
          kind: 'auto',
          amount: due.amount,
          amountMinor,
          currency: code,
          status: 'pending',
          customerToken: method.customerToken,
          savedMethodId: method.id ? String(method.id) : null,
          createdAt: new Date()
        }
      }
    }
  );
  await api.addMetadata(config, tracker, orderRef).catch(() => {});

  let state;
  try {
    let body = await api.runAction(config, tracker, { payload: { payment_method: { tokenized_card: { token } } } });
    state = (shapes.trackerOf(body) || {}).state;
    // Authorized but not captured: the capture is the order API run again
    // with an empty payload (docs: Card payments, step 7).
    if (String(state || '').toUpperCase() === 'TRACKER_AUTHORIZED') {
      body = await api.runAction(config, tracker, {});
      state = (shapes.trackerOf(body) || {}).state;
    }
  } catch (error) {
    // Safepay said no (a decline, an expired card): the link goes out instead.
    // Not reached, or a server error: the charge may still have happened --
    // the webhook settles it.
    const refused = error && error.code !== 'SAFEPAY_UNREACHABLE' && error.safepayStatus && error.safepayStatus < 500;
    if (refused) {
      await markTrackerFailed(order, tracker, error.message);
      return { status: 'failed', tracker, reason: error.message, code: error.code === 'SAFEPAY_AUTH_FAILED' ? 'SAFEPAY_AUTH_FAILED' : 'CARD_DECLINED' };
    }
    return { status: 'pending', tracker, reason: 'Safepay did not confirm the charge yet; it will be recorded when it does.', code: 'SAFEPAY_PENDING' };
  }

  const status = shapes.mapTrackerState(state);
  if (status === 'paid') {
    await applyTrackerPayment(order, tracker, { amountMinor, currency: code, what: `automatic charge, tracker ${tracker}` });
    return { status: 'paid', tracker, reason: '' };
  }
  if (status === 'failed') {
    const reason = `The card was not charged (${state}).`;
    await markTrackerFailed(order, tracker, reason);
    return { status: 'failed', tracker, reason, code: 'CARD_DECLINED' };
  }
  return { status: 'pending', tracker, reason: `Safepay has not completed the charge yet (${state || 'no state'}).`, code: 'SAFEPAY_PENDING' };
}

/* --------------------------------- webhook --------------------------------- */

async function orderForEvent(info) {
  if (info.tracker) {
    const byTracker = await PackageOrder.findOne({ 'payment.safepay.trackers.token': info.tracker });
    if (byTracker) return byTracker;
  }
  if (info.orderRef) {
    const byRef = await PackageOrder.findOne({ orderNumber: info.orderRef, 'payment.provider': 'safepay' });
    if (byRef) return byRef;
  }
  return null;
}

function eventTime(event) {
  const data = (event && event.data) || {};
  const stamp = data.charged_at || event.created_at;
  const seconds = stamp && Number(stamp.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/**
 * Applies a verified Safepay event (verifyWebhook) for the gym in context.
 *
 * A payment that succeeded is applied (once); a failed attempt is noted and
 * leaves the order payable; refunds, voids and reversals are noted on the
 * tracker and logged -- the membership is not changed by them. Anything
 * else that names one of our trackers is checked with Safepay and applied
 * as Safepay then says. An event for no order here is acknowledged.
 *
 * @returns {Promise<{ received: true, applied?: boolean, ignored?: string }>}
 * @throws MembershipError 409 ACTIVATION_IN_PROGRESS / BALANCE_CHANGED: answer
 *   with a non-2xx so Safepay sends it again
 */
async function handleWebhookEvent(event) {
  const info = shapes.readEvent(event);
  if (!info.tracker) return { received: true, ignored: 'no tracker in the event' };
  const order = await orderForEvent(info);
  if (!order || !trackerRecord(order, info.tracker)) {
    console.warn(`[safepay] ${info.type || 'event'} for ${info.tracker} ignored: no order here for it (order reference ${info.orderRef || 'none'})`);
    return { received: true, ignored: 'no order here for it' };
  }
  const what = `${info.type || 'event'} ${info.id || ''} (tracker ${info.tracker})`.replace(/\s+/g, ' ');

  if (info.outcome === 'paid') {
    const result = await applyTrackerPayment(order, info.tracker, { ...info, at: eventTime(event), what });
    return { received: true, applied: !!result.applied };
  }
  if (info.outcome === 'failed') {
    await markTrackerFailed(order, info.tracker, info.message || 'The payment did not go through');
    return { received: true };
  }
  if (info.outcome === 'refunded') {
    await PackageOrder.updateOne(
      { _id: order._id, 'payment.safepay.trackers.token': info.tracker },
      { $set: { 'payment.safepay.trackers.$.status': 'refunded' } }
    );
    console.warn(`[safepay] ${what}: refunded, voided or reversed at Safepay for order ${order.orderNumber}. The membership is unchanged; record the refund on the order if the member should lose it.`);
    return { received: true };
  }

  // A kind of event not handled above: Safepay is asked what happened.
  const details = await trackerDetails(info.tracker);
  if (details.status === 'paid') {
    const result = await applyTrackerPayment(order, info.tracker, { ...details, what });
    return { received: true, applied: !!result.applied };
  }
  if (details.status === 'failed') await markTrackerFailed(order, info.tracker, `Safepay reports ${details.state}`);
  return { received: true };
}

module.exports = {
  MAX_TRACKERS_PER_ORDER,
  createCheckout,
  chargeSavedMethod,
  fetchTrackerStatus,
  trackerDetails,
  verifyOrderPayment,
  verifyTrackerPayment,
  applyTrackerPayment,
  markTrackerFailed,
  handleWebhookEvent,
  autoChargeEnabled,
  amountDue,
  trackerRecord,
  internationalPhone
};
