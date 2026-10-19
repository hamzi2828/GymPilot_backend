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
const { getStripe, stripeConfig, StripeNotConfiguredError } = require('../../services/stripeClient');
const { activeBanks } = require('./membershipController');

function userIdOf(req) {
  return req.user ? req.user._id || req.user.id : null;
}

// Errors that carry the answer to give: their status, their sentence, their code.
const ANSWERED = new Set(['MembershipError', 'SafepayError', 'PaymentGatewayError']);

function fail(res, error, fallback) {
  if (error instanceof StripeNotConfiguredError || error instanceof membership.MembershipError || (error && ANSWERED.has(error.name) && error.status)) {
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
   *
   * `card` is the online checkout (create-package-checkout-session), through
   * whichever gateway the gym chose (services/payments): Stripe as always, or
   * Safepay. `online` names that gateway and what to call the option:
   * { provider: 'safepay', label: 'Card, JazzCash, Easypaisa or any bank app' },
   * { provider: 'stripe', label: 'Card' }, { provider: 'generic', label:
   * 'Bank transfer — upload your receipt' } (no checkout of its own: members
   * use the bank transfer), or null when nothing can be paid online now.
   */
  async paymentMethods(req, res) {
    try {
      const payments = require('../../services/payments');
      const settings = await Settings.getSettings().catch(() => null);
      const [online, banks] = await Promise.all([
        payments.onlineStatus(settings).catch(() => ({ provider: null, available: false, checkout: false, code: null, reason: '' })),
        activeBanks().catch(() => [])
      ]);
      const card = !!online.checkout;
      let cardUnavailable = null;
      if (!card) {
        cardUnavailable = online.available
          ? { code: 'BANK_TRANSFER_ONLY', reason: 'This gym takes payment by bank transfer.' }
          : { code: online.code, reason: online.reason };
      }
      return res.json({
        success: true,
        data: {
          card,
          cardUnavailable,
          bankTransfer: banks.length > 0,
          banks,
          currency: (settings && settings.currency) || 'USD',
          online: online.available && online.provider ? { provider: online.provider, label: online.label } : null
        }
      });
    } catch (error) {
      return fail(res, error, 'Failed to load payment methods');
    }
  },

  /**
   * POST /api/gymfolio/payment/create-package-checkout-session
   *   { packageId, customerInfo, couponCode?, saveCard?, autoPayConsent? }
   *
   * A new purchase, paid online through the gateway the gym chose
   * (services/payments): Stripe Checkout as always, or Safepay's hosted
   * checkout. `saveCard` + `autoPayConsent` (both true) ask Safepay to keep
   * the card for automatic payments; honoured only at a gym with auto-charge
   * on, for a signed-in member. Answers { url } to send the browser to;
   * `sessionId` for Stripe, `orderId` for the other gateways (the success
   * page's verify call takes either).
   */
  async createPackageCheckoutSession(req, res) {
    try {
      const { packageId, customerInfo, couponCode, saveCard, autoPayConsent } = req.body || {};
      const userId = userIdOf(req);

      if (!packageId) return res.status(400).json({ success: false, message: 'Package ID is required' });
      if (!customerInfo || !customerInfo.email) {
        return res.status(400).json({ success: false, message: 'Customer information is required' });
      }

      const payments = require('../../services/payments');
      const provider = await payments.providerForCheckout();
      const session = await provider.createPurchaseCheckout({
        userId,
        packageId,
        customerInfo,
        couponCode,
        saveCard: saveCard === true,
        autoPayConsent: autoPayConsent === true
      });
      return res.status(200).json({
        success: true,
        sessionId: session.sessionId,
        url: session.url,
        orderNumber: session.orderNumber,
        orderId: session.orderId,
        provider: provider.id,
        saveCard: session.saveCard
      });
    } catch (error) {
      return fail(res, error, 'Failed to create checkout session');
    }
  },

  /**
   * POST /api/gymfolio/package-orders/:id/pay-online { saveCard?, autoPayConsent? }
   *
   * The signed-in member pays one of their own orders online through the
   * gym's gateway: a renewal waiting for payment (an unpaid order paid
   * online), or what is still owed on a part-paid one. The amount is what
   * the order owes, never one sent. Answers { url } for the gateway's page;
   * the member comes back to /checkout/success?provider=<id>&order=<id>
   * &tracker=<the payment's reference>.
   */
  async payOrderOnline(req, res) {
    try {
      const userId = userIdOf(req);
      if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });
      const { id, orderId } = req.params;
      const wanted = orderId || id;
      const order = mongoose.Types.ObjectId.isValid(String(wanted || '')) ? await PackageOrder.findOne({ _id: wanted, userId }) : null;
      if (!order) return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      // Unpaid orders are paid online only when they were meant to be (a
      // renewal raised for online payment, a checkout left unfinished): a
      // bank transfer waiting for its receipt is not turned into one.
      if (order.payment.status !== 'paid' && order.payment.method !== 'online') {
        return res.status(409).json({ success: false, code: 'ORDER_NOT_PAYABLE', message: 'This order is paid another way. Ask at the front desk if you would like to pay it online.' });
      }
      if (order.payment.status === 'paid' && membership.stripeBilled(order)) {
        return res.status(409).json({ success: false, code: 'STRIPE_BILLED', message: 'This membership is paid by card through Stripe.' });
      }

      const payments = require('../../services/payments');
      const provider = await payments.providerForCheckout();
      if (!provider.capabilities.paymentLinks) {
        return res.status(409).json({ success: false, code: 'GATEWAY_UNSUPPORTED', message: "Paying an order online isn't available at this gym — please pay at the front desk." });
      }
      const member = await User.findById(userId).select('firstName lastName email phone').lean();
      const site = require('../../services/payments/site').gymSiteOrigin();
      const ref = encodeURIComponent(String(order._id));
      const body = req.body || {};
      const result = await provider.createCheckout({
        order,
        customer: member ? { name: [member.firstName, member.lastName].filter(Boolean).join(' '), email: member.email, phone: member.phone } : {},
        returnUrl: `${site}/checkout/success?provider=${provider.id}&order=${ref}&tracker={TRACKER}`,
        cancelUrl: `${site}/checkout/cancel?order=${ref}`,
        saveCard: body.saveCard === true,
        autoPayConsent: body.autoPayConsent === true
      });
      return res.status(200).json({
        success: true,
        url: result.url,
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        provider: provider.id,
        reference: result.reference,
        purpose: result.purpose,
        amount: result.amount,
        currency: result.currency,
        saveCard: result.saveCard
      });
    } catch (error) {
      return fail(res, error, 'Failed to open the payment page');
    }
  },

  /**
   * GET|POST /api/gymfolio/payment/verify/:sessionId
   *
   * `sessionId` is a Stripe Checkout session id, or -- for the other
   * gateways -- the order id the success page was sent back with
   * (?provider=safepay&order=<id>). For those the answer is the order's own
   * state (the webhook may have recorded it), else the gateway is asked. With
   * ?tracker=<reference> it is that one payment that is answered for (a
   * balance paid on an order that was already paid).
   */
  async verifyPackagePayment(req, res) {
    try {
      const { sessionId } = req.params;
      if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID is required' });
      if (/^[a-f\d]{24}$/i.test(sessionId)) {
        const gatewayOrder = await PackageOrder.findById(sessionId);
        if (gatewayOrder && gatewayOrder.payment && gatewayOrder.payment.provider && gatewayOrder.payment.provider !== 'stripe') {
          const payments = require('../../services/payments');
          const provider = payments.getProvider(gatewayOrder.payment.provider);
          if (!provider || typeof provider.verifyOrder !== 'function') {
            return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'We could not find an order for this payment.' });
          }
          const tracker = String((req.query && req.query.tracker) || (req.body && req.body.tracker) || '').trim() || null;
          const { paid, order } = await provider.verifyOrder(gatewayOrder, { reference: tracker });
          return res.status(200).json({
            success: paid,
            paid,
            order: order
              ? {
                  orderNumber: order.orderNumber,
                  packageId: order.packageId,
                  packageName: (order.packageDetails && order.packageDetails.name) || '',
                  amount: order.payment ? order.payment.amount : undefined,
                  currency: order.payment ? order.payment.currency : undefined,
                  status: order.status,
                  provider: gatewayOrder.payment.provider
                }
              : null
          });
        }
        if (!gatewayOrder) {
          // Not a Stripe session either: Stripe ids start cs_.
          return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'We could not find an order for this payment. If you have paid, contact the gym with your receipt.' });
        }
      }
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
      return res.status(200).json({ success: true, data: result.orders, pagination: result.pagination });
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
