// src/gymfolio/controller/gymfolioPaymentController.js
//
// Selling a package: Stripe Checkout, the desk (cash / bank / card in
// person), and the webhook that keeps Stripe and the orders in step. What
// happens to a membership afterwards lives in membershipController.

const mongoose = require('mongoose');
const gymfolioPaymentService = require('../../services/gymfolioPaymentService');
const PackageOrder = require('../models/packageOrderModel');
const Package = require('../models/packageModel');
const User = require('../../models/user');
const Settings = require('../../models/settings');
const { sweepIfDue } = require('../services/membershipExpiry');
const notify = require('../../services/gymNotifications');
const { afterResponse } = require('../../services/afterResponse');
const membership = require('../services/membershipService');
const { getStripe, stripeConfig, cardPaymentsStatus, StripeNotConfiguredError } = require('../../services/stripeClient');
const { activeBanks } = require('./membershipController');

function userIdOf(req) {
  return req.user ? req.user._id || req.user.id : null;
}

function fail(res, error, fallback) {
  if (error instanceof StripeNotConfiguredError || error instanceof membership.MembershipError) {
    return res.status(error.status || 400).json({ success: false, message: error.message, code: error.code || undefined });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: error.message || fallback });
}

const gymfolioPaymentController = {
  /**
   * POST /api/gymfolio/package-orders/assign
   *
   * Staff creating a membership without checkout: cash, bank, a card
   * charged on the desk terminal or a mobile wallet taken in person, or a
   * comped package.
   *
   * { userId, packageId, paymentMethod?, markPaid?, couponCode?, durationMonths?,
   *   startDate? | startAfterDays?, discountAmount?, discountNote?,
   *   amountOverride? (or amount), waiveJoiningFee?, amountPaid?, trainerId?,
   *   trainerFee?, trainerCommissionType?, trainerCommissionValue?, notes?,
   *   requestId? }
   * -- the desk terms are read and checked by membershipService.readDeskTerms
   * (400 INVALID_TERMS naming the field).
   *
   * `requestId` is the desk's own id for this sale. Sent again after a lost
   * reply, the answer is the order already made (`repeated: true`), not a
   * second one stacked on it.
   */
  async assignPackageToUser(req, res) {
    try {
      const body = req.body || {};
      const { userId, packageId, markPaid = true, durationMonths, couponCode } = body;
      if (!userId || !packageId) {
        return res.status(400).json({ success: false, message: 'userId and packageId are required' });
      }
      if (!mongoose.Types.ObjectId.isValid(String(userId))) return res.status(404).json({ success: false, message: 'User not found' });
      if (!mongoose.Types.ObjectId.isValid(String(packageId))) return res.status(404).json({ success: false, message: 'Package not found' });
      const terms = membership.readDeskTerms(body);

      const [user, pkg] = await Promise.all([
        User.findById(userId).select('firstName lastName email emailVerified phone addresses'),
        Package.findById(packageId)
      ]);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

      const order = await membership.createManualOrder({
        ...terms,
        user,
        pkg,
        markPaid: markPaid !== false && markPaid !== 'false',
        durationMonths,
        couponCode,
        paidBy: userIdOf(req),
        by: req.user && req.user.email
      });

      const repeated = membership.isRepeat(order);
      if (order.payment.status === 'paid' && !repeated) afterResponse(notify.membershipConfirmed(order, user), 'membershipConfirmed');

      const who = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'the member';
      return res.status(201).json({ success: true, message: `${pkg.name} assigned to ${who}`, data: order, repeated: repeated || undefined });
    } catch (error) {
      return fail(res, error, 'Failed to assign package');
    }
  },

  /**
   * GET /api/gymfolio/payment/methods -- how this gym can be paid right now.
   * When card is off, `cardUnavailable` says why ({ code, reason }), so the
   * website can tell the member rather than just leave the option out.
   */
  async paymentMethods(req, res) {
    try {
      const [cardStatus, banks, settings] = await Promise.all([
        cardPaymentsStatus().catch(() => ({ available: false, code: null, reason: '' })),
        activeBanks().catch(() => []),
        Settings.getSettings().catch(() => null)
      ]);
      return res.json({
        success: true,
        data: {
          card: cardStatus.available,
          cardUnavailable: cardStatus.available ? null : { code: cardStatus.code, reason: cardStatus.reason },
          bankTransfer: banks.length > 0,
          banks,
          currency: (settings && settings.currency) || 'USD'
        }
      });
    } catch (error) {
      return fail(res, error, 'Failed to load payment methods');
    }
  },

  /** POST /api/gymfolio/payment/create-package-checkout-session */
  async createPackageCheckoutSession(req, res) {
    try {
      const { packageId, customerInfo, couponCode } = req.body || {};
      const userId = userIdOf(req);

      if (!packageId) return res.status(400).json({ success: false, message: 'Package ID is required' });
      if (!customerInfo || !customerInfo.email) {
        return res.status(400).json({ success: false, message: 'Customer information is required' });
      }

      const session = await gymfolioPaymentService.createPackageCheckoutSession(userId, packageId, customerInfo, { couponCode });
      return res.status(200).json({ success: true, sessionId: session.sessionId, url: session.url, orderNumber: session.orderNumber });
    } catch (error) {
      return fail(res, error, 'Failed to create checkout session');
    }
  },

  /** GET|POST /api/gymfolio/payment/verify/:sessionId */
  async verifyPackagePayment(req, res) {
    try {
      const { sessionId } = req.params;
      if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID is required' });
      const { success, paid, order } = await gymfolioPaymentService.verifyPackagePayment(sessionId);
      // Only what the checkout success page shows. Anyone holding the
      // session id can call this -- it sits in the success page's URL, and
      // so in browser history and analytics -- so the Stripe session (the
      // payer's name, email and address) and the order's customer details
      // stay on the server.
      return res.status(200).json({
        success,
        paid,
        order: order
          ? {
              orderNumber: order.orderNumber,
              packageId: order.packageId,
              packageName: (order.packageDetails && order.packageDetails.name) || '',
              amount: order.payment ? order.payment.amount : undefined,
              currency: order.payment ? order.payment.currency : undefined,
              status: order.status
            }
          : null
      });
    } catch (error) {
      return fail(res, error, 'Failed to verify payment');
    }
  },

  /** GET /api/gymfolio/payment/stripe-public-key -- this gym's publishable key. */
  async getPublicKey(req, res) {
    try {
      const cfg = await stripeConfig();
      if (!cfg.publishableKey || !cfg.enabled) {
        return res.status(404).json({ success: false, code: 'STRIPE_NOT_CONFIGURED', message: 'Card payments are not set up for this gym' });
      }
      return res.status(200).json({ success: true, publicKey: cfg.publishableKey });
    } catch (error) {
      return fail(res, error, 'Failed to get Stripe public key');
    }
  },

  /**
   * POST /api/gymfolio/payment/webhook[/:slug]
   *
   * The gym is already in context (from the slug, or from the event's
   * metadata for the legacy URL). The signature is checked against THAT
   * gym's signing secret; an event signed by anyone else is refused.
   */
  async handleWebhook(req, res) {
    try {
      const sig = req.headers['stripe-signature'];
      const cfg = await stripeConfig();
      if (!cfg.webhookSecret) {
        console.error('⚠️ Webhook secret not configured for this gym');
        return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
      }

      let event;
      try {
        const stripe = await getStripe();
        event = stripe.webhooks.constructEvent(req.body, sig, cfg.webhookSecret);
      } catch (err) {
        console.error('⚠️ Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      await gymfolioPaymentService.handleWebhook(event);
      return res.json({ received: true });
    } catch (error) {
      // Another request is recording this very payment: nothing failed, but
      // the event is not applied either. Anything but a 2xx has Stripe send
      // it again later (gymfolioPaymentService waitOutClaim).
      if (error && error.code === 'ACTIVATION_IN_PROGRESS') {
        return res.status(409).json({ received: false, inProgress: true, message: error.message });
      }
      console.error('❌ Error handling webhook:', error);
      return res.status(500).json({ success: false, message: 'Webhook handler failed' });
    }
  },

  /** GET /api/gymfolio/package-orders/:id -- the member's own order, or any for staff. */
  async getOrderById(req, res) {
    try {
      const { id, orderId } = req.params;
      const wanted = orderId || id;
      const { can } = require('../../services/roleService');
      // The live role, as loadOrder reads it: a demoted manager's token still
      // says "manager" until it expires.
      let role = req.roleSlug || null;
      const me = userIdOf(req);
      if (!role && me && mongoose.Types.ObjectId.isValid(String(me))) {
        const account = await User.findById(me).select('role isActive').lean();
        role = account && account.isActive !== false ? account.role : null;
      }
      const staff = !!role && (await can(role, 'package-orders', 'view'));
      // An id that is not one is not found either (getOrderById), never a 500.
      const order = await gymfolioPaymentService.getOrderById(wanted, staff ? null : userIdOf(req));
      if (!order) return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      return res.status(200).json({ success: true, data: order });
    } catch (error) {
      return fail(res, error, 'Failed to fetch order');
    }
  },

  /** GET /api/gymfolio/package-orders/me */
  async getUserOrders(req, res) {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

      const { page, limit, status, sort } = req.query;
      await sweepIfDue();
      const result = await gymfolioPaymentService.getUserOrders(userId, {
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
        status,
        sort
      });
      // A renewal waiting on its payment link carries the link, for the
      // portal's and the app's "Pay now" (services/billing/payLinks.js).
      const { withPayLinks } = require('../../services/billing/payLinks');
      return res.status(200).json({ success: true, data: withPayLinks(result.orders), pagination: result.pagination });
    } catch (error) {
      return fail(res, error, 'Failed to fetch orders');
    }
  },

  /** GET /api/gymfolio/package-orders (staff)  ?hasDues=1: only orders with a balance due */
  async getAllOrders(req, res) {
    try {
      const { page, limit, status, paymentStatus, paymentMethod, search, sort, hasDues } = req.query;
      await sweepIfDue();
      const result = await gymfolioPaymentService.getAllOrders({
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 20,
        status,
        paymentStatus,
        paymentMethod,
        search,
        hasDues: hasDues === '1' || hasDues === 'true',
        sort
      });
      return res.status(200).json({ success: true, data: result.orders, pagination: result.pagination });
    } catch (error) {
      return fail(res, error, 'Failed to fetch orders');
    }
  },

  /** PUT /api/gymfolio/package-orders/:id/status (staff) -- a blunt override, kept for the desk. */
  async updateOrderStatus(req, res) {
    try {
      const { id, orderId } = req.params;
      const { status } = req.body || {};
      if (!status) return res.status(400).json({ success: false, message: 'Status is required' });

      const validStatuses = ['pending', 'active', 'expired', 'cancelled', 'suspended', 'frozen', 'past_due'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }

      const wanted = orderId || id;
      const order = mongoose.Types.ObjectId.isValid(String(wanted || '')) ? await PackageOrder.findById(wanted) : null;
      if (!order) return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' });

      order.status = status;
      if (status === 'cancelled' || status === 'suspended' || status === 'expired') order.subscription.isActive = false;
      if (status === 'active') order.subscription.isActive = true;
      await order.save();

      return res.status(200).json({ success: true, message: 'Order status updated successfully', data: order });
    } catch (error) {
      return fail(res, error, 'Failed to update order status');
    }
  },

  /** POST /api/gymfolio/package-orders/:id/cancel-subscription -- the member, for themselves. */
  async cancelSubscription(req, res) {
    try {
      const { id, orderId } = req.params;
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

      const order = await gymfolioPaymentService.cancelSubscription(orderId || id, userId, (req.body && req.body.reason) || '');
      afterResponse(notify.membershipCancelled(order, await User.findById(userId).select('firstName lastName email').lean()), 'membershipCancelled');
      return res.status(200).json({
        success: true,
        message: order.status === 'cancelled' ? 'Subscription cancelled successfully' : 'Your membership will not renew.',
        data: order
      });
    } catch (error) {
      return fail(res, error, 'Failed to cancel subscription');
    }
  },

  /** GET /api/gymfolio/package-orders/:id/subscription-status */
  async getSubscriptionStatus(req, res) {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

      const result = await gymfolioPaymentService.getUserOrders(userId, { status: 'active', limit: 10 });
      const activeSubscriptions = result.orders.filter((order) => order.isSubscriptionActive());
      return res.status(200).json({ success: true, data: { activeSubscriptions, count: activeSubscriptions.length } });
    } catch (error) {
      return fail(res, error, 'Failed to fetch subscription status');
    }
  }
};

module.exports = gymfolioPaymentController;
