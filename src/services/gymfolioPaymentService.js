// gymfolioPaymentService.js - Payment Service for Gymfolio Package Subscriptions

const stripe = require('../config/stripe');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Package = require('../gymfolio/models/packageModel');
const Settings = require('../models/settings');
const { parseAmount, resolveCurrency, toMinorUnits } = require('../helper/money');

class GymfolioPaymentService {
  /**
   * Create Stripe checkout session for package subscription
   */
  async createPackageCheckoutSession(userId, packageId, customerInfo) {
    try {
      console.log('💳 Creating Gymfolio Package Checkout Session...');
      console.log('- Package ID:', packageId);
      console.log('- User ID:', userId);

      // Fetch package details
      const packageData = await Package.findById(packageId);

      if (!packageData) {
        throw new Error(`Package not found: ${packageId}`);
      }

      if (!packageData.isActive) {
        throw new Error(`Package is not active: ${packageData.name}`);
      }

      // Shared with the admin-assignment path, so a package costs the same
      // whether it is bought at the counter or on the website. This used to be
      // a local regex here and a bare Number() there, and the two disagreed.
      const priceValue = parseAmount(packageData.price);

      if (priceValue === null || priceValue <= 0) {
        throw new Error(`Invalid package price: ${packageData.price}`);
      }

      // The gym's settings decide the currency when the package does not name
      // one. The old fallback here was a hardcoded 'usd', which charged in
      // dollars for any package left blank regardless of where the gym is.
      const settings = await Settings.getSettings().catch(() => null);
      const currency = resolveCurrency(
        packageData.currency,
        settings && settings.currency
      ).toLowerCase();

      // Generate order number
      const orderNumber = await PackageOrder.generateOrderNumber();

      // Create line item for the package
      const lineItems = [{
        price_data: {
          currency: currency,
          product_data: {
            name: `${packageData.name} Package`,
            description: `${packageData.period} - ${packageData.features.slice(0, 3).join(', ')}`,
            metadata: {
              packageId: packageData._id.toString(),
              packageName: packageData.name,
              period: packageData.period
            }
          },
          // Minor units. Not a blanket x100: yen and a handful of others have
          // no minor unit at all, and multiplying those by 100 would charge a
          // customer a hundred times the price.
          unit_amount: toMinorUnits(priceValue, currency),
        },
        quantity: 1,
      }];

      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: lineItems,
        mode: 'payment', // Use 'subscription' if you want recurring payments
        success_url: `${process.env.GYMFOLIO_URL || process.env.FRONTEND_ORIGIN}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.GYMFOLIO_URL || process.env.FRONTEND_ORIGIN}/checkout/cancel`,
        customer_email: customerInfo.email,
        client_reference_id: orderNumber,
        metadata: {
          userId: userId ? userId.toString() : 'guest',
          packageId: packageData._id.toString(),
          packageName: packageData.name,
          orderNumber: orderNumber,
          customerInfo: JSON.stringify(customerInfo),
          type: 'gymfolio_package_subscription'
        },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        phone_number_collection: {
          enabled: true,
        },
      });

      // Create pending order in database
      const order = new PackageOrder({
        orderNumber: orderNumber,
        userId: userId || null,
        packageId: packageData._id,
        packageDetails: {
          name: packageData.name,
          price: packageData.price,
          currency: packageData.currency,
          period: packageData.period,
          features: packageData.features
        },
        customerInfo: {
          fullName: customerInfo.fullName,
          email: customerInfo.email,
          phone: customerInfo.phone,
          country: customerInfo.country,
          address: customerInfo.address || '',
          city: customerInfo.city || '',
          state: customerInfo.state || '',
          zipCode: customerInfo.zipCode || ''
        },
        payment: {
          method: 'stripe',
          stripeSessionId: session.id,
          amount: priceValue,
          currency: currency,
          status: 'pending'
        },
        status: 'pending'
      });

      await order.save();

      console.log('✅ Package checkout session created:', session.id);
      console.log('✅ Order created:', orderNumber);

      return {
        success: true,
        sessionId: session.id,
        url: session.url,
        orderNumber: orderNumber
      };
    } catch (error) {
      console.error('❌ Error creating package checkout session:', error);
      throw new Error(`Failed to create package checkout session: ${error.message}`);
    }
  }

  /**
   * Verify payment and update order
   */
  async verifyPackagePayment(sessionId) {
    try {
      console.log('✅ Verifying Gymfolio package payment:', sessionId);

      // Retrieve session from Stripe
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['payment_intent', 'customer']
      });

      console.log('- Session status:', session.payment_status);
      console.log('- Payment status:', session.payment_intent?.status);

      // Find order in database
      const order = await PackageOrder.findOne({
        'payment.stripeSessionId': sessionId
      }).populate('packageId userId');

      if (!order) {
        throw new Error('Order not found for this session');
      }

      // Update order with payment information
      if (session.payment_status === 'paid') {
        order.payment.status = 'paid';
        order.payment.paidAt = new Date();
        order.payment.stripePaymentIntentId = session.payment_intent?.id;
        order.payment.stripeCustomerId = session.customer;
        order.payment.transactionId = session.payment_intent?.id;

        // Activate subscription
        await order.activateSubscription();

        // Tell the member their membership is live. Required after
        // activateSubscription, which is what sets the dates the email quotes.
        // Fired, not awaited: the payment has succeeded either way.
        try {
          const notify = require('./gymNotifications');
          const User = require('../models/user');
          const member = order.userId
            ? await User.findById(order.userId).select('firstName lastName email').lean()
            : null;
          notify.membershipConfirmed(order, member);
        } catch (notifyError) {
          console.error('[notify] membership confirmation failed:', notifyError.message);
        }

        console.log('✅ Payment verified and subscription activated');
      } else if (session.payment_status === 'unpaid') {
        order.payment.status = 'failed';
        order.status = 'cancelled';
        await order.save();

        console.log('❌ Payment failed');
      }

      return {
        success: session.payment_status === 'paid',
        paid: session.payment_status === 'paid',
        order: order,
        session: session
      };
    } catch (error) {
      console.error('❌ Error verifying payment:', error);
      throw new Error(`Failed to verify payment: ${error.message}`);
    }
  }

  /**
   * Handle Stripe webhook events
   */
  async handleWebhook(event) {
    try {
      console.log('📨 Gymfolio Webhook received:', event.type);

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;

          // Check if this is a gymfolio package subscription
          if (session.metadata?.type === 'gymfolio_package_subscription') {
            await this.verifyPackagePayment(session.id);
          }
          break;
        }

        case 'payment_intent.succeeded': {
          const paymentIntent = event.data.object;
          console.log('✅ Payment succeeded:', paymentIntent.id);

          // Update order if needed
          const order = await PackageOrder.findOne({
            'payment.stripePaymentIntentId': paymentIntent.id
          });

          if (order && order.payment.status !== 'paid') {
            order.payment.status = 'paid';
            order.payment.paidAt = new Date();
            await order.activateSubscription();
          }
          break;
        }

        case 'payment_intent.payment_failed': {
          const paymentIntent = event.data.object;
          console.log('❌ Payment failed:', paymentIntent.id);

          const order = await PackageOrder.findOne({
            'payment.stripePaymentIntentId': paymentIntent.id
          });

          if (order) {
            order.payment.status = 'failed';
            order.status = 'cancelled';
            await order.save();
          }
          break;
        }

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      return { received: true };
    } catch (error) {
      console.error('❌ Error handling webhook:', error);
      throw error;
    }
  }

  /**
   * Get order by ID
   */
  async getOrderById(orderId, userId) {
    try {
      const query = { _id: orderId };

      // If userId provided, ensure order belongs to user
      if (userId) {
        query.userId = userId;
      }

      const order = await PackageOrder.findOne(query)
        .populate('packageId', 'name price currency period features')
        .populate('userId', 'firstName lastName email');

      return order;
    } catch (error) {
      console.error('Error fetching order:', error);
      throw error;
    }
  }

  /**
   * Get all orders for a user
   */
  async getUserOrders(userId, options = {}) {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        sort = '-createdAt'
      } = options;

      const query = { userId };

      if (status) {
        query.status = status;
      }

      const orders = await PackageOrder.find(query)
        .populate('packageId', 'name price currency period')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit);

      const total = await PackageOrder.countDocuments(query);

      return {
        orders,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('Error fetching user orders:', error);
      throw error;
    }
  }

  /**
   * Get all orders (admin)
   */
  async getAllOrders(options = {}) {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        paymentStatus,
        search,
        sort = '-createdAt'
      } = options;

      const query = {};

      if (status) {
        query.status = status;
      }

      if (paymentStatus) {
        query['payment.status'] = paymentStatus;
      }

      if (search) {
        query.$or = [
          { orderNumber: new RegExp(search, 'i') },
          { 'customerInfo.email': new RegExp(search, 'i') },
          { 'customerInfo.fullName': new RegExp(search, 'i') }
        ];
      }

      const orders = await PackageOrder.find(query)
        .populate('packageId', 'name price currency period')
        .populate('userId', 'firstName lastName email')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit);

      const total = await PackageOrder.countDocuments(query);

      return {
        orders,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('Error fetching all orders:', error);
      throw error;
    }
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(orderId, userId) {
    try {
      const order = await this.getOrderById(orderId, userId);

      if (!order) {
        throw new Error('Order not found');
      }

      if (order.status === 'cancelled') {
        throw new Error('Subscription is already cancelled');
      }

      order.status = 'cancelled';
      order.subscription.isActive = false;
      order.subscription.autoRenew = false;

      await order.save();

      return order;
    } catch (error) {
      console.error('Error cancelling subscription:', error);
      throw error;
    }
  }
}

module.exports = new GymfolioPaymentService();
