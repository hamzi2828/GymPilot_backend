// src/controller/payLinkController.js
//
// Payment links (services/billing/payLinks.js):
//
//   GET  /api/pay/:token            the page's data -- public, the link is the key
//   POST /api/pay/:token/checkout   opens the gym's online checkout for that order
//   POST /api/pay/:token/proof      a bank-transfer receipt, into the gym's verification queue
//   POST /api/gymfolio/package-orders/:id/pay-link   staff: the link, and send it
//   GET    /api/billing/me/saved-methods      the member's saved cards
//   DELETE /api/billing/me/saved-methods/:id  remove one: automatic payment stops
//
// The public pair sits behind the tenant gate like every gym route: the page
// is on the gym's own site, and the token is checked against that gym, so a
// link carried to another gym's site is simply invalid. It answers for one
// order and shows only what the page needs -- the member's first name, never
// their email or phone.

const mongoose = require('mongoose');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const User = require('../models/user');
const Settings = require('../models/settings');
const { issuePayLink, verifyPayToken, payUrl } = require('../services/billing/payLinks');
const { activeProvider, canCheckout, canSaveCards, canAutoCharge, onlineLabel } = require('../services/billing/provider');
const { activeBanks, bankView } = require('../services/billing/banks');
const { billingSettings } = require('../services/billing/settings');
const { metadataOf } = require('../services/billing/dueRenewals');
const { gymName, sendBillingMessage, periodLabel } = require('../services/billing/billingMessages');
const savedMethods = require('../services/billing/savedMethods');
const proofs = require('../services/billing/proofs');
const membership = require('../gymfolio/services/membershipService');
const notify = require('../services/gymNotifications');
const { afterResponse } = require('../services/afterResponse');

const PAID = ['paid'];
const CLOSED = ['refunded', 'cancelled'];

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

/** What the page shows the order as: due, paid, expired or cancelled. */
function linkStatus(order, expired) {
  const payment = (order && order.payment) || {};
  if (PAID.includes(payment.status)) return 'paid';
  if (CLOSED.includes(payment.status) || order.status === 'cancelled') return 'cancelled';
  return expired ? 'expired' : 'due';
}

async function pageData(order, { status, provider, banks, settings }) {
  let firstName = '';
  if (order.userId) {
    const member = await User.findById(order.userId).select('firstName').lean().catch(() => null);
    firstName = (member && member.firstName) || '';
  }
  if (!firstName && order.customerInfo && order.customerInfo.fullName) firstName = String(order.customerInfo.fullName).split(' ')[0];
  const pay = order.payment || {};
  return {
    gym_name: gymName(settings),
    member_first_name: firstName,
    package_name: (order.packageDetails && order.packageDetails.name) || '',
    period: periodLabel(order.packageDetails),
    amount: pay.amount,
    currency: String(pay.currency || '').toUpperCase(),
    due_date: metadataOf(order, 'dueDate') || null,
    last_day: metadataOf(order, 'lastDay') || null,
    status,
    // The gym's gateway (null: none), and whether it takes a payment on its
    // own page -- a bank-transfer-only gateway ('generic') does not.
    provider: provider ? provider.id || null : null,
    online_label: status === 'due' && canCheckout(provider) ? onlineLabel(provider) : null,
    order_number: order.orderNumber || '',
    // Always offered when the gym has an account, whatever the gateway:
    // transfer to it (Raast / IBFT, no fee) and upload the receipt here.
    banks: banks.map(bankView),
    can_upload_proof: status === 'due' && banks.length > 0,
    proof: proofs.proofView(order),
    // Whether the gym charges saved cards on the due date through this
    // gateway, and so whether the "save my card and pay automatically" box
    // may be offered.
    auto_pay_available: billingSettings(settings).autoCharge.enabled && canAutoCharge(provider),
    can_save_card: status === 'due' && canSaveCards(provider) && billingSettings(settings).autoCharge.enabled
  };
}

/**
 * The order a token opens, or the refusal to send: 400 LINK_INVALID for a
 * token that is not this gym's (made up, tampered with, or its order gone).
 */
async function orderForToken(req, res) {
  const read = verifyPayToken(req.params.token);
  if (!read.ok && read.reason === 'invalid') {
    fail(res, 400, 'LINK_INVALID', 'This payment link is not valid. Please use the latest link the gym sent you, or ask at the front desk.');
    return null;
  }
  const order = await PackageOrder.findById(read.orderId);
  if (!order) {
    fail(res, 400, 'LINK_INVALID', 'This payment link is not valid. Please use the latest link the gym sent you, or ask at the front desk.');
    return null;
  }
  return { order, expired: read.reason === 'expired', read };
}

const EXPIRED_MESSAGE = 'This payment link has expired. Ask the gym for a new one, or pay at the front desk.';

const payLinkController = {
  /** GET /api/pay/:token */
  async show(req, res) {
    try {
      const found = await orderForToken(req, res);
      if (!found) return undefined;
      const { order, expired } = found;
      const [settings, banks, provider] = await Promise.all([Settings.getSettings().catch(() => null), activeBanks(), activeProvider()]);
      const status = linkStatus(order, expired);
      const data = await pageData(order, { status, provider, banks, settings });
      if (status === 'expired') return fail(res, 410, 'LINK_EXPIRED', EXPIRED_MESSAGE, { data });
      return res.json({ success: true, data });
    } catch (error) {
      console.error('[pay] show failed:', error);
      return fail(res, 500, 'SERVER_ERROR', 'The payment page could not be loaded. Please try again in a moment.');
    }
  },

  /** POST /api/pay/:token/checkout  { saveCard?, autoPayConsent? } -> { url } */
  async checkout(req, res) {
    try {
      const found = await orderForToken(req, res);
      if (!found) return undefined;
      const { order, expired } = found;
      const status = linkStatus(order, expired);
      if (status === 'paid') return res.json({ success: true, status: 'paid', url: null, data: { status: 'paid' } });
      if (status === 'expired') return fail(res, 410, 'LINK_EXPIRED', EXPIRED_MESSAGE);
      if (status === 'cancelled') {
        return fail(res, 409, 'LINK_CANCELLED', 'This payment is no longer needed: the membership was renewed another way or the order was closed.');
      }
      if (order.payment.status === 'processing') {
        return fail(
          res,
          409,
          'PAYMENT_IN_PROGRESS',
          order.payment.method === 'bank_transfer'
            ? 'Your bank transfer receipt is with the gym to confirm. You will hear from them once it is checked.'
            : 'A payment for this order is being recorded right now. Refresh the page in a moment.'
        );
      }

      const [settings, provider] = await Promise.all([Settings.getSettings().catch(() => null), activeProvider()]);
      if (!canCheckout(provider)) {
        return fail(res, 409, 'ONLINE_PAYMENT_UNAVAILABLE', 'This gym does not take online payments yet. Pay by bank transfer to the account shown, or at the front desk.');
      }

      // Saving the card for automatic payments needs the member to have
      // ticked the consent box, the gym to have switched automatic charges
      // on, and a gateway that keeps cards. Otherwise it is a plain payment.
      const body = req.body || {};
      const saveCard = body.saveCard === true && body.autoPayConsent === true && billingSettings(settings).autoCharge.enabled && canSaveCards(provider);
      if (saveCard) {
        order.metadata = order.metadata || new Map();
        order.metadata.set('autoPayConsent', 'true');
        order.metadata.set('autoPayConsentAt', new Date().toISOString());
        await order.save();
      }

      const { token } = req.params;
      const page = payUrl(token);
      const customer = {
        name: (order.customerInfo && order.customerInfo.fullName) || '',
        email: (order.customerInfo && order.customerInfo.email) || '',
        phone: (order.customerInfo && order.customerInfo.phone) || ''
      };
      let result;
      try {
        result = await provider.createCheckout({
          order,
          amount: order.payment.amount,
          currency: String(order.payment.currency || '').toUpperCase(),
          customer,
          returnUrl: `${page}?done=1`,
          cancelUrl: page,
          saveCard,
          autoPayConsent: saveCard,
          source: 'pay_link'
        });
      } catch (error) {
        const status4xx = error && Number(error.status) >= 400 && Number(error.status) < 500;
        console.error('[pay] checkout could not be opened:', error && error.message);
        if (status4xx) return fail(res, error.status, error.code || 'CHECKOUT_FAILED', error.message);
        return fail(res, 502, 'CHECKOUT_FAILED', 'The payment page could not be opened. Please try again in a moment.');
      }
      if (!result || !result.url) return fail(res, 502, 'CHECKOUT_FAILED', 'The payment page could not be opened. Please try again in a moment.');
      return res.json({ success: true, url: result.url, save_card: saveCard });
    } catch (error) {
      console.error('[pay] checkout failed:', error);
      return fail(res, 500, 'SERVER_ERROR', 'The payment page could not be opened. Please try again in a moment.');
    }
  },

  /**
   * POST /api/pay/:token/proof   multipart: proof (photo or PDF), note?, reference?
   * -> { success, data: { proof: { status, reason, submitted_at } } }
   *
   * The order goes into the gym's bank-transfer verification exactly as the
   * member's own receipt upload puts it there (membershipService.
   * submitTransferProof): staff see it under "Bank transfers to confirm".
   */
  async proof(req, res) {
    try {
      const found = await orderForToken(req, res);
      if (!found) return undefined;
      const { order, expired } = found;
      const status = linkStatus(order, expired);
      if (status === 'paid') return fail(res, 409, 'ALREADY_PAID', 'This order is already paid.');
      if (status === 'expired') return fail(res, 410, 'LINK_EXPIRED', EXPIRED_MESSAGE);
      if (status === 'cancelled') {
        return fail(res, 409, 'LINK_CANCELLED', 'This payment is no longer needed: the membership was renewed another way or the order was closed.');
      }
      if (!(await activeBanks()).length) {
        return fail(res, 409, 'BANK_TRANSFER_UNAVAILABLE', 'This gym has no bank account set up for transfers. Pay online, or at the front desk.');
      }
      const body = req.body || {};
      const { storedProofUrl } = require('../gymfolio/controller/membershipController');
      const url = await storedProofUrl(req.file);
      if (!url && !(body.reference || body.note)) {
        return fail(res, 400, 'PROOF_REQUIRED', 'Attach a screenshot or PDF of the transfer receipt.');
      }

      const ready = await proofs.readyForReceipt(order);
      if (!ready) return fail(res, 409, 'PAYMENT_IN_PROGRESS', 'A payment for this order is being recorded right now. Refresh the page in a moment.');
      let updated;
      try {
        updated = await membership.submitTransferProof(ready, { url, note: body.note, reference: body.reference });
      } catch (error) {
        if (error instanceof membership.MembershipError) return fail(res, error.status || 400, error.code || 'PROOF_REFUSED', error.message);
        throw error;
      }
      // "We have your receipt" to the member; staff see it in their queue.
      afterResponse(async () => {
        const member = updated.userId ? await User.findById(updated.userId).select('firstName lastName email').lean() : null;
        return notify.transferReceived(updated, member);
      }, 'transferReceived');
      return res.json({
        success: true,
        message: 'Thanks. The gym will confirm your payment once the transfer is checked.',
        data: { proof: proofs.proofView(updated) }
      });
    } catch (error) {
      console.error('[pay] receipt upload failed:', error);
      return fail(res, 500, 'SERVER_ERROR', 'The receipt could not be uploaded. Please try again.');
    }
  },

  /**
   * POST /api/gymfolio/package-orders/:id/pay-link  { send?: boolean }  (staff)
   * -> { url, expires_at, sent?: { email, sms, whatsapp, push } }
   */
  async adminLink(req, res) {
    try {
      const id = String(req.params.id || '');
      const order = mongoose.Types.ObjectId.isValid(id) ? await PackageOrder.findById(id) : null;
      if (!order) return fail(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
      const payment = order.payment || {};
      if (payment.status === 'paid') return fail(res, 409, 'ALREADY_PAID', 'This order is already paid.');
      if (CLOSED.includes(payment.status) || order.status === 'cancelled') {
        return fail(res, 409, 'ORDER_CLOSED', 'This order is closed, so there is nothing to pay. Start a new order for the package instead.');
      }
      if (payment.status === 'processing') {
        return fail(res, 409, 'PAYMENT_IN_PROGRESS', 'A payment for this order is waiting to be checked (a bank transfer receipt) or being recorded. Deal with that first.');
      }

      const link = issuePayLink(order);
      const body = req.body || {};
      const wantsSend = body.send === true || body.send === 'true';
      let sent;
      let skipped;
      if (wantsSend) {
        const by = req.user ? req.user._id || req.user.id : null;
        const outcome = await sendBillingMessage(order, 'link', { link, sentBy: by && mongoose.Types.ObjectId.isValid(String(by)) ? by : null });
        sent = outcome.sent;
        skipped = outcome.skipped;
      }
      const data = { url: link.url, expires_at: link.expiresAt.toISOString(), ...(sent ? { sent, skipped } : {}) };
      return res.json({ success: true, ...data, data });
    } catch (error) {
      console.error('[pay] admin link failed:', error);
      return fail(res, 500, 'SERVER_ERROR', 'The payment link could not be made.');
    }
  },

  /** GET /api/billing/me/saved-methods -> { data: [{ id, brand, last4, exp_month, exp_year, auto_pay, consent_at, ... }] } */
  async listSavedMethods(req, res) {
    try {
      const me = req.user ? req.user._id || req.user.id : null;
      if (!me) return fail(res, 401, 'AUTH_REQUIRED', 'Please sign in.');
      return res.json({ success: true, data: await savedMethods.listSavedMethods(me) });
    } catch (error) {
      console.error('[billing] saved cards could not be listed:', error);
      return fail(res, 500, 'SERVER_ERROR', 'Your saved cards could not be loaded.');
    }
  },

  /** DELETE /api/billing/me/saved-methods/:id -> { success } -- automatic payment stops at once. */
  async removeSavedMethod(req, res) {
    try {
      const me = req.user ? req.user._id || req.user.id : null;
      if (!me) return fail(res, 401, 'AUTH_REQUIRED', 'Please sign in.');
      const removed = await savedMethods.removeSavedMethod(me, req.params.id);
      if (!removed) return fail(res, 404, 'SAVED_METHOD_NOT_FOUND', 'That saved card was not found on your account.');
      return res.json({ success: true, message: 'Card removed. Automatic payments are off.' });
    } catch (error) {
      console.error('[billing] saved card could not be removed:', error);
      return fail(res, 500, 'SERVER_ERROR', 'The card could not be removed. Please try again.');
    }
  }
};

module.exports = payLinkController;
