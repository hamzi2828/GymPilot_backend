// src/services/gymfolioPaymentService.js
//
// Card payments for memberships, through the gym's own Stripe account.
//
// Two shapes of sale go through Stripe Checkout:
//
//   one_time   -- a term paid up front (mode: 'payment')
//   recurring  -- a subscription Stripe renews itself (mode: 'subscription');
//                 renewals, failed payments and cancellations then arrive on
//                 the webhook and are applied to the same order.
//
// The order is created pending when the session is opened and activated when
// Stripe confirms the money -- by the success page's verify call or by the
// webhook, whichever comes first; both are idempotent.

const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Package = require('../gymfolio/models/packageModel');
const Settings = require('../models/settings');
const User = require('../models/user');
const { parseAmount, resolveCurrency, toMinorUnits } = require('../helper/money');
const { frontendOrigin, currentTenantSlug } = require('../platform/tenantContext');
const { getStripe } = require('./stripeClient');
const membership = require('../gymfolio/services/membershipService');
const notify = require('./gymNotifications');

const SESSION_TYPE = 'gymfolio_package_subscription';
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fromMinorUnits(amount, currency) {
  const n = Number(amount) || 0;
  return ZERO_DECIMAL.has(String(currency || '').toLowerCase()) ? n : round2(n / 100);
}

async function memberFor(order) {
  if (!order.userId) return null;
  return User.findById(order.userId).select('firstName lastName email').lean();
}

function idOf(value) {
  return typeof value === 'string' ? value : value && value.id;
}

class GymfolioPaymentService {
  /**
   * Opens a Stripe Checkout session for a package and records a pending order.
   */
  async createPackageCheckoutSession(userId, packageId, customerInfo, options = {}) {
    const stripe = await getStripe();

    const packageData = await Package.findById(packageId);
    if (!packageData) throw new Error(`Package not found: ${packageId}`);
    if (!packageData.isActive) throw new Error(`Package is not active: ${packageData.name}`);

    const listPrice = parseAmount(packageData.price);
    if (listPrice === null || listPrice <= 0) throw new Error(`Invalid package price: ${packageData.price}`);

    const settings = await Settings.getSettings().catch(() => null);
    const currency = resolveCurrency(packageData.currency, settings && settings.currency).toLowerCase();
    const snapshot = membership.packageSnapshot(packageData);
    const recurring = snapshot.billing.mode === 'recurring';
    const joiningFee = round2(snapshot.joiningFee);

    const { coupon, discount } = await membership.applyCoupon(options.couponCode, packageData, listPrice);

    const orderNumber = await PackageOrder.generateOrderNumber();
    const siteOrigin = frontendOrigin();
    const tenantSlug = currentTenantSlug() || '';

    const lineItems = [
      {
        price_data: {
          currency,
          product_data: {
            name: `${packageData.name} Package`,
            description: `${snapshot.period} - ${packageData.features.slice(0, 3).join(', ')}`,
            metadata: { packageId: String(packageData._id), packageName: packageData.name, period: snapshot.period }
          },
          // Minor units, currency-aware: yen and friends have none.
          unit_amount: toMinorUnits(listPrice, currency),
          ...(recurring
            ? { recurring: { interval: snapshot.billing.interval, interval_count: snapshot.billing.intervalCount } }
            : {})
        },
        quantity: 1
      }
    ];
    if (joiningFee > 0) {
      lineItems.push({
        price_data: {
          currency,
          product_data: { name: 'Joining fee' },
          unit_amount: toMinorUnits(joiningFee, currency)
        },
        quantity: 1
      });
    }

    const params = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: recurring ? 'subscription' : 'payment',
      success_url: `${siteOrigin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteOrigin}/checkout/cancel`,
      customer_email: customerInfo.email,
      client_reference_id: orderNumber,
      metadata: {
        userId: userId ? String(userId) : 'guest',
        packageId: String(packageData._id),
        packageName: packageData.name,
        orderNumber,
        customerInfo: JSON.stringify(customerInfo),
        type: SESSION_TYPE,
        tenantSlug,
        couponCode: coupon ? coupon.code : ''
      },
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true }
    };

    // The gym's own coupon becomes a one-off Stripe coupon on the session.
    // Stripe does not allow its own promotion-code box alongside a discount,
    // so the box is only offered when no gym coupon is in play.
    if (coupon && discount > 0) {
      const duration = recurring && coupon.appliesToRenewals ? 'forever' : 'once';
      const stripeCoupon = await stripe.coupons.create(
        coupon.type === 'percent'
          ? { percent_off: coupon.value, duration, name: coupon.code }
          : { amount_off: toMinorUnits(discount, currency), currency, duration, name: coupon.code }
      );
      params.discounts = [{ coupon: stripeCoupon.id }];
    } else {
      params.allow_promotion_codes = true;
    }

    // The gym rides along in metadata so the webhook -- which arrives with no
    // site attached -- can find it again.
    if (recurring) {
      params.subscription_data = { metadata: { tenantSlug, orderNumber } };
      if (snapshot.billing.trialDays > 0) params.subscription_data.trial_period_days = snapshot.billing.trialDays;
    } else {
      params.payment_intent_data = { metadata: { tenantSlug, orderNumber } };
    }

    const session = await stripe.checkout.sessions.create(params);

    const order = new PackageOrder({
      orderNumber,
      userId: userId || null,
      packageId: packageData._id,
      packageDetails: snapshot,
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
        amount: round2(Math.max(0, listPrice + joiningFee - discount)),
        subtotal: round2(listPrice + joiningFee),
        discountAmount: discount,
        couponCode: coupon ? coupon.code : '',
        currency,
        status: 'pending'
      },
      subscription: { autoRenew: recurring },
      status: 'pending'
    });
    await order.save();

    return { success: true, sessionId: session.id, url: session.url, orderNumber };
  }

  /**
   * Confirms a Checkout session and activates its order. Safe to call more
   * than once: an order already paid is returned as it is.
   */
  async verifyPackagePayment(sessionId) {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent', 'subscription'] });

    const order = await PackageOrder.findOne({ 'payment.stripeSessionId': sessionId });
    if (!order) throw new Error('Order not found for this session');

    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';

    if (paid && order.payment.status !== 'paid') {
      const customerId = idOf(session.customer);
      let startDate;
      let endDate;
      let transactionId;

      if (session.mode === 'subscription' && session.subscription) {
        const sub = typeof session.subscription === 'object' ? session.subscription : await stripe.subscriptions.retrieve(session.subscription);
        order.payment.stripeSubscriptionId = sub.id;
        order.payment.stripeCustomerId = customerId || idOf(sub.customer);
        order.subscription.stripeStatus = sub.status;
        order.subscription.autoRenew = true;
        order.subscription.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
        startDate = new Date(sub.current_period_start * 1000);
        endDate = new Date(sub.current_period_end * 1000);
        transactionId = idOf(sub.latest_invoice);
        if (transactionId) order.payment.stripeInvoiceId = transactionId;
      } else {
        const intentId = idOf(session.payment_intent);
        order.payment.stripePaymentIntentId = intentId;
        order.payment.stripeCustomerId = customerId;
        transactionId = intentId;
      }

      await membership.markPaidAndActivate(order, { paidAt: new Date(), transactionId, startDate, endDate });
      notify.membershipConfirmed(order, await memberFor(order)).catch(() => {});
    } else if (!paid && session.payment_status === 'unpaid' && session.status === 'expired' && order.payment.status === 'pending') {
      order.payment.status = 'failed';
      order.status = 'cancelled';
      await order.save();
    }

    return { success: paid, paid, order, session };
  }

  /**
   * Applies a verified Stripe event to the order it concerns.
   */
  async handleWebhook(event) {
    const object = event.data.object;

    switch (event.type) {
      case 'checkout.session.completed': {
        if (object.metadata && object.metadata.type === SESSION_TYPE) await this.verifyPackagePayment(object.id);
        break;
      }

      case 'payment_intent.succeeded': {
        const order = await PackageOrder.findOne({ 'payment.stripePaymentIntentId': object.id });
        if (order && order.payment.status !== 'paid') {
          await membership.markPaidAndActivate(order, { paidAt: new Date(), transactionId: object.id });
          notify.membershipConfirmed(order, await memberFor(order)).catch(() => {});
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const order = await PackageOrder.findOne({ 'payment.stripePaymentIntentId': object.id });
        if (order && order.payment.status === 'pending') {
          order.payment.status = 'failed';
          order.status = 'cancelled';
          order.payment.lastPaymentError = (object.last_payment_error && object.last_payment_error.message) || 'Payment failed';
          await order.save();
        }
        break;
      }

      // A subscription renewed (or its first invoice settled).
      case 'invoice.paid': {
        const subId = idOf(object.subscription);
        if (!subId) break;
        const order = await PackageOrder.findOne({ 'payment.stripeSubscriptionId': subId });
        if (!order) break;

        const line = object.lines && object.lines.data && object.lines.data.find((l) => l.period && l.period.end);
        const periodEnd = line ? new Date(line.period.end * 1000) : null;
        const periodStart = line ? new Date(line.period.start * 1000) : null;

        if (order.payment.status !== 'paid') {
          // First payment arriving here before the success page verified it.
          await membership.markPaidAndActivate(order, { paidAt: new Date(), transactionId: object.id, startDate: periodStart, endDate: periodEnd });
          order.payment.stripeInvoiceId = object.id;
          await order.save();
          notify.membershipConfirmed(order, await memberFor(order)).catch(() => {});
        } else if (object.billing_reason !== 'subscription_create' && object.id !== order.payment.stripeInvoiceId) {
          if (periodEnd) {
            order.subscription.endDate = periodEnd;
            order.subscription.renewalDate = periodEnd;
          }
          order.subscription.isActive = true;
          order.status = order.status === 'frozen' ? 'frozen' : 'active';
          order.payment.paidAt = new Date();
          order.payment.stripeInvoiceId = object.id;
          order.payment.lastPaymentError = '';
          order.subscription.renewals = order.subscription.renewals || [];
          order.subscription.renewals.push({
            at: new Date(),
            amount: fromMinorUnits(object.amount_paid, object.currency),
            currency: (object.currency || '').toUpperCase(),
            invoiceId: object.id,
            periodEnd
          });
          await order.save();
          notify.membershipRenewed(order, await memberFor(order)).catch(() => {});
        }
        break;
      }

      // A renewal could not be collected. Stripe keeps retrying on its own
      // schedule; the member is told and the desk sees "past due".
      case 'invoice.payment_failed': {
        const subId = idOf(object.subscription);
        if (!subId) break;
        const order = await PackageOrder.findOne({ 'payment.stripeSubscriptionId': subId });
        if (!order || order.payment.status !== 'paid') break;
        order.status = 'past_due';
        order.payment.lastPaymentError =
          (object.last_finalization_error && object.last_finalization_error.message) || 'Your card could not be charged';
        await order.save();
        notify.paymentFailed(order, await memberFor(order)).catch(() => {});
        break;
      }

      case 'customer.subscription.updated': {
        const order = await PackageOrder.findOne({ 'payment.stripeSubscriptionId': object.id });
        if (!order) break;
        order.subscription.stripeStatus = object.status;
        order.subscription.cancelAtPeriodEnd = !!object.cancel_at_period_end;
        if (object.cancel_at_period_end) order.subscription.autoRenew = false;
        if (object.status === 'active' && order.status === 'past_due') order.status = 'active';
        await order.save();
        break;
      }

      case 'customer.subscription.deleted': {
        const order = await PackageOrder.findOne({ 'payment.stripeSubscriptionId': object.id });
        if (!order) break;
        order.subscription.stripeStatus = 'canceled';
        order.subscription.autoRenew = false;
        const now = new Date();
        if (!order.subscription.endDate || new Date(order.subscription.endDate) <= now || order.status === 'past_due') {
          order.status = 'cancelled';
          order.subscription.isActive = false;
        } else {
          order.subscription.cancelAtPeriodEnd = true;
        }
        if (!order.cancellation || !order.cancellation.cancelledAt) {
          order.cancellation = { cancelledAt: now, reason: 'Subscription ended at Stripe', by: null, source: 'stripe', immediate: false };
        }
        await order.save();
        break;
      }

      default:
        break;
    }
    return { received: true };
  }

  async getOrderById(orderId, userId) {
    const query = { _id: orderId };
    if (userId) query.userId = userId;
    return PackageOrder.findOne(query)
      .populate('packageId', 'name price currency period kind billing')
      .populate('userId', 'firstName lastName email');
  }

  async getUserOrders(userId, options = {}) {
    const { page = 1, limit = 10, status, sort = '-createdAt' } = options;
    const query = { userId };
    if (status) query.status = status;
    const orders = await PackageOrder.find(query)
      .populate('packageId', 'name price currency period kind billing')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit);
    const total = await PackageOrder.countDocuments(query);
    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getAllOrders(options = {}) {
    const { page = 1, limit = 20, status, paymentStatus, paymentMethod, search, sort = '-createdAt' } = options;
    const query = {};
    if (status) query.status = status;
    if (paymentStatus) query['payment.status'] = paymentStatus;
    if (paymentMethod) query['payment.method'] = paymentMethod;
    if (search) {
      const term = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ orderNumber: term }, { 'customerInfo.email': term }, { 'customerInfo.fullName': term }];
    }
    const orders = await PackageOrder.find(query)
      .populate('packageId', 'name price currency period kind billing')
      .populate('userId', 'firstName lastName email memberCode')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit);
    const total = await PackageOrder.countDocuments(query);
    return { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** A member ending their own membership: never immediate, never without their say. */
  async cancelSubscription(orderId, userId, reason = '') {
    const order = await this.getOrderById(orderId, userId);
    if (!order) throw new Error('Order not found');
    return membership.cancel(order, { reason, source: 'member', immediate: false, by: userId });
  }
}

module.exports = new GymfolioPaymentService();
