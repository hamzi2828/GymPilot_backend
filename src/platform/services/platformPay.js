// src/platform/services/platformPay.js
//
// A gym paying GymsPilotPro, from its own Billing tab: which way it pays
// (the way the super admin chose, services/payments -- or Stripe, for a gym
// Stripe already bills), and what a payment is for: the amount and currency,
// and what else it changes when the owner picked another cycle or plan.
// Amounts are never taken from the browser.

const Gym = require('../models/gymModel');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformSettings = require('../models/platformSettingsModel');
const gateways = require('./payments');
const { planFor } = require('../entitlements');

class PlatformPayError extends Error {
  constructor(message, status = 400, code = 'PLATFORM_PAY') {
    super(message);
    this.name = 'PlatformPayError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The way this gym pays now: 'stripe' for a gym Stripe bills (it has a
 * Stripe subscription; manualPayments refuses to record anything else for
 * it), else the way chosen when it is set up, else 'none'.
 */
async function providerIdFor(gym, settings) {
  const sub = (gym && gym.subscription) || {};
  if (sub.stripeSubscriptionId) return 'stripe';
  const active = await gateways.activeProvider(settings === undefined ? await PlatformSettings.getSettings() : settings);
  return active ? active.id : 'none';
}

function cycleOf(value) {
  return value === 'yearly' ? 'yearly' : 'monthly';
}

/**
 * What a payment from the Billing tab is for, worked out on the server:
 *
 *   { amount, currency, billingCycle, change, planName }
 *
 * The gym's own plan and cycle: its agreed amount (`subscription.amount`),
 * and nothing else changes (`change: null`). Another cycle, or another plan
 * (`planSlug`): priced from the plan's list as the Stripe checkout prices it
 * (platformBilling.subscriptionForPlanChange), and `change` is what paying
 * moves the subscription to -- { plan?, billingCycle, planAmount, addons,
 * amount, currency }.
 *
 * @throws {PlatformPayError} 400 INVALID_CYCLE / CYCLE_NOT_OFFERED / NOTHING_TO_PAY, 404 PLAN_NOT_FOUND
 */
async function payTerms(gym, { billingCycle, planSlug } = {}) {
  if (billingCycle !== undefined && billingCycle !== null && billingCycle !== '' && !Gym.BILLING_CYCLES.includes(billingCycle)) {
    throw new PlatformPayError(`Billing cycle must be one of: ${Gym.BILLING_CYCLES.join(', ')}`, 400, 'INVALID_CYCLE');
  }
  const sub = (gym && gym.subscription) || {};
  const ownCycle = cycleOf(sub.billingCycle);
  const cycle = billingCycle ? cycleOf(billingCycle) : ownCycle;
  const current = await planFor(gym);
  const slug = typeof planSlug === 'string' ? planSlug.toLowerCase().trim() : '';

  let plan = null;
  if (slug && !(current && current.slug === slug)) {
    plan = await PlatformPlan.findOne({ slug, isActive: true }).lean();
    if (!plan) throw new PlatformPayError('That plan is not on sale any more. Pick another one.', 404, 'PLAN_NOT_FOUND');
  } else if (cycle !== ownCycle) {
    plan = current;
    if (!plan) throw new PlatformPayError(`This gym's price is agreed ${ownCycle}. Contact GymsPilotPro to pay ${cycle}.`, 400, 'CYCLE_NOT_OFFERED');
  }

  if (!plan) {
    const amount = Number(sub.amount) || 0;
    if (!(amount > 0)) throw new PlatformPayError('There is nothing to pay for this gym.', 400, 'NOTHING_TO_PAY');
    return { amount, currency: String(sub.currency || 'PKR').toUpperCase(), billingCycle: ownCycle, change: null, planName: current ? current.name : '' };
  }

  if (!(Number(plan.price && plan.price[cycle]) > 0)) {
    const priced = Number(plan.price && plan.price.monthly) > 0 || Number(plan.price && plan.price.yearly) > 0;
    throw new PlatformPayError(priced ? `${plan.name} is not sold ${cycle}.` : `${plan.name} is free, so there is nothing to pay for.`, 400, 'CYCLE_NOT_OFFERED');
  }
  // Required here: platformBilling pulls in Stripe, which nothing else here needs.
  const { subscriptionForPlanChange } = require('./platformBilling');
  let next;
  try {
    next = await subscriptionForPlanChange(gym, plan, cycle);
  } catch (error) {
    throw new PlatformPayError(error.message, error.status || 400, 'PLAN_NOT_PAYABLE');
  }
  const amount = Number(next.amount) || 0;
  if (!(amount > 0)) throw new PlatformPayError('There is nothing to pay for this plan.', 400, 'NOTHING_TO_PAY');
  const newPlan = !current || String(current._id) !== String(plan._id);
  return {
    amount,
    currency: String(next.currency || 'PKR').toUpperCase(),
    billingCycle: next.billingCycle,
    planName: plan.name,
    change: {
      ...(newPlan ? { plan: plan._id } : {}),
      billingCycle: next.billingCycle,
      planAmount: Number(next.planAmount) || 0,
      addons: (next.addons || []).map((a) => ({ slug: a.slug, name: a.name || '', amount: Number(a.amount) || 0 })),
      amount,
      currency: String(next.currency || 'PKR').toUpperCase()
    }
  };
}

/**
 * The `pay` block of GET /api/billing/subscription: how this gym pays, what
 * is due and when, GymsPilotPro's bank accounts (bank transfer only) and
 * where its last receipt stands.
 *
 *   { provider: 'none'|'stripe'|'safepay'|'generic', label, amount_due, currency,
 *     due_date: 'YYYY-MM-DD'|null, bank_accounts: [{ bank_name, account_title,
 *     account_number, iban, qr_code_url }], pending_request: { status, reason,
 *     submitted_at, amount } | null }
 */
async function payBlock(gym, settings) {
  const s = settings === undefined ? await PlatformSettings.getSettings() : settings;
  const provider = await providerIdFor(gym, s);
  const module_ = gateways.getProvider(provider);
  const sub = (gym && gym.subscription) || {};
  // Required here: both pull in the payment request model and emails.
  const { activeAccounts, gymFacingAccount } = require('./platformBankAccounts');
  const { pendingRequestFor } = require('./paymentRequests');
  return {
    provider,
    label: module_ ? module_.checkoutLabel : '',
    amount_due: Number(sub.amount) || 0,
    currency: String(sub.currency || 'PKR').toUpperCase(),
    due_date: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toISOString().slice(0, 10) : null,
    bank_accounts: provider === 'generic' ? activeAccounts(s).map(gymFacingAccount) : [],
    pending_request: await pendingRequestFor(gym._id)
  };
}

module.exports = { PlatformPayError, providerIdFor, payTerms, payBlock };
