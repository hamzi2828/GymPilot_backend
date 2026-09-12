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
// The order is created pending BEFORE the Checkout session is opened, so a
// session can never exist without the order it belongs to; it is activated
// when Stripe confirms the money -- by the success page's verify call or by
// the webhook, whichever comes first. Activation is claimed with one
// conditional update (see gymfolio/services/activationClaim.js), so two of
// those arriving together produce one activation, not two.

const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Package = require('../gymfolio/models/packageModel');
const Settings = require('../models/settings');
const User = require('../models/user');
const { parseAmount, resolveCurrency, toMinorUnits } = require('../helper/money');
const { frontendOrigin, currentTenantSlug } = require('../platform/tenantContext');
const { getStripe } = require('./stripeClient');
const membership = require('../gymfolio/services/membershipService');
const notify = require('./gymNotifications');
const { idOf, subscriptionIdOf, periodOf, invoicePeriodOf } = require('../gymfolio/services/stripeShapes');
const claim = require('../gymfolio/services/activationClaim');

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

// The order number Stripe was told about, wherever the event carries it:
// on the PaymentIntent's metadata for one-off sales, on the subscription's
// metadata (surfaced on its invoices) for recurring ones.
function orderNumberOf(object) {
  if (!object) return null;
  const meta = object.metadata || {};
  const subDetails = object.subscription_details || (object.parent && object.parent.subscription_details) || {};
  const subMeta = subDetails.metadata || {};
  return meta.orderNumber || subMeta.orderNumber || null;
}

async function orderForSubscription(subId, object) {
  const clauses = [];
  if (subId) clauses.push({ 'payment.stripeSubscriptionId': subId });
  const orderNumber = orderNumberOf(object);
  if (orderNumber) clauses.push({ orderNumber });
  if (!clauses.length) return null;
  return PackageOrder.findOne(clauses.length === 1 ? clauses[0] : { $or: clauses });
}

class GymfolioPaymentService {
  /**
   * Records a pending order, then opens a Stripe Checkout session for it.
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

    // A signed-in member who is already on a subscription is sent to their
    // account page rather than sold a second one that overlaps it.
    if (userId) {
      await membership.assertNoActiveSubscription({ userId, email: customerInfo.email, snapshot });
    }

    const orderNumber = await PackageOrder.generateOrderNumber();
    const siteOrigin = frontendOrigin();
    const tenantSlug = currentTenantSlug() || '';

    // The order exists before Stripe hears about it, so a session id always
    // has an order to land on -- and a crash between the two leaves a
    // pending order rather than an orphaned session.
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
        orderId: String(order._id),
        customerInfo: JSON.stringify(customerInfo),
        type: SESSION_TYPE,
        tenantSlug,
        couponCode: coupon ? coupon.code : ''
      },
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true }
    };

    // The gym rides along in metadata so the webhook -- which arrives with no
    // site attached -- can find it again.
    if (recurring) {
      params.subscription_data = { metadata: { tenantSlug, orderNumber } };
      if (snapshot.billing.trialDays > 0) params.subscription_data.trial_period_days = snapshot.billing.trialDays;
    } else {
      params.payment_intent_data = { metadata: { tenantSlug, orderNumber } };
    }

    let session;
    try {
      // The gym's own coupon becomes a one-off Stripe coupon on the session.
      // Always a fixed amount, computed on the package price alone: a
      // percent_off coupon at Stripe would also take its cut of the joining
      // fee, charging less than the checkout page showed and than
      // payment.amount records. Stripe does not allow its own promotion-code
      // box alongside a discount, so the box is only offered when no gym
      // coupon is in play.
      const amountOff = coupon && discount > 0 ? toMinorUnits(discount, currency) : 0;
      if (amountOff > 0) {
        const duration = recurring && coupon.appliesToRenewals ? 'forever' : 'once';
        const stripeCoupon = await stripe.coupons.create({ amount_off: amountOff, currency, duration, name: coupon.code });
        params.discounts = [{ coupon: stripeCoupon.id }];
      } else {
        params.allow_promotion_codes = true;
      }

      session = await stripe.checkout.sessions.create(params);
    } catch (error) {
      // Same end state as a session that expired unpaid or a payment that
      // failed: the order is closed rather than left pending forever.
      order.payment.status = 'failed';
      order.payment.lastPaymentError = error.message || 'Could not open the Stripe checkout';
      order.status = 'cancelled';
      await order.save().catch(() => {});
      throw error;
    }

    order.payment.stripeSessionId = session.id;
    await order.save();

    return { success: true, sessionId: session.id, url: session.url, orderNumber };
  }

  /**
   * Activates an order exactly once. `prepare(order)` sets whatever Stripe
   * told us onto the order and returns the options for markPaidAndActivate;
   * it only runs for the caller that won the claim. The loser gets back the
   * order as the winner left it.
   *
   * @returns {Promise<{ activated: boolean, order }>}
   */
  async activateOnce(order, prepare) {
    const claimed = await PackageOrder.findOneAndUpdate(claim.claimFilter(order._id), claim.claimUpdate(), { new: false });
    if (!claimed) {
      const current = await PackageOrder.findById(order._id);
      return { activated: false, order: current || order };
    }

    const previous = claimed.payment.status;
    try {
      const activation = (await prepare(order)) || {};
      await membership.markPaidAndActivate(order, { paidAt: new Date(), ...activation });
      notify.membershipConfirmed(order, await memberFor(order)).catch(() => {});
      return { activated: true, order };
    } catch (error) {
      // Give the claim back so a retry (the webhook, or the member refreshing
      // the success page) can complete what this attempt could not.
      await PackageOrder.updateOne(claim.releaseFilter(order._id), claim.releaseUpdate(previous)).catch(() => {});
      throw error;
    }
  }

  /**
   * Confirms a Checkout session and activates its order. Safe to call more
   * than once: an order already paid is returned as it is.
   */
  async verifyPackagePayment(sessionId) {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent', 'subscription'] });

    let order = await PackageOrder.findOne({ 'payment.stripeSessionId': sessionId });
    if (!order) throw new Error('Order not found for this session');

    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';

    if (paid && claim.canClaimActivation(order.payment.status)) {
      const result = await this.activateOnce(order, async (o) => {
        const customerId = idOf(session.customer);

        if (session.mode === 'subscription' && session.subscription) {
          const sub = typeof session.subscription === 'object' ? session.subscription : await stripe.subscriptions.retrieve(session.subscription);
          const period = periodOf(sub);
          o.payment.stripeSubscriptionId = sub.id;
          o.payment.stripeCustomerId = customerId || idOf(sub.customer);
          o.subscription.stripeStatus = sub.status;
          o.subscription.autoRenew = true;
          o.subscription.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
          const transactionId = idOf(sub.latest_invoice);
          if (transactionId) o.payment.stripeInvoiceId = transactionId;
          return { transactionId, startDate: period.start || undefined, endDate: period.end || undefined };
        }

        const intentId = idOf(session.payment_intent);
        o.payment.stripePaymentIntentId = intentId;
        o.payment.stripeCustomerId = customerId;
        return { transactionId: intentId };
      });
      order = result.order;
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
        // Matched by the intent id once verify has stored it, or by the order
        // number the intent was created with when the webhook gets here first.
        const orderNumber = orderNumberOf(object);
        const order = await PackageOrder.findOne(
          orderNumber
            ? { $or: [{ 'payment.stripePaymentIntentId': object.id }, { orderNumber, 'payment.method': 'stripe' }] }
            : { 'payment.stripePaymentIntentId': object.id }
        );
        if (order && claim.canClaimActivation(order.payment.status)) {
          await this.activateOnce(order, async (o) => {
            o.payment.stripePaymentIntentId = object.id;
            if (!o.payment.stripeCustomerId && idOf(object.customer)) o.payment.stripeCustomerId = idOf(object.customer);
            return { transactionId: object.id };
          });
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
        const subId = subscriptionIdOf(object);
        if (!subId) break;
        const order = await orderForSubscription(subId, object);
        if (!order) break;

        const { start: periodStart, end: periodEnd } = invoicePeriodOf(object);

        if (claim.canClaimActivation(order.payment.status)) {
          // First payment arriving here before the success page verified it.
          await this.activateOnce(order, async (o) => {
            o.payment.stripeSubscriptionId = subId;
            o.payment.stripeInvoiceId = object.id;
            if (!o.payment.stripeCustomerId && idOf(object.customer)) o.payment.stripeCustomerId = idOf(object.customer);
            o.subscription.autoRenew = true;
            return { transactionId: object.id, startDate: periodStart || undefined, endDate: periodEnd || undefined };
          });
        } else if (
          order.payment.status === 'paid' &&
          object.billing_reason !== 'subscription_create' &&
          object.id !== order.payment.stripeInvoiceId
        ) {
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
        const subId = subscriptionIdOf(object);
        if (!subId) break;
        const order = await orderForSubscription(subId, object);
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
module.exports.orderNumberOf = orderNumberOf;
