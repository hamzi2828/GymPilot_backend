// gymfolioPaymentController.js - Controller for Gymfolio Package Payment Management

const gymfolioPaymentService = require('../../services/gymfolioPaymentService');
const stripe = require('../../config/stripe');
const PackageOrder = require('../models/packageOrderModel');
const Package = require('../models/packageModel');
const User = require('../../models/user');
const Settings = require('../../models/settings');
const { parseAmount, resolveCurrency } = require('../../helper/money');
const { sweepIfDue } = require('../services/membershipExpiry');
const notify = require('../../services/gymNotifications');

/**
 * The country on the member's default address, if they have one on file.
 * Better than asking the admin to retype it, and better than the 'N/A' this
 * used to store -- an empty string when we genuinely do not know.
 */
function defaultAddressCountry(user) {
  const addresses = Array.isArray(user.addresses) ? user.addresses : [];
  const chosen = addresses.find((address) => address.isDefault) || addresses[0];
  return (chosen && chosen.country) || '';
}

/** Adds one billing period to a date, for a manually granted subscription. */
function addPeriod(from, period) {
  const d = new Date(from);
  const p = String(period || 'month').toLowerCase();
  if (p.includes('year')) d.setFullYear(d.getFullYear() + 1);
  else if (p.includes('week')) d.setDate(d.getDate() + 7);
  else if (p.includes('day')) d.setDate(d.getDate() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

const gymfolioPaymentController = {
  /**
   * Assign a package to an existing member directly from the admin panel,
   * bypassing checkout. Used for cash/bank payments taken in person and for
   * comping a membership.
   */
  async assignPackageToUser(req, res) {
    try {
      const { userId, packageId, paymentMethod = 'cash', markPaid = true, notes, durationMonths } = req.body;

      if (!userId || !packageId) {
        return res.status(400).json({ success: false, message: 'userId and packageId are required' });
      }

      const [user, pkg, settings] = await Promise.all([
        User.findById(userId).select('firstName lastName email phone addresses'),
        Package.findById(packageId),
        // Only for the currency fallback below, and tolerant of failure: a
        // missing settings document must not stop a membership being sold.
        Settings.getSettings().catch(() => null),
      ]);

      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

      // Package.price is a String, and this path used to run it through
      // Number(), which yields NaN for anything with a thousands separator and
      // was then coerced to 0 -- recording a paid membership worth nothing and
      // quietly understating the month's revenue. parseAmount reads the shapes
      // an admin actually types; null means it could not, and that is refused
      // here rather than stored as zero.
      const amount = parseAmount(pkg.price);
      if (amount === null) {
        return res.status(422).json({
          success: false,
          message: `Package "${pkg.name}" has an unreadable price (${JSON.stringify(pkg.price)}). Fix it on the Packages screen before assigning it.`,
        });
      }

      // One answer for the currency, instead of the three defaults this
      // codebase used to hold (the model said PKR, this handler said GBP, the
      // Stripe service said USD), which meant the currency an order was booked
      // in depended on which screen created it.
      const currency = resolveCurrency(pkg.currency, settings && settings.currency);

      const start = new Date();
      let end = addPeriod(start, pkg.period);
      const months = Number(durationMonths);
      if (Number.isFinite(months) && months > 0) {
        end = new Date(start);
        end.setMonth(end.getMonth() + months);
      }

      const orderNumber = await PackageOrder.generateOrderNumber();
      const paid = markPaid !== false;

      const order = await PackageOrder.create({
        orderNumber,
        userId: user._id,
        packageId: pkg._id,
        packageDetails: {
          name: pkg.name,
          price: String(pkg.price),
          currency,
          period: pkg.period || 'month',
          features: Array.isArray(pkg.features) ? pkg.features : [],
        },
        // Whatever the account actually holds, and nothing invented. These two
        // used to be written as the literal string 'N/A' to satisfy a required
        // field, which put 'N/A' on the receipt and made "we don't have their
        // number" impossible to tell from a real one. They are optional in the
        // schema now, so an empty field simply means empty.
        customerInfo: {
          fullName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
          email: user.email,
          phone: user.phone || '',
          country: defaultAddressCountry(user),
        },
        payment: {
          method: ['stripe', 'card', 'bank_transfer', 'cash'].includes(paymentMethod) ? paymentMethod : 'cash',
          amount,
          currency: currency.toLowerCase(),
          status: paid ? 'paid' : 'pending',
          paidAt: paid ? new Date() : undefined,
        },
        subscription: {
          startDate: start,
          endDate: end,
          isActive: paid,
          autoRenew: false,
          renewalDate: end,
        },
        status: paid ? 'active' : 'pending',
        notes: notes || `Assigned from the admin panel by ${req.user?.email || 'an administrator'}`,
      });

      // The member should hear that their membership is live, whether it was
      // bought online or taken in cash at the desk. Fired, not awaited: a mail
      // failure must not fail a payment that has already been taken.
      if (paid) notify.membershipConfirmed(order, user);

      return res.status(201).json({
        success: true,
        message: `${pkg.name} assigned to ${user.email}`,
        data: order,
      });
    } catch (error) {
      console.error('Assign package error:', error);
      return res.status(500).json({ success: false, message: 'Failed to assign package', error: error.message });
    }
  },

  /**
   * Create package checkout session
   */
  async createPackageCheckoutSession(req, res) {
    try {
      console.log('🔍 GYMFOLIO PAYMENT: Create package checkout session called');
      console.log('🔍 User:', req.user ? req.user._id : 'Guest');

      const { packageId, customerInfo } = req.body;
      const userId = req.user ? (req.user._id || req.user.id) : null;

      // Validation
      if (!packageId) {
        return res.status(400).json({
          success: false,
          message: 'Package ID is required'
        });
      }

      if (!customerInfo || !customerInfo.email) {
        return res.status(400).json({
          success: false,
          message: 'Customer information is required'
        });
      }

      // Create checkout session
      const session = await gymfolioPaymentService.createPackageCheckoutSession(
        userId,
        packageId,
        customerInfo
      );

      res.status(200).json({
        success: true,
        sessionId: session.sessionId,
        url: session.url,
        orderNumber: session.orderNumber
      });
    } catch (error) {
      console.error('❌ Error in createPackageCheckoutSession:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to create checkout session'
      });
    }
  },

  /**
   * Verify package payment
   */
  async verifyPackagePayment(req, res) {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message: 'Session ID is required'
        });
      }

      const result = await gymfolioPaymentService.verifyPackagePayment(sessionId);

      res.status(200).json(result);
    } catch (error) {
      console.error('❌ Error verifying payment:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to verify payment'
      });
    }
  },

  /**
   * Get Stripe public key
   */
  async getPublicKey(req, res) {
    try {
      const publicKey = process.env.STRIPE_PUBLISHABLE_KEY;

      if (!publicKey) {
        return res.status(500).json({
          success: false,
          message: 'Stripe public key not configured'
        });
      }

      res.status(200).json({
        success: true,
        publicKey: publicKey
      });
    } catch (error) {
      console.error('Error getting Stripe public key:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get Stripe public key'
      });
    }
  },

  /**
   * Handle Stripe webhooks
   */
  async handleWebhook(req, res) {
    try {
      const sig = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        console.error('⚠️ Webhook secret not configured');
        return res.status(500).json({
          success: false,
          message: 'Webhook secret not configured'
        });
      }

      // Verify webhook signature
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.error('⚠️ Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      // Handle the event
      await gymfolioPaymentService.handleWebhook(event);

      res.json({ received: true });
    } catch (error) {
      console.error('❌ Error handling webhook:', error);
      res.status(500).json({
        success: false,
        message: 'Webhook handler failed'
      });
    }
  },

  /**
   * Get order by ID
   */
  async getOrderById(req, res) {
    try {
      const { orderId } = req.params;
      const userId = req.user ? (req.user._id || req.user.id) : null;

      const order = await gymfolioPaymentService.getOrderById(orderId, userId);

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      res.status(200).json({
        success: true,
        data: order
      });
    } catch (error) {
      console.error('Error fetching order:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch order'
      });
    }
  },

  /**
   * Get user orders
   */
  async getUserOrders(req, res) {
    try {
      const userId = req.user ? (req.user._id || req.user.id) : null;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const { page, limit, status, sort } = req.query;

      // Awaited, not fired and forgotten: a member opening their history must
      // not be told a membership that ran out last month is still active.
      // Throttled internally, so this is a no-op on all but the first call in
      // any five-minute window.
      await sweepIfDue();

      const result = await gymfolioPaymentService.getUserOrders(userId, {
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 10,
        status,
        sort
      });

      res.status(200).json({
        success: true,
        data: result.orders,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching user orders:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch orders'
      });
    }
  },

  /**
   * Get all orders (admin only)
   */
  async getAllOrders(req, res) {
    try {
      const { page, limit, status, paymentStatus, search, sort } = req.query;

      // Same reason as getUserOrders, and more pressing here: this list is
      // filtered BY status, so a stale 'active' does not just read wrongly, it
      // puts a lapsed member in the wrong filter.
      await sweepIfDue();

      const result = await gymfolioPaymentService.getAllOrders({
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
        status,
        paymentStatus,
        search,
        sort
      });

      res.status(200).json({
        success: true,
        data: result.orders,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching all orders:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch orders'
      });
    }
  },

  /**
   * Update order status (admin only)
   */
  async updateOrderStatus(req, res) {
    try {
      const { orderId } = req.params;
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          message: 'Status is required'
        });
      }

      const validStatuses = ['pending', 'active', 'expired', 'cancelled', 'suspended'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
      }

      const order = await gymfolioPaymentService.getOrderById(orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      order.status = status;

      if (status === 'cancelled' || status === 'suspended') {
        order.subscription.isActive = false;
      }

      await order.save();

      res.status(200).json({
        success: true,
        message: 'Order status updated successfully',
        data: order
      });
    } catch (error) {
      console.error('Error updating order status:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to update order status'
      });
    }
  },

  /**
   * Cancel subscription
   */
  async cancelSubscription(req, res) {
    try {
      const { orderId } = req.params;
      const userId = req.user ? (req.user._id || req.user.id) : null;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const order = await gymfolioPaymentService.cancelSubscription(orderId, userId);

      res.status(200).json({
        success: true,
        message: 'Subscription cancelled successfully',
        data: order
      });
    } catch (error) {
      console.error('Error cancelling subscription:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to cancel subscription'
      });
    }
  },

  /**
   * Get subscription status
   */
  async getSubscriptionStatus(req, res) {
    try {
      const userId = req.user ? (req.user._id || req.user.id) : null;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const result = await gymfolioPaymentService.getUserOrders(userId, {
        status: 'active',
        limit: 10
      });

      const activeSubscriptions = result.orders.filter(order =>
        order.isSubscriptionActive()
      );

      res.status(200).json({
        success: true,
        data: {
          activeSubscriptions,
          count: activeSubscriptions.length
        }
      });
    } catch (error) {
      console.error('Error fetching subscription status:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch subscription status'
      });
    }
  }
};

module.exports = gymfolioPaymentController;
