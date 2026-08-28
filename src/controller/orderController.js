const Order = require('../models/order');
const Cart = require('../models/cartModel');
const Discount = require('../models/discount');
const orderService = require('../services/orderService');
const affiliateService = require('../services/affiliateService');
const { sendOrderEmail } = require('../services/emailService');

const orderController = {
  /**
   * Create a new order (for COD and other non-Stripe payments)
   */
  async createOrder(req, res) {
    try {
      const userId = req.user ? (req.user._id || req.user.id) : null;
      const { shippingAddress, paymentMethod, cartItems, discountCode, affiliateCode } = req.body;

      console.log('📦 Creating order for user:', userId);
      console.log('📦 Shipping address:', shippingAddress);
      console.log('📦 Payment method:', paymentMethod);
      console.log('📦 Cart items:', cartItems);
      console.log('📦 Affiliate code received in body:', affiliateCode || '(none)');

      // Validate shipping address
      if (!shippingAddress || !shippingAddress.email) {
        return res.status(400).json({
          success: false,
          message: 'Shipping address is required'
        });
      }

      // Validate cart items
      if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Cart is empty'
        });
      }

      // Build order items from cart items sent by frontend
      const orderItems = [];
      let subtotal = 0;

      for (const item of cartItems) {
        orderItems.push({
          product: item.product,
          variantId: item.variantId || 'default',
          sku: item.sku || `SKU-${item.product}`,
          quantity: item.quantity,
          price: item.price,
          size: item.size || 'One Size',
          color: item.color || 'Default'
        });

        subtotal += item.price * item.quantity;
      }

      if (orderItems.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No valid items in cart'
        });
      }

      // Calculate totals
      const shippingCost = 0; // Free shipping or calculate based on your logic
      const tax = 0; // Calculate tax if needed
      let discountAmount = 0;
      let appliedDiscountCode = null;
      let discountDoc = null;

      // Apply discount code if provided
      if (discountCode) {
        discountDoc = await Discount.findOne({ code: discountCode.toUpperCase() });
        if (discountDoc) {
          const validation = discountDoc.isValid(subtotal, userId);
          if (validation.valid) {
            discountAmount = discountDoc.calculateDiscount(subtotal);
            appliedDiscountCode = discountDoc.code;
          } else {
            return res.status(400).json({
              success: false,
              message: validation.message
            });
          }
        }
      }

      const total = subtotal + shippingCost + tax - discountAmount;

      // Resolve affiliate code (last-touch attribution; self-referral guarded)
      const affiliate = affiliateCode
        ? await affiliateService.resolveAffiliate(affiliateCode, userId)
        : null;
      if (affiliateCode && !affiliate) {
        console.log('📦 ⚠️  Affiliate code provided but did not resolve to an approved affiliate; order will be saved without attribution');
      }
      if (affiliate) {
        console.log(`📦 ✅ Order will be attributed to affiliate ${affiliate.code} (user ${affiliate.userId}, ${affiliate.commissionPercent}%)`);
      }

      // Format shipping address for the order
      const formattedShippingAddress = {
        fullName: `${shippingAddress.firstName || ''} ${shippingAddress.lastName || ''}`.trim(),
        email: shippingAddress.email,
        phone: shippingAddress.phoneNumber || shippingAddress.phone || '',
        address: shippingAddress.address || '',
        city: shippingAddress.city || '',
        state: shippingAddress.state || '',
        zipCode: shippingAddress.postalCode || shippingAddress.zipCode || '',
        country: shippingAddress.country || 'United States'
      };

      // Generate order number
      const orderNumber = await Order.generateOrderNumber();

      // Create the order
      const order = new Order({
        user: userId,
        orderNumber: orderNumber,
        items: orderItems,
        shippingAddress: formattedShippingAddress,
        billingAddress: formattedShippingAddress,
        paymentMethod: paymentMethod?.type || 'cod',
        paymentStatus: paymentMethod?.type === 'cod' ? 'pending' : 'pending',
        orderStatus: 'submitted',
        subtotal: subtotal,
        shippingCost: shippingCost,
        tax: tax,
        discount: discountAmount,
        discountCode: appliedDiscountCode,
        total: total,
        notes: '',
        affiliateCode: affiliate ? affiliate.code : null,
        affiliateUser: affiliate ? affiliate.userId : null
      });

      await order.save();

      // Record affiliate commission ledger row (COD treated as confirmed at creation)
      if (affiliate) {
        console.log(`📦 Triggering commission record for COD order ${order.orderNumber}`);
        affiliateService.recordCommissionForOrder(order).catch(err => {
          console.error('Failed to record affiliate commission:', err.message);
        });
      }

      // Record coupon usage if discount was applied
      if (discountDoc && appliedDiscountCode) {
        await discountDoc.incrementUsage(userId);
      }

      // Clear the user's cart after successful order
      await Cart.findOneAndUpdate(
        { user: userId },
        { $set: { items: [] } }
      );

      console.log('✅ Order created successfully:', order.orderNumber);

      // Send order confirmation email (populate items first for better email content)
      const populatedOrder = await Order.findById(order._id).populate({
        path: 'items.product',
        select: 'name price discountedPrice thumbnail thumbnailUrl images colorMedia variants'
      });
      sendOrderEmail(populatedOrder, 'orderConfirmed').catch(err => {
        console.error('Failed to send order confirmation email:', err.message);
      });

      res.status(201).json({
        success: true,
        message: 'Order created successfully',
        order: {
          _id: populatedOrder._id,
          orderNumber: populatedOrder.orderNumber,
          items: populatedOrder.items,
          shippingAddress: populatedOrder.shippingAddress,
          billingAddress: populatedOrder.billingAddress,
          subtotal: populatedOrder.subtotal,
          shippingCost: populatedOrder.shippingCost,
          tax: populatedOrder.tax,
          discount: populatedOrder.discount,
          discountCode: populatedOrder.discountCode,
          total: populatedOrder.total,
          paymentMethod: populatedOrder.paymentMethod,
          paymentStatus: populatedOrder.paymentStatus,
          orderStatus: populatedOrder.orderStatus,
          createdAt: populatedOrder.createdAt
        }
      });
    } catch (error) {
      console.error('Error creating order:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to create order'
      });
    }
  },

  /**
   * Get all orders for the logged-in user
   */
  async getUserOrders(req, res) {
    try {
      const userId = req.user ? (req.user._id || req.user.id) : null;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Please login to view orders'
        });
      }

      const { status, page = 1, limit = 10 } = req.query;

      const result = await orderService.getUserOrders(userId, {
        status,
        page: parseInt(page),
        limit: parseInt(limit)
      });

      res.status(200).json(result);
    } catch (error) {
      console.error('Error fetching user orders:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch orders'
      });
    }
  },

  /**
   * Get a specific order by ID for the logged-in user
   */
  async getOrderById(req, res) {
    try {
      const userId = req.user ? (req.user._id || req.user.id) : null;
      const { orderId } = req.params;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Please login to view order'
        });
      }

      const result = await orderService.getOrderById(orderId, userId);
      res.status(200).json(result);
    } catch (error) {
      console.error('Error fetching order:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch order'
      });
    }
  },

  /**
   * Lookup guest order by order number and email
   * For guests who placed orders without an account
   */
  async lookupGuestOrder(req, res) {
    try {
      const { orderNumber, email } = req.query;

      if (!orderNumber || !email) {
        return res.status(400).json({
          success: false,
          message: 'Order number and email are required'
        });
      }

      console.log(`🔍 Looking up guest order: ${orderNumber} for email: ${email}`);

      // Find the order where user is null (guest order) and matches order number + email
      const order = await Order.findOne({
        orderNumber: orderNumber.toUpperCase(),
        user: null,
        'shippingAddress.email': email.toLowerCase()
      }).populate('items.product', 'name thumbnailUrl price');

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found. Please check your order number and email.'
        });
      }

      console.log(`✅ Found guest order: ${order.orderNumber}`);

      res.status(200).json({
        success: true,
        order: {
          _id: order._id,
          orderNumber: order.orderNumber,
          orderStatus: order.orderStatus,
          paymentStatus: order.paymentStatus,
          items: order.items,
          shippingAddress: order.shippingAddress,
          subtotal: order.subtotal,
          shippingCost: order.shippingCost,
          tax: order.tax,
          discount: order.discount,
          total: order.total,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt
        }
      });
    } catch (error) {
      console.error('Error looking up guest order:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to lookup order'
      });
    }
  },

  /**
   * Lookup an order by its order number for the post-checkout success page.
   * Returns the order if it belongs to the requesting user, or if it's a guest
   * order (user == null). This avoids leaking authenticated users' orders to
   * unauthenticated visitors who happen to know an order number.
   */
  async getOrderByNumber(req, res) {
    try {
      const userId = req.user ? (req.user._id || req.user.id) : null;
      const { orderNumber } = req.params;

      if (!orderNumber) {
        return res.status(400).json({
          success: false,
          message: 'Order number is required'
        });
      }

      const order = await Order.findOne({ orderNumber: orderNumber.toUpperCase() })
        .populate({
          path: 'items.product',
          select: 'name price discountedPrice thumbnail thumbnailUrl images colorMedia variants'
        });

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      const orderUserId = order.user ? order.user.toString() : null;
      const isOwner = userId && orderUserId && orderUserId === userId.toString();
      const isGuestOrder = !orderUserId;

      if (!isOwner && !isGuestOrder) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this order'
        });
      }

      res.status(200).json({
        success: true,
        order: {
          _id: order._id,
          orderNumber: order.orderNumber,
          items: order.items,
          shippingAddress: order.shippingAddress,
          billingAddress: order.billingAddress,
          subtotal: order.subtotal,
          shippingCost: order.shippingCost,
          tax: order.tax,
          discount: order.discount,
          discountCode: order.discountCode,
          total: order.total,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          orderStatus: order.orderStatus,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt
        }
      });
    } catch (error) {
      console.error('Error fetching order by number:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch order'
      });
    }
  }
};

module.exports = orderController;
