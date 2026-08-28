// gymfolioPaymentController.js - Controller for Gymfolio Package Payment Management

const gymfolioPaymentService = require('../../services/gymfolioPaymentService');
const stripe = require('../../config/stripe');

const gymfolioPaymentController = {
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
