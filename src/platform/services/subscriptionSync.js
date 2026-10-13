// src/platform/services/subscriptionSync.js
//
// Keeps a gym's Stripe subscription in step with what the panel puts it on.
//
// Without this a plan changed in the panel changes the gym's limits but not
// its bill: Stripe goes on charging the old price, and its next
// customer.subscription.updated webhook writes that old amount back over the
// new one while gym.plan keeps the new limits. So a change to what a
// Stripe-billed gym pays goes to Stripe first, and the panel's record is only
// written once Stripe has accepted it.
//
// Prices are built inline (price_data), the way checkout builds them (see
// platformBilling.js), so nothing has to exist in the Stripe dashboard first.
// A subscription item's price_data takes a product id rather than a product
// to create, so the products the subscription already has are reused by name
// and only a line it has never had gets a new one.

const { getPlatformStripe } = require('./platformStripe');
const { toMinorUnits } = require('../../helper/money');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';

// Stripe subscriptions that are over: nothing to change, nothing charged.
const ENDED = new Set(['canceled', 'incomplete_expired']);

class SubscriptionSyncError extends Error {
  constructor(message, status = 409, code = 'STRIPE_SYNC_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function intervalFor(billingCycle) {
  return billingCycle === 'yearly' ? 'year' : 'month';
}

/**
 * What a subscription record comes to on Stripe: the plan's share, then a
 * line for every paid add-on. Named as checkout names them, so the lines a
 * gym paid for at checkout are recognised here.
 */
function stripeLinesFor(plan, sub) {
  const s = sub || {};
  const lines = [{ name: `${plan.name} (${PLATFORM_NAME})`, amount: Number(s.planAmount) || 0 }];
  for (const addon of s.addons || []) {
    const amount = Number(addon.amount) || 0;
    if (amount > 0) lines.push({ name: `${addon.name || addon.slug} (${PLATFORM_NAME})`, amount });
  }
  return lines;
}

function addonKey(sub) {
  return ((sub && sub.addons) || [])
    .map((a) => `${a.slug}:${Number(a.amount) || 0}`)
    .sort()
    .join(',');
}

/**
 * Whether going from `before` to `after` changes what the gym is charged:
 * another plan, cycle or currency, another plan price, or other add-ons.
 * Status, dates and notes do not.
 */
function changesPrice(before, after, planBefore, planAfter) {
  const b = before || {};
  const a = after || {};
  return (
    String(planBefore || '') !== String(planAfter || '') ||
    (b.billingCycle || 'monthly') !== (a.billingCycle || 'monthly') ||
    String(b.currency || '').toUpperCase() !== String(a.currency || '').toUpperCase() ||
    (Number(b.planAmount) || 0) !== (Number(a.planAmount) || 0) ||
    addonKey(b) !== addonKey(a)
  );
}

/** "Growth (GymsPilotPro) + Member app · PKR 10,400 / month" -- as the webhook words it. */
function priceSummary(plan, sub, total) {
  const parts = [plan.name];
  for (const addon of (sub && sub.addons) || []) {
    if (Number(addon.amount) > 0) parts.push(addon.name || addon.slug);
  }
  return `${parts.join(' + ')} · ${String(sub.currency || '').toUpperCase()} ${Number(total || 0).toLocaleString('en-US')} / ${intervalFor(sub.billingCycle)}`;
}

/**
 * Moves the gym's Stripe subscription onto `next`: every current item
 * replaced by the new lines, prorated, with the charge (if the change makes
 * one due now) required to succeed -- a change nobody paid for is not made.
 *
 * @param {object} args
 * @param {object} args.gym    the gym (its subscription carries stripeSubscriptionId)
 * @param {object} args.plan   the plan it is moving to (lean)
 * @param {object} args.next   the subscription record about to be saved
 * @param {object} [args.stripe] a Stripe client; defaults to the platform's
 * @returns {Promise<{synced: boolean, skipped?: string, summary?: string}>}
 * @throws {SubscriptionSyncError} when Stripe cannot be brought into line
 */
async function syncStripeSubscription({ gym, plan, next, stripe = null }) {
  const subscriptionId = gym && gym.subscription && gym.subscription.stripeSubscriptionId;
  if (!subscriptionId) return { synced: false, skipped: 'not billed through Stripe' };

  if (!plan) {
    throw new SubscriptionSyncError('This gym pays through Stripe. Cancel its Stripe subscription (billing portal or Stripe dashboard) before taking it off its plan.');
  }
  const lines = stripeLinesFor(plan, next);
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  if (!(total > 0)) {
    throw new SubscriptionSyncError('This gym pays through Stripe and the new price comes to nothing. Cancel its Stripe subscription first, then make the change.');
  }

  let client = stripe;
  try {
    if (!client) client = await getPlatformStripe();
  } catch (error) {
    throw new SubscriptionSyncError(`This gym pays through Stripe, so its price cannot change here until Stripe is set up again: ${error.message}`, 409, 'PLATFORM_STRIPE_NOT_CONFIGURED');
  }

  let current;
  try {
    current = await client.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product'] });
  } catch (error) {
    throw new SubscriptionSyncError(`Could not read the gym's Stripe subscription ${subscriptionId}, so nothing was saved: ${error.message}`, 502);
  }
  // Over already: Stripe charges nothing more, so the panel's record is the
  // only thing to change.
  if (ENDED.has(current.status)) return { synced: false, skipped: `Stripe subscription is ${current.status}` };

  const currency = String(next.currency || '').toLowerCase();
  if (current.currency && currency && current.currency.toLowerCase() !== currency) {
    throw new SubscriptionSyncError(
      `This gym pays Stripe in ${current.currency.toUpperCase()}, and a running subscription cannot change currency. Keep it in ${current.currency.toUpperCase()}, or cancel it and have the gym check out again.`
    );
  }

  const items = (current.items && current.items.data) || [];
  // Products the subscription already has, by name, so a plan line keeps
  // its product and the Stripe dashboard does not fill up with copies.
  const products = new Map();
  for (const item of items) {
    const product = item.price && item.price.product;
    if (product && typeof product === 'object' && !product.deleted && product.active !== false && product.name) {
      products.set(product.name, product.id);
    }
  }

  try {
    const newItems = [];
    for (const line of lines) {
      let product = products.get(line.name);
      if (!product) {
        product = (await client.products.create({ name: line.name, metadata: { gymId: String(gym._id), gymSlug: gym.slug || '' } })).id;
        products.set(line.name, product);
      }
      newItems.push({
        quantity: 1,
        price_data: {
          currency,
          product,
          unit_amount: toMinorUnits(line.amount, currency),
          recurring: { interval: intervalFor(next.billingCycle) }
        }
      });
    }

    await client.subscriptions.update(subscriptionId, {
      items: [...items.map((item) => ({ id: item.id, deleted: true })), ...newItems],
      proration_behavior: 'create_prorations',
      // A change that makes money due now (monthly to yearly, say) is only
      // made if that payment goes through.
      payment_behavior: 'error_if_incomplete',
      metadata: {
        ...(current.metadata || {}),
        gymId: String(gym._id),
        gymSlug: gym.slug || '',
        planSlug: plan.slug || '',
        billingCycle: next.billingCycle || 'monthly'
      }
    });
  } catch (error) {
    // Stripe unreachable is a gateway problem; anything else (a declined
    // card, a refused parameter) is Stripe saying no.
    const unreachable = error && (error.type === 'StripeConnectionError' || error.type === 'StripeAPIError');
    throw new SubscriptionSyncError(`Stripe did not accept the change, so nothing was saved: ${error.message}`, unreachable ? 502 : 409);
  }

  return { synced: true, summary: priceSummary(plan, next, total) };
}

module.exports = {
  syncStripeSubscription,
  changesPrice,
  stripeLinesFor,
  SubscriptionSyncError
};
