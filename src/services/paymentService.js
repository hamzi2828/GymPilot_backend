const stripe = require('../config/stripe');
const Order = require('../models/order');
const Product = require('../models/product');
const Cart = require('../models/cartModel');
const Discount = require('../models/discount');
const affiliateService = require('./affiliateService');

class PaymentService {
  async createCheckoutSession(userId, cartItems, shippingAddress, billingAddress, discountInfo = null, affiliateCode = null) {
    try {
      const orderNumber = await Order.generateOrderNumber();

      // Calculate totals
      let subtotal = 0;
      const orderItems = cartItems.map(item => {
        const price = item.price || 0;
        subtotal += price * (item.quantity || 1);

        // Extract product ID from various possible structures
        let productId = item.productId || (item.product && item.product._id) || item.product;
        if (typeof productId === 'object' && productId !== null) {
          productId = productId._id || productId;
        }

        const orderItem = {
          product: productId,
          variantId: item.variantId || 'default',
          sku: item.sku || `SKU-${productId}`,
          quantity: item.quantity || 1,
          price: price,
          size: item.size || 'One Size',
          color: item.color || 'Default'
        };

        // Include custom sizes if present
        if (item.customSizes) {
          orderItem.customSizes = item.customSizes;
          orderItem.isCustomized = true;
        }
        if (item.isCustomized) {
          orderItem.isCustomized = item.isCustomized;
        }

        return orderItem;
      });

      // Apply discount if provided
      const discountAmount = discountInfo ? discountInfo.amount : 0;
      const discountCode = discountInfo ? discountInfo.code : null;
      const total = subtotal - discountAmount;

      // Resolve affiliate code (last-touch; self-referral guarded)
      console.log(`💳 [STRIPE] createCheckoutSession received affiliateCode: ${affiliateCode || '(none)'}`);
      const affiliate = affiliateCode
        ? await affiliateService.resolveAffiliate(affiliateCode, userId)
        : null;
      if (affiliateCode && !affiliate) {
        console.log('💳 [STRIPE] ⚠️  Affiliate code did not resolve; order will be saved without attribution');
      }
      if (affiliate) {
        console.log(`💳 [STRIPE] ✅ Pending order will be attributed to ${affiliate.code} (${affiliate.commissionPercent}%)`);
      }

      // Format shipping address
      const formattedShippingAddress = {
        fullName: shippingAddress.fullName || `${shippingAddress.firstName || ''} ${shippingAddress.lastName || ''}`.trim(),
        email: shippingAddress.email,
        phone: shippingAddress.phoneNumber || shippingAddress.phone || '',
        address: shippingAddress.address || '',
        city: shippingAddress.city || '',
        state: shippingAddress.state || '',
        zipCode: shippingAddress.postalCode || shippingAddress.zipCode || '',
        country: shippingAddress.country || 'United States'
      };

      // Create submitted order in database first
      const pendingOrder = new Order({
        user: userId || null,
        orderNumber: orderNumber,
        items: orderItems,
        shippingAddress: formattedShippingAddress,
        billingAddress: formattedShippingAddress,
        paymentMethod: 'stripe',
        paymentStatus: 'pending',
        orderStatus: 'submitted',
        subtotal: subtotal,
        shippingCost: 0,
        tax: 0,
        discount: discountAmount,
        discountCode: discountCode,
        total: total,
        affiliateCode: affiliate ? affiliate.code : null,
        affiliateUser: affiliate ? affiliate.userId : null
      });

      await pendingOrder.save();

      // Prepare line items with discount applied
      const lineItems = await this.prepareLineItems(cartItems, discountAmount);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment',
        success_url: `${process.env.FRONTEND_ORIGIN}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_ORIGIN}/checkout/cancel`,
        customer_email: shippingAddress.email,
        metadata: {
          orderId: pendingOrder._id.toString(),
          userId: userId ? userId.toString() : 'guest',
          orderNumber: orderNumber,
          discountCode: discountCode || '',
          discountAmount: discountAmount.toString(),
          affiliateCode: affiliate ? affiliate.code : ''
        },
        shipping_options: [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: {
                amount: 0,
                currency: 'usd',
              },
              display_name: 'Free shipping',
              delivery_estimate: {
                minimum: {
                  unit: 'business_day',
                  value: 5,
                },
                maximum: {
                  unit: 'business_day',
                  value: 7,
                },
              },
            },
          },
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: {
                amount: 1500,
                currency: 'usd',
              },
              display_name: 'Express shipping',
              delivery_estimate: {
                minimum: {
                  unit: 'business_day',
                  value: 1,
                },
                maximum: {
                  unit: 'business_day',
                  value: 3,
                },
              },
            },
          },
        ],
        allow_promotion_codes: !discountCode, // Disable Stripe promo codes if custom discount applied
        billing_address_collection: 'auto',
        phone_number_collection: {
          enabled: true,
        },
      });

      return {
        success: true,
        sessionId: session.id,
        url: session.url
      };
    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw new Error(`Failed to create checkout session: ${error.message}`);
    }
  }

  async prepareLineItems(cartItems, discountAmount = 0) {
    const lineItems = [];

    // Calculate total for discount distribution
    let totalAmount = 0;
    for (const item of cartItems) {
      totalAmount += (item.price || 0) * (item.quantity || 1);
    }

    for (const item of cartItems) {
      let product;

      // Handle different product data structures
      if (item.product && item.product.name) {
        // Product data already provided
        product = item.product;
      } else {
        // Need to fetch product from database
        // Extract product ID from various possible structures
        let productId = item.productId || item.product;
        if (typeof productId === 'object' && productId !== null) {
          productId = productId._id || productId;
        }

        product = await Product.findById(productId);
        if (!product) {
          console.error(`Product not found: ${productId}`);
          throw new Error(`Product not found: ${productId}`);
        }
      }

      // Ensure we have valid product data
      const productName = product.name || 'Product';
      const productId = product._id ? product._id.toString() : (item.productId || 'unknown');
      const productImages = product.images || product.bannerUrls || [];

      // Calculate proportional discount for this item
      const itemTotal = (item.price || 0) * (item.quantity || 1);
      const itemDiscount = totalAmount > 0 ? (itemTotal / totalAmount) * discountAmount : 0;
      const discountedPrice = Math.max(0, (item.price || 0) - (itemDiscount / (item.quantity || 1)));

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: productName,
            description: `Size: ${item.size || 'N/A'}, Color: ${item.color || 'N/A'}`,
            images: productImages.length > 0 ? [productImages[0]] : [],
            metadata: {
              productId: productId,
              size: item.size || 'N/A',
              color: item.color || 'N/A'
            }
          },
          unit_amount: Math.round(discountedPrice * 100),
        },
        quantity: item.quantity || 1,
      });
    }

    return lineItems;
  }

  async createPaymentIntent(amount, currency = 'usd', metadata = {}) {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: currency,
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: metadata
      });

      return {
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      };
    } catch (error) {
      console.error('Error creating payment intent:', error);
      throw new Error(`Failed to create payment intent: ${error.message}`);
    }
  }

  async handleWebhook(signature, payload) {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      throw new Error(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutSessionCompleted(event.data.object);
        break;

      case 'payment_intent.succeeded':
        await this.handlePaymentIntentSucceeded(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentIntentFailed(event.data.object);
        break;

      case 'charge.refunded':
        await this.handleChargeRefunded(event.data.object);
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    return { received: true };
  }

  async handleCheckoutSessionCompleted(session) {
    try {
      const metadata = session.metadata;
      const orderId = metadata.orderId;
      const userId = metadata.userId !== 'guest' ? metadata.userId : null;
      const discountCode = metadata.discountCode || null;

      console.log('💾 DATABASE UPDATE DEBUG:');
      console.log('- Order ID:', orderId);
      console.log('- User ID:', userId);
      console.log('- Discount Code:', discountCode);

      // Find and update the pending order
      const shippingCost = session.shipping_cost ? session.shipping_cost.amount_total / 100 : 0;

      const order = await Order.findByIdAndUpdate(
        orderId,
        {
          paymentStatus: 'completed',
          orderStatus: 'processing',
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent,
          shippingCost: shippingCost,
          total: session.amount_total / 100
        },
        { new: true }
      );

      if (!order) {
        console.error('Order not found:', orderId);
        throw new Error('Order not found');
      }

      console.log('✅ Order updated:', order.orderNumber);

      // Record coupon usage if discount was applied
      if (discountCode) {
        const discount = await Discount.findOne({ code: discountCode.toUpperCase() });
        if (discount) {
          await discount.incrementUsage(userId);
          console.log(`✅ Discount usage recorded for code: ${discountCode}, user: ${userId}`);
        }
      }

      // Clear user's cart
      if (userId) {
        await Cart.findOneAndUpdate(
          { user: userId },
          { $set: { items: [] } }
        );
        console.log(`Cart cleared for user ${userId}`);
      }

      // Record affiliate commission if applicable
      if (order.affiliateUser && order.affiliateCode) {
        console.log(`💳 [STRIPE] Triggering commission record for order ${order.orderNumber} (affiliate ${order.affiliateCode})`);
        affiliateService.recordCommissionForOrder(order).catch(err => {
          console.error('Failed to record affiliate commission:', err.message);
        });
      } else {
        console.log(`💳 [STRIPE] Order ${order.orderNumber} completed with no affiliate attribution`);
      }

      console.log(`Order ${order.orderNumber} completed successfully`);
    } catch (error) {
      console.error('Error handling checkout session completion:', error);
      throw error;
    }
  }

  async handlePaymentIntentSucceeded(paymentIntent) {
    try {
      const order = await Order.findOne({ stripePaymentIntentId: paymentIntent.id });
      if (order) {
        order.paymentStatus = 'completed';
        order.orderStatus = 'processing';
        await order.save();

        // Clear cart as backup (should already be cleared in checkout session)
        if (order.user) {
          await Cart.findOneAndUpdate(
            { userId: order.user },
            { $set: { items: [] } }
          );
          console.log(`Cart cleared for user ${order.user} (backup)`);
        }

        console.log(`Payment succeeded for order ${order.orderNumber}`);
      }
    } catch (error) {
      console.error('Error handling payment intent succeeded:', error);
    }
  }

  async handlePaymentIntentFailed(paymentIntent) {
    try {
      const order = await Order.findOne({ stripePaymentIntentId: paymentIntent.id });
      if (order) {
        order.paymentStatus = 'failed';
        order.orderStatus = 'cancelled';
        order.cancelledAt = new Date();
        await order.save();
        console.log(`Payment failed for order ${order.orderNumber}`);
      }
    } catch (error) {
      console.error('Error handling payment intent failed:', error);
    }
  }

  async handleChargeRefunded(charge) {
    try {
      const order = await Order.findOne({ stripePaymentIntentId: charge.payment_intent });
      if (order) {
        order.paymentStatus = 'refunded';
        order.orderStatus = 'refunded';
        order.refundedAt = new Date();
        await order.save();

        if (order.affiliateUser) {
          affiliateService.reverseCommissionForOrder(order._id).catch(err => {
            console.error('Failed to reverse affiliate commission:', err.message);
          });
        }

        console.log(`Order ${order.orderNumber} refunded`);
      }
    } catch (error) {
      console.error('Error handling charge refunded:', error);
    }
  }

  async getCheckoutSession(sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return session;
    } catch (error) {
      console.error('Error retrieving checkout session:', error);
      throw new Error(`Failed to retrieve checkout session: ${error.message}`);
    }
  }

  async getPaymentIntent(paymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return paymentIntent;
    } catch (error) {
      console.error('Error retrieving payment intent:', error);
      throw new Error(`Failed to retrieve payment intent: ${error.message}`);
    }
  }

  async refundPayment(paymentIntentId, amount = null) {
    try {
      const refundData = {
        payment_intent: paymentIntentId,
      };

      if (amount) {
        refundData.amount = Math.round(amount * 100);
      }

      const refund = await stripe.refunds.create(refundData);
      return {
        success: true,
        refundId: refund.id,
        amount: refund.amount / 100,
        status: refund.status
      };
    } catch (error) {
      console.error('Error creating refund:', error);
      throw new Error(`Failed to create refund: ${error.message}`);
    }
  }
}

module.exports = new PaymentService();