// src/platform/services/platformBilling.js
//
// A gym paying the PLATFORM for its plan, by card, through Stripe Checkout
// on the platform's own account (services/platformStripe.js) -- never
// through the gym's keys, which are for its members' money. The same goes
// for a buyer signing up on the marketing site, before their gym exists
// (createSignupCheckoutSession).
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

/** priceLinesFor's lines as Stripe Checkout line items, priced inline. */
function lineItemsFor(priced) {
  return priced.lines.map((line) => ({
    quantity: 1,
    price_data: {
      currency: priced.currency.toLowerCase(),
      unit_amount: toMinorUnits(line.amount, priced.currency),
      recurring: { interval: intervalFor(priced.billingCycle) },
      product_data: { name: line.name }
    }
  }));
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
    line_items: lineItemsFor(priced),
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
 * A Stripe Checkout Session for a gym that does not exist yet: somebody on
 * the marketing site signing up and paying in one go
 * (controllers/signupController.js). The webhook builds the gym once Stripe
 * says it is paid (services/signupProvisioning.js); `metadata.kind` is how it
 * tells this from a gym's own checkout.
 *
 * Priced by priceLinesFor from the very subscription provisioning will write
 * for the gym, so what Stripe charges and what the gym's record says are the
 * same number. The plan's trial is Stripe's trial: the card is taken now and
 * first charged when the trial ends.
 *
 * @param {object} args
 * @param {string} args.signupId            the DemoRequest this pays for
 * @param {string} args.email               the buyer, filled in on Stripe's page
 * @param {object} args.plan                the plan document
 * @param {Array}  args.addons              add-on documents (addonsController.resolveAddons)
 * @param {string} args.billingCycle        'monthly' | 'yearly'
 * @param {string} args.successUrl
 * @param {string} args.cancelUrl
 * @returns {Promise<{url: string, id: string}>}
 */
async function createSignupCheckoutSession({ signupId, email, plan, addons, billingCycle, successUrl, cancelUrl }) {
  await assertAvailable();
  const stripe = await getPlatformStripe();
  // Required here rather than at the top: provisioning pulls in the tenant
  // models, which nothing else in this file needs.
  const { subscriptionFor } = require('../provisioning');
  const cycle = cycleOf(billingCycle);
  const priced = await priceLinesFor({ plan, subscription: subscriptionFor(plan, { billingCycle: cycle }, addons) }, cycle);
  if (!(priced.total > 0)) throw new PlatformBillingError('This plan is free; there is nothing to charge.', 400, 'FREE_PLAN');

  const metadata = { signupId: String(signupId), kind: 'signup', planSlug: plan.slug, billingCycle: priced.billingCycle };
  const subscriptionData = { metadata };
  const trialDays = Math.floor(Number(plan.trialDays) || 0);
  // Stripe takes up to two years.
  if (trialDays > 0) subscriptionData.trial_period_days = Math.min(trialDays, 730);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    // A card, taken up front even on a trial: the gym is made the moment this
    // completes, which a bank debit still clearing days later cannot promise.
    payment_method_types: ['card'],
    line_items: lineItemsFor(priced),
    client_reference_id: String(signupId),
    customer_email: email,
    metadata,
    subscription_data: subscriptionData,
    success_url: successUrl,
    cancel_url: cancelUrl
  });
  return { url: session.url, id: session.id };
}

/**
 * Closes an earlier payment page -- a signup's, or one a gym's Billing tab
 * opened -- so whoever came back cannot pay on the old tab as well as the
 * new one and end up with two subscriptions. Resolves the page's status
 * afterwards: 'expired' (closed, or it already was), 'complete' (it was
 * paid -- do not open another), 'open' (Stripe would not close it), or
 * 'unknown' (Stripe could not say, for a page made with keys since
 * replaced, say).
 */
async function closeCheckoutSession(sessionId) {
  const stripe = await getPlatformStripe();
  try {
    const closed = await stripe.checkout.sessions.expire(sessionId);
    return closed.status || 'expired';
  } catch {
    // Expiring a page that is no longer open is refused; ask what it is.
    const current = await stripe.checkout.sessions.retrieve(sessionId).catch(() => null);
    return current ? current.status : 'unknown';
  }
}

// Stripe subscriptions that are over: nothing charges any more.
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

/**
 * Whether Stripe has finished with a subscription: over, or unknown to it.
 * False while it can still charge -- past due or unpaid included, which is
 * how a gym the roll-over expired can still be holding one. Throws when
 * Stripe cannot be asked.
 */
async function stripeSubscriptionEnded(subscriptionId) {
  const stripe = await getPlatformStripe();
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return ENDED_STATUSES.has(subscription.status);
  } catch (error) {
    if (error && error.code === 'resource_missing') return true;
    throw error;
  }
}

/**
 * Ends a subscription at once with nothing more charged -- no final invoice,
 * no proration -- for a paid signup whose gym could never be made
 * (services/signupProvisioning.js). One already over is left as it is.
 * Resolves what its latest invoice took, so whoever is told knows whether
 * there is anything to refund.
 *
 * @returns {Promise<{status: string, amountPaid: number, currency: string}>}
 */
async function cancelSubscriptionNow(subscriptionId, stripe = null) {
  const client = stripe || (await getPlatformStripe());
  let subscription;
  try {
    subscription = await client.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false });
  } catch (error) {
    // Cancelling one that is already over is refused; ask what it is.
    subscription = await client.subscriptions.retrieve(subscriptionId).catch(() => null);
    if (!subscription || !ENDED_STATUSES.has(subscription.status)) throw error;
  }
  const invoiceId = subscription.latest_invoice && (typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice.id);
  const invoice = invoiceId ? await client.invoices.retrieve(invoiceId).catch(() => null) : null;
  const currency = String((invoice && invoice.currency) || subscription.currency || '').toUpperCase();
  return { status: subscription.status, amountPaid: invoice ? fromMinorUnits(invoice.amount_paid, currency) : 0, currency };
}

/**
 * Stops (or starts again) Stripe collecting on a subscription, for a gym the
 * panel suspends and reactivates. Paused, the subscription stays as it is --
 * same price, same dates -- and each invoice that falls due is voided rather
 * than charged, so a gym that is switched off is not paying for it. Nothing
 * is owed for the time it was paused. Throws when Stripe refuses.
 */
async function setCollectionPaused(subscriptionId, paused, stripe = null) {
  const client = stripe || (await getPlatformStripe());
  await client.subscriptions.update(subscriptionId, { pause_collection: paused ? { behavior: 'void' } : '' });
}

/**
 * The subscription a gym moving to `plan` on `billingCycle` would have: the
 * add-ons it pays for kept, the new plan's included ones added, all at the
 * list price -- a price agreed for the old plan does not carry over. Both
 * the owner's plan picker (billingController) and the webhook applying a
 * checkout for another plan (platformWebhook) work it out here, so what is
 * charged and what is recorded agree. Rejects (status 400) when an add-on
 * the gym pays for is not sold with the new plan.
 */
async function subscriptionForPlanChange(gym, plan, billingCycle) {
  // Required here rather than at the top: both pull in provisioning, which
  // nothing else in this file needs.
  const { resolveAddons } = require('../controllers/addonsController');
  const { subscriptionFor } = require('../provisioning');
  const sub = (gym && gym.subscription) || {};
  const paid = (sub.addons || []).filter((addon) => Number(addon.amount) > 0).map((addon) => addon.slug);
  const addons = await resolveAddons(paid, plan);
  return subscriptionFor(
    plan,
    {
      status: sub.status,
      billingCycle: cycleOf(billingCycle, cycleOf(sub.billingCycle)),
      startedAt: sub.startedAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      notes: sub.notes
    },
    addons
  );
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
  createSignupCheckoutSession,
  closeCheckoutSession,
  // The name signupController has always called it by.
  closeSignupCheckoutSession: closeCheckoutSession,
  stripeSubscriptionEnded,
  cancelSubscriptionNow,
  setCollectionPaused,
  subscriptionForPlanChange,
  createPortalSession,
  priceLinesFor,
  fromMinorUnits,
  intervalFor,
  PlatformBillingError,
  PlatformStripeNotConfiguredError
};
