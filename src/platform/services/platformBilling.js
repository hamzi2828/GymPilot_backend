// src/platform/services/platformBilling.js
//
// A gym paying the PLATFORM for its plan, by card, through Stripe Checkout
// on the platform's own account (services/platformStripe.js) -- never
// through the gym's keys, which are for its members' money.
//
// Prices are built inline (line_items[].price_data) from what the panel
// agreed with the gym: its plan price, plus a line for every paid add-on on
// its subscription. Nothing has to be created in the Stripe dashboard first,
// and a price changed in the panel is what the next checkout charges.
//
// The webhook (controllers/platformSettingsController.js) is what records the
// outcome on the gym: this file only starts things.

const { getPlatformStripe, platformBillingAvailable, PlatformStripeNotConfiguredError } = require('./platformStripe');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformAddon = require('../models/platformAddonModel');
const { toMinorUnits } = require('../../helper/money');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymPilot';
// Stripe refuses a Checkout trial_end closer than this; a shorter trial is
// simply charged now.
const MIN_TRIAL_END_MS = 48 * 60 * 60 * 1000;

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

/** Stripe's integer back to major units, for the amounts written on the gym. */
function fromMinorUnits(amount, currency) {
  const n = Number(amount) || 0;
  if (ZERO_DECIMAL.has(String(currency || '').toUpperCase())) return n;
  return Math.round(n) / 100;
}

class PlatformBillingError extends Error {
  constructor(message, status = 400, code = 'PLATFORM_BILLING') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cycleOf(value, fallback = 'monthly') {
  return value === 'yearly' || value === 'monthly' ? value : fallback;
}

function intervalFor(billingCycle) {
  return billingCycle === 'yearly' ? 'year' : 'month';
}

async function assertAvailable() {
  const { available, reason } = await platformBillingAvailable();
  if (!available) throw new PlatformStripeNotConfiguredError(reason);
}

/**
 * The lines a gym's subscription comes to for a billing cycle, in the plan's
 * currency. The plan line is the price the panel agreed with the gym
 * (subscription.planAmount) when the cycle is the one that price was agreed
 * for; a different cycle is priced from the plan's list. Add-ons the same
 * way: snapshots for the agreed cycle, the catalogue otherwise. Included
 * add-ons (amount 0) get no line.
 *
 * @returns {Promise<{currency, billingCycle, lines: [{name, amount}], total}>}
 */
async function priceLinesFor(gym, billingCycle) {
  if (!gym.plan) throw new PlatformBillingError('This gym is not on a plan, so there is nothing to subscribe to.', 400, 'NO_PLAN');
  const plan = await PlatformPlan.findById(gym.plan._id || gym.plan).lean();
  if (!plan) throw new PlatformBillingError('This gym is on a plan that no longer exists.', 400, 'NO_PLAN');

  const sub = gym.subscription || {};
  const cycle = cycleOf(billingCycle, cycleOf(sub.billingCycle));
  const currency = String(plan.price.currency || sub.currency || 'USD').toUpperCase();
  const agreedCycle = cycle === cycleOf(sub.billingCycle);

  const planAmount = agreedCycle && Number(sub.planAmount) > 0 ? Number(sub.planAmount) : Number(plan.price[cycle]) || 0;
  const lines = [{ name: `${plan.name} (${PLATFORM_NAME})`, amount: planAmount }];

  const addons = sub.addons || [];
  if (addons.length) {
    const catalogue = agreedCycle
      ? []
      : await PlatformAddon.find({ slug: { $in: addons.map((a) => a.slug) } }).lean();
    for (const addon of addons) {
      let amount = Number(addon.amount) || 0;
      if (!agreedCycle) {
        const listed = catalogue.find((c) => c.slug === addon.slug);
        // Included add-ons stay free whatever the catalogue says.
        amount = Number(addon.amount) > 0 && listed ? Number(listed.price[cycle]) || 0 : 0;
      }
      if (amount > 0) lines.push({ name: `${addon.name || addon.slug} (${PLATFORM_NAME})`, amount });
    }
  }

  return { plan, currency, billingCycle: cycle, lines, total: lines.reduce((sum, l) => sum + l.amount, 0) };
}

/**
 * A Stripe Checkout Session in subscription mode for the gym's plan.
 *
 * @param {object} args
 * @param {object} args.gym            the gym document (lean or not) with owner + subscription
 * @param {string} [args.billingCycle] 'monthly' | 'yearly'; defaults to the gym's
 * @param {string} args.successUrl
 * @param {string} args.cancelUrl
 * @returns {Promise<{url: string, id: string}>}
 */
async function createCheckoutSession({ gym, billingCycle, successUrl, cancelUrl }) {
  await assertAvailable();
  const stripe = await getPlatformStripe();
  const priced = await priceLinesFor(gym, billingCycle);
  if (!(priced.total > 0)) throw new PlatformBillingError('This plan is free; there is nothing to charge.', 400, 'FREE_PLAN');

  const sub = gym.subscription || {};
  const metadata = {
    gymId: String(gym._id),
    gymSlug: gym.slug,
    planSlug: priced.plan.slug,
    billingCycle: priced.billingCycle
  };

  const subscriptionData = { metadata };
  // A gym still on its trial keeps it: the card goes on file now and is
  // charged when the trial would have ended anyway.
  if (sub.status === 'trialing' && sub.currentPeriodEnd) {
    const end = new Date(sub.currentPeriodEnd).getTime();
    if (end - Date.now() >= MIN_TRIAL_END_MS) subscriptionData.trial_end = Math.floor(end / 1000);
  }

  const params = {
    mode: 'subscription',
    line_items: priced.lines.map((line) => ({
      quantity: 1,
      price_data: {
        currency: priced.currency.toLowerCase(),
        unit_amount: toMinorUnits(line.amount, priced.currency),
        recurring: { interval: intervalFor(priced.billingCycle) },
        product_data: { name: line.name }
      }
    })),
    client_reference_id: String(gym._id),
    metadata,
    subscription_data: subscriptionData,
    success_url: successUrl,
    cancel_url: cancelUrl
  };
  if (sub.stripeCustomerId) params.customer = sub.stripeCustomerId;
  else if (gym.owner && gym.owner.email) params.customer_email = gym.owner.email;

  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url, id: session.id };
}

/**
 * The Stripe customer portal for the gym's platform customer: update the
 * card, see invoices, cancel.
 */
async function createPortalSession({ gym, returnUrl }) {
  await assertAvailable();
  const customer = gym.subscription && gym.subscription.stripeCustomerId;
  if (!customer) throw new PlatformBillingError('This gym has not paid through Stripe yet, so there is no billing account to open.', 409, 'NO_STRIPE_CUSTOMER');
  const stripe = await getPlatformStripe();
  const session = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
  return { url: session.url, id: session.id };
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  priceLinesFor,
  fromMinorUnits,
  intervalFor,
  PlatformBillingError,
  PlatformStripeNotConfiguredError
};
