const paymentService = require('../services/paymentService');
const orderService = require('../services/orderService');
const affiliateService = require('../services/affiliateService');
const Order = require('../models/order');
const Cart = require('../models/cartModel');
const Discount = require('../models/discount');
const { sendOrderEmail } = require('../services/emailService');

const paymentController = {
  async createCheckoutSession(req, res) {
    try {
      console.log('🔍 PAYMENT DEBUG: Create checkout session called');
      console.log('🔍 PAYMENT DEBUG: Headers:', JSON.stringify(req.headers, null, 2));
      console.log('🔍 PAYMENT DEBUG: req.user:', JSON.stringify(req.user, null, 2));

      const { cartItems, shippingAddress, billingAddress, discountCode, affiliateCode } = req.body;
      const userId = req.user ? (req.user._id || req.user.id) : null;

      console.log('💾 USER ID DEBUG: req.user._id:', req.user ? req.user._id : 'no req.user');
      console.log('💾 USER ID DEBUG: req.user.id:', req.user ? req.user.id : 'no req.user');
      console.log('💾 USER ID DEBUG: Final userId:', userId);
      console.log('🔍 PAYMENT DEBUG: CartItems received:', JSON.stringify(cartItems, null, 2));
      console.log('🔍 PAYMENT DEBUG: Discount code:', discountCode);
      console.log('🔍 PAYMENT DEBUG: Affiliate code received in body:', affiliateCode || '(none)');

      if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Cart is empty'
        });
      }

      if (!shippingAddress) {
        return res.status(400).json({
          success: false,
          message: 'Shipping address is required'
        });
      }

      // Calculate subtotal for discount validation
      let subtotal = 0;
      for (const item of cartItems) {
        subtotal += (item.price || 0) * (item.quantity || 1);
      }

      // Validate and prepare discount info
      let discountInfo = null;
      if (discountCode) {
        const discountDoc = await Discount.findOne({ code: discountCode.toUpperCase() });
        if (discountDoc) {
          const validation = discountDoc.isValid(subtotal, userId);
          if (!validation.valid) {
            return res.status(400).json({
              success: false,
              message: validation.message
            });
          }
          // For one-per-user coupons, require user to be logged in
          if (discountDoc.onePerUser && !userId) {
            return res.status(400).json({
              success: false,
              message: 'Please log in to use this discount code'
            });
          }
          discountInfo = {
            code: discountDoc.code,
            amount: discountDoc.calculateDiscount(subtotal),
            discountId: discountDoc._id.toString()
          };
        } else {
          return res.status(400).json({
            success: false,
            message: 'Invalid discount code'
          });
        }
      }

      const session = await paymentService.createCheckoutSession(
        userId,
        cartItems,
        shippingAddress,
        billingAddress || shippingAddress,
        discountInfo,
        affiliateCode || null
      );

      res.status(200).json({
        success: true,
        sessionId: session.sessionId,
        url: session.url
      });
    } catch (error) {
      console.error('Error in createCheckoutSession:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to create checkout session'
      });
    }
  },

  async createPaymentIntent(req, res) {
    try {
      const { amount, currency, metadata } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid amount'
        });
      }

      const result = await paymentService.createPaymentIntent(
        amount,
        currency || 'usd',
        metadata || {}
      );

      res.status(200).json(result);
    } catch (error) {
      console.error('Error in createPaymentIntent:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to create payment intent'
      });
    }
  },

  async handleWebhook(req, res) {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing stripe signature'
      });
    }

    try {
      const result = await paymentService.handleWebhook(signature, req.body);
      res.status(200).json(result);
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  },

  async verifyPayment(req, res) {
    try {
      console.log('🔍 VERIFY DEBUG: Verify payment called');
      console.log('🔍 VERIFY DEBUG: req.user:', JSON.stringify(req.user, null, 2));
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message: 'Session ID is required'
        });
      }

      const session = await paymentService.getCheckoutSession(sessionId);

      if (session.payment_status === 'paid') {
        const order = await Order.findOne({ stripeSessionId: sessionId });

        res.status(200).json({
          success: true,
          paid: true,
          order: order,
          session: {
            id: session.id,
            payment_status: session.payment_status,
            customer_email: session.customer_email,
            amount_total: session.amount_total / 100
          }
        });
      } else {
        res.status(200).json({
          success: true,
          paid: false,
          session: {
            id: session.id,
            payment_status: session.payment_status
          }
        });
      }
    } catch (error) {
      console.error('Error in verifyPayment:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to verify payment'
      });
    }
  },

  async getOrders(req, res) {
    try {
      const userId = req.user.id;
      const { status, page = 1, limit = 10 } = req.query;

      const result = await orderService.getUserOrders(userId, {
        status,
        page: parseInt(page),
        limit: parseInt(limit)
      });

      res.status(200).json(result);
    } catch (error) {
      console.error('Error in getOrders:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch orders'
      });
    }
  },

  async getOrderById(req, res) {
    try {
      const { orderId } = req.params;
      const isAdmin = req.user?.role === 'admin';
      const userId = isAdmin ? null : (req.user.id || req.user._id);

      const result = await orderService.getOrderById(orderId, userId);
      res.status(200).json(result);
    } catch (error) {
      console.error('Error in getOrderById:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch order'
      });
    }
  },

  async getAllOrders(req, res) {
    try {
      const { status, page = 1, limit = 50, search } = req.query;

      const result = await orderService.getAllOrders({
        status,
        page: parseInt(page),
        limit: parseInt(limit),
        search
      });

      res.status(200).json(result);
    } catch (error) {
      console.error('Error in getAllOrders:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch all orders'
      });
    }
  },

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

      const result = await orderService.updateOrderStatus(orderId, status);

      // Send email notification based on status change
      if (result.success && result.order) {
        const populatedOrder = await Order.findById(orderId).populate('items.product');
        const emailTemplateMap = {
          'processing': 'orderProcessing',
          'shipped': 'orderShipped',
          'delivered': 'orderDelivered',
          'cancelled': 'orderCancelled'
        };
        const templateType = emailTemplateMap[status];
        if (templateType) {
          sendOrderEmail(populatedOrder, templateType).catch(err => {
            console.error(`Failed to send ${status} email:`, err.message);
          });
        }
      }

      res.status(200).json(result);
    } catch (error) {
      console.error('Error in updateOrderStatus:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to update order status'
      });
    }
  },

  async bulkUpdateOrderStatus(req, res) {
    try {
      const { orderIds, status } = req.body;
      if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ success: false, message: 'orderIds is required' });
      }
      if (!status) {
        return res.status(400).json({ success: false, message: 'status is required' });
      }

      const result = await orderService.bulkUpdateOrderStatus(orderIds, status);

      const emailTemplateMap = {
        processing: 'orderProcessing',
        shipped: 'orderShipped',
        delivered: 'orderDelivered',
        cancelled: 'orderCancelled'
      };
      const templateType = emailTemplateMap[status];
      if (templateType) {
        Order.find({ _id: { $in: orderIds } })
          .populate('items.product')
          .then((orders) => {
            orders.forEach((o) => {
              sendOrderEmail(o, templateType).catch((err) =>
                console.error(`Failed to send ${status} email for ${o.orderNumber}:`, err.message)
              );
            });
          })
          .catch((err) => console.error('Failed to load orders for bulk email:', err.message));
      }

      res.status(200).json(result);
    } catch (error) {
      console.error('Error in bulkUpdateOrderStatus:', error);
      res.status(500).json({ success: false, message: error.message || 'Failed to bulk update orders' });
    }
  },

  async deleteOrder(req, res) {
    try {
      const { orderId } = req.params;
      const result = await orderService.deleteOrder(orderId);
      res.status(200).json(result);
    } catch (error) {
      console.error('Error in deleteOrder:', error);
      res.status(500).json({ success: false, message: error.message || 'Failed to delete order' });
    }
  },

  async bulkDeleteOrders(req, res) {
    try {
      const { orderIds } = req.body;
      if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ success: false, message: 'orderIds is required' });
      }
      const result = await orderService.bulkDeleteOrders(orderIds);
      res.status(200).json(result);
    } catch (error) {
      console.error('Error in bulkDeleteOrders:', error);
      res.status(500).json({ success: false, message: error.message || 'Failed to bulk delete orders' });
    }
  },

  async refundOrder(req, res) {
    try {
      const { orderId } = req.params;
      const { amount, reason } = req.body;

      const order = await Order.findById(orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      if (!order.stripePaymentIntentId) {
        return res.status(400).json({
          success: false,
          message: 'No payment intent found for this order'
        });
      }

      if (order.paymentStatus === 'refunded') {
        return res.status(400).json({
          success: false,
          message: 'Order has already been refunded'
        });
      }

      const refundAmount = amount || order.total;
      const result = await paymentService.refundPayment(
        order.stripePaymentIntentId,
        refundAmount
      );

      if (result.success) {
        order.paymentStatus = 'refunded';
        order.orderStatus = 'refunded';
        order.refundedAt = new Date();
        if (reason) {
          order.notes = `Refund reason: ${reason}`;
        }
        await order.save();

        if (order.affiliateUser) {
          affiliateService.reverseCommissionForOrder(order._id).catch(err => {
            console.error('Failed to reverse affiliate commission:', err.message);
          });
        }

        // Send refund confirmation email
        const populatedOrder = await Order.findById(orderId).populate('items.product');
        sendOrderEmail(populatedOrder, 'orderRefunded').catch(err => {
          console.error('Failed to send refund email:', err.message);
        });
      }

      res.status(200).json({
        success: true,
        message: 'Refund processed successfully',
        refund: result
      });
    } catch (error) {
      console.error('Error in refundOrder:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to process refund'
      });
    }
  },

  async getPublicKey(req, res) {
    try {
      res.status(200).json({
        success: true,
        publicKey: process.env.STRIPE_PUBLISHABLE_KEY
      });
    } catch (error) {
      console.error('Error in getPublicKey:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get public key'
      });
    }
  }
};

module.exports = paymentController;