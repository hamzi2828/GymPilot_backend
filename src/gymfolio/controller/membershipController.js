// src/gymfolio/controller/membershipController.js
//
// What happens to a membership after the sale: bank transfers and their
// approval, freezing, cancelling, renewing, switching package, using up a
// pack, invoices, and the Stripe billing portal.
//
// Most of these can be reached by the member themselves (for their own
// order) or by staff holding the package-orders permission. `loadOrder`
// works out which, and the service applies the member-side rules.

const mongoose = require('mongoose');
const PackageOrder = require('../models/packageOrderModel');
const Package = require('../models/packageModel');
const Bank = require('../../models/bank');
const User = require('../../models/user');
const service = require('../services/membershipService');
const notify = require('../../services/gymNotifications');
const { can } = require('../../services/roleService');
const { frontendOrigin } = require('../../platform/tenantContext');
const { ensureInvoice, renderInvoicePdf } = require('../../services/invoiceService');
const { afterResponse } = require('../../services/afterResponse');
const { willAutoRenew } = require('../../services/reminderJobs');

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

function fail(res, error) {
  if (error instanceof service.MembershipError || (error && error.status && error.message)) {
    return res.status(error.status || 400).json({ success: false, message: error.message, code: error.code || undefined });
  }
  console.error('[membership]', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

function userId(req) {
  return req.user ? req.user._id || req.user.id : null;
}

/**
 * Loads an order and decides who is acting on it.
 * @returns {Promise<{order, source: 'member'|'staff'}>}  throws with status on refusal
 */
async function loadOrder(req, { staffLevel = 'manage', allowMember = true } = {}) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new service.MembershipError('Order not found', 404);
  const order = await PackageOrder.findById(id);
  if (!order) throw new service.MembershipError('Order not found', 404);

  const me = userId(req);
  const isOwner = me && order.userId && String(order.userId) === String(me);

  // The account's live role, never the one written into its token: a
  // manager demoted this morning still carries "manager" in a token that
  // may have weeks left to run. requirePermission has already read it on
  // the routes it guards; everywhere else it is read here.
  let role = req.roleSlug || null;
  if (!role && me && mongoose.Types.ObjectId.isValid(String(me))) {
    const account = await User.findById(me).select('role isActive').lean();
    role = account && account.isActive !== false ? account.role : null;
  }
  const isStaff = !!role && (await can(role, 'package-orders', staffLevel));

  if (isStaff) return { order, source: 'staff' };
  if (isOwner && allowMember) return { order, source: 'member' };
  throw new service.MembershipError('You do not have access to this order', 403);
}

async function memberOf(order) {
  return order.userId ? User.findById(order.userId).select('firstName lastName email').lean() : null;
}

/**
 * Tells the member (notify[name]) once the response is on its way.
 * afterResponse keeps the send alive on Vercel and logs a failure rather
 * than dropping it; the member is looked up inside that work too, so a slow
 * or failed lookup never holds up, or fails, the request that did the work.
 */
function tell(name, order) {
  return afterResponse(async () => notify[name](order, await memberOf(order)), name);
}

async function activeBanks() {
  return Bank.find({ isActive: true, isDeleted: { $ne: true } })
    .select('name accountTitle accountNumber branch iban notes qrCodeUrl')
    .sort({ createdAt: 1 })
    .lean();
}

module.exports = {
  activeBanks,

  // GET /api/gymfolio/payment/banks -- where to send a bank transfer
  banks: async (req, res) => {
    try {
      return res.json({ success: true, data: await activeBanks() });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/payment/bank-transfer   { packageId, customerInfo, couponCode }
  createBankTransfer: async (req, res) => {
    try {
      const { packageId, customerInfo, couponCode } = req.body || {};
      if (!packageId) return res.status(400).json({ success: false, message: 'Package ID is required' });
      const banks = await activeBanks();
      if (!banks.length) return res.status(409).json({ success: false, message: 'Bank transfer is not available at this gym' });

      const [user, pkg] = await Promise.all([User.findById(userId(req)), Package.findById(packageId)]);
      if (!user) return res.status(401).json({ success: false, message: 'Please sign in to pay by bank transfer' });
      if (!pkg || !pkg.isActive) return res.status(404).json({ success: false, message: 'Package not found' });

      const order = await service.createBankTransferOrder({ user, pkg, customerInfo: customerInfo || {}, couponCode });
      return res.status(201).json({ success: true, data: order, banks });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/proof   multipart: proof (image) + note, reference
  submitProof: async (req, res) => {
    try {
      const { order } = await loadOrder(req, { staffLevel: 'manage' });
      let url = '';
      if (req.file) {
        url = USE_BLOB_STORAGE
          ? await blobUpload.uploadToBlob(req.file.buffer, req.file.originalname, req.file.mimetype, 'payment-proofs')
          : `/uploads/${req.file.filename}`;
      }
      if (!url && !(req.body && (req.body.reference || req.body.note))) {
        return res.status(400).json({ success: false, message: 'Attach the transfer receipt or enter the transfer reference' });
      }
      await service.submitTransferProof(order, { url, note: req.body && req.body.note, reference: req.body && req.body.reference });
      tell('transferReceived', order);
      return res.json({ success: true, message: 'Thanks — we will confirm your membership once the transfer is checked.', data: order });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/approve  (staff)
  approve: async (req, res) => {
    try {
      const order = await PackageOrder.findById(req.params.id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      await service.approveTransfer(order, { by: userId(req) });
      tell('membershipConfirmed', order);
      return res.json({ success: true, message: `Payment confirmed. ${order.packageDetails.name} is now active.`, data: order });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/reject  (staff)  { reason }
  reject: async (req, res) => {
    try {
      const order = await PackageOrder.findById(req.params.id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      await service.rejectTransfer(order, { by: userId(req), reason: req.body && req.body.reason });
      tell('transferRejected', order);
      return res.json({ success: true, message: 'Payment rejected and the member has been told.', data: order });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/freeze   { days, reason }
  freeze: async (req, res) => {
    try {
      const { order, source } = await loadOrder(req);
      await service.freeze(order, { days: req.body && req.body.days, reason: req.body && req.body.reason, by: userId(req), source });
      tell('membershipFrozen', order);
      // On a card subscription the next payment moved with the freeze; say so.
      const nextCharge = order.freeze.billing === service.FREEZE_STRIPE && order.subscription.endDate
        ? ` The next card payment moves to ${new Date(order.subscription.endDate).toDateString()}.`
        : '';
      return res.json({ success: true, message: `Membership frozen until ${new Date(order.freeze.resumeAt).toDateString()}.${nextCharge}`, data: order });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/unfreeze
  unfreeze: async (req, res) => {
    try {
      const { order, source } = await loadOrder(req);
      await service.unfreeze(order, { by: userId(req), source });
      return res.json({ success: true, message: 'Membership resumed.', data: order });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/cancel   { reason, immediate }
  cancel: async (req, res) => {
    try {
      const { order, source } = await loadOrder(req);
      const body = req.body || {};
      await service.cancel(order, {
        reason: body.reason || '',
        by: userId(req),
        source,
        immediate: source === 'staff' && (body.immediate === true || body.immediate === 'true')
      });
      tell('membershipCancelled', order);
      const ends = order.subscription && order.subscription.endDate ? new Date(order.subscription.endDate) : null;
      return res.json({
        success: true,
        message:
          order.status === 'cancelled'
            ? 'Membership cancelled.'
            : `Membership will not renew. Access continues until ${ends ? ends.toDateString() : 'the end of the period'}.`,
        data: order
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/resume  -- undo a cancel-at-period-end
  resume: async (req, res) => {
    try {
      const { order } = await loadOrder(req);
      await service.resume(order, { by: userId(req) });
      return res.json({ success: true, message: 'Membership will renew as normal.', data: order });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/renew  (staff)  { paymentMethod, markPaid, months, notes, force }
  //
  // A card subscription renews itself: a manual renewal on top would be paid
  // for twice. One whose card payment failed is Stripe's to collect, not a
  // term to sell again at the desk. Both are refused (409) unless `force` --
  // the desk has checked, and means it.
  renew: async (req, res) => {
    try {
      const order = await PackageOrder.findById(req.params.id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      const body = req.body || {};
      const force = body.force === true || body.force === 'true';
      if (!force && order.status === 'past_due' && order.payment && order.payment.stripeSubscriptionId) {
        throw new service.MembershipError('Card payment failed — ask the member to update their card.', 409, 'CARD_PAYMENT_FAILED');
      }
      if (!force && willAutoRenew(order)) {
        throw new service.MembershipError(
          'This membership is billed automatically by card — a manual renewal would charge twice.',
          409,
          'AUTO_RENEWS'
        );
      }
      const renewal = await service.renew(order, {
        paymentMethod: body.paymentMethod,
        markPaid: body.markPaid !== false && body.markPaid !== 'false',
        months: body.months,
        notes: body.notes,
        by: req.user && req.user.email
      });
      if (renewal.payment.status === 'paid') tell('membershipConfirmed', renewal);
      return res.status(201).json({ success: true, message: `Renewed: ${renewal.orderNumber} runs until ${new Date(renewal.subscription.endDate).toDateString()}.`, data: renewal });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/change-package  (staff)  { packageId, paymentMethod, markPaid, notes }
  changePackage: async (req, res) => {
    try {
      const order = await PackageOrder.findById(req.params.id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      const body = req.body || {};
      const result = await service.changePackage(order, {
        packageId: body.packageId,
        paymentMethod: body.paymentMethod,
        markPaid: body.markPaid !== false && body.markPaid !== 'false',
        notes: body.notes,
        by: req.user && req.user.email
      });
      if (result.order.payment.status === 'paid' && result.previous) tell('membershipConfirmed', result.order);
      return res.status(201).json({
        success: true,
        message: result.credit !== null ? `Package changed. ${result.credit} credited for unused days.` : 'Subscription switched; Stripe will prorate the difference.',
        data: result.order,
        previous: result.previous,
        credit: result.credit
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/refund  (staff)  { amount?, reason }
  //
  // Card payments are refunded at Stripe (the whole charge unless an amount
  // is given); cash, bank and terminal payments are recorded as refunded.
  // Either way the membership ends now and any subscription behind it stops.
  refund: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ success: false, message: 'Order not found' });
      const order = await PackageOrder.findById(req.params.id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      const body = req.body || {};
      await service.refund(order, { amount: body.amount, reason: body.reason, by: userId(req) });
      const money = `${String(order.payment.currency || '').toUpperCase()} ${Number(order.refund.amount || 0).toFixed(2)}`;
      return res.json({
        success: true,
        message: order.refund.stripeRefundId
          ? `${money} refunded to the card; the membership has been cancelled.`
          : `${money} recorded as refunded; the membership has been cancelled.`,
        data: order
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/use-session  (staff)  { note }
  useSession: async (req, res) => {
    try {
      const order = await PackageOrder.findById(req.params.id);
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      const updated = await service.consumeSession(order, { by: userId(req), note: req.body && req.body.note });
      if (!updated) return res.status(400).json({ success: false, message: 'This order is not a session pack' });
      return res.json({ success: true, message: `${updated.sessions.total - updated.sessions.used} session(s) left.`, data: updated });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/gymfolio/package-orders/:id/invoice.pdf
  invoicePdf: async (req, res) => {
    try {
      const { order } = await loadOrder(req, { staffLevel: 'view' });
      if (order.payment.status !== 'paid') return res.status(400).json({ success: false, message: 'An invoice is issued once the order is paid' });
      await ensureInvoice(order);
      const pdf = await renderInvoicePdf(order);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${order.invoice.number}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/:id/billing-portal  -- update card / see Stripe invoices
  billingPortal: async (req, res) => {
    try {
      const { order } = await loadOrder(req);
      const url = await service.billingPortalUrl(order, `${frontendOrigin()}/user-detail?tab=history`);
      return res.json({ success: true, url });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/gymfolio/membership/rules -- what members may do themselves
  rules: async (req, res) => {
    try {
      const { allowMemberFreeze, maxFreezeDays, allowMemberCancel } = await service.membershipSettings();
      return res.json({ success: true, data: { allowMemberFreeze, maxFreezeDays, allowMemberCancel } });
    } catch (error) {
      return fail(res, error);
    }
  }
};
