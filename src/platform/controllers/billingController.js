// src/platform/controllers/billingController.js
//
// A gym looking at, and paying for, its own GymPilot subscription -- from
// its admin's Settings page. Mounted at /api/billing AFTER the tenant gate,
// so `req.tenant` is the gym and `auth` + requirePermission('settings') say
// who inside it may look and who may pay.
//
// The contract here is what the gym admin UI is built against:
//
//   GET  /api/billing/subscription  -> { success, data: { plan, status, billingCycle,
//                                        currentPeriodEnd, daysLeft, amount, currency,
//                                        addons, stripeConfigured, hasStripeSubscription,
//                                        contactEmail } }
//   POST /api/billing/checkout      { billingCycle? } -> { success, data: { url } }
//   POST /api/billing/portal        -> { success, data: { url } }

const Gym = require('../models/gymModel');
const { planFor } = require('../entitlements');
const { platformBillingAvailable } = require('../services/platformStripe');
const { createCheckoutSession, createPortalSession, PlatformBillingError, PlatformStripeNotConfiguredError } = require('../services/platformBilling');
const { frontendOrigin } = require('../tenantContext');

function fail(res, error) {
  if (error instanceof PlatformStripeNotConfiguredError) {
    return res.status(409).json({ success: false, code: error.code, message: error.message });
  }
  if (error instanceof PlatformBillingError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.error('[billing]', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

/** The gym as it is now, not as the resolver cached it half a minute ago. */
async function freshGym(req) {
  return (await Gym.findByIdWithUri(req.tenant._id)) || req.tenant;
}

function daysUntil(date, now = new Date()) {
  if (!date) return null;
  const end = new Date(date).getTime();
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - now.getTime()) / 86400000);
}

module.exports = {
  // GET /api/billing/subscription
  subscription: async (req, res) => {
    try {
      const gym = await freshGym(req);
      const sub = gym.subscription || {};
      const [plan, stripe] = await Promise.all([planFor(gym), platformBillingAvailable()]);

      return res.json({
        success: true,
        data: {
          plan: plan
            ? {
                name: plan.name,
                slug: plan.slug,
                price: {
                  monthly: Number((plan.price && plan.price.monthly) || 0),
                  yearly: Number((plan.price && plan.price.yearly) || 0),
                  currency: String((plan.price && plan.price.currency) || 'USD').toUpperCase()
                },
                trialDays: Number(plan.trialDays) || 0
              }
            : null,
          status: sub.status || 'active',
          billingCycle: sub.billingCycle || 'monthly',
          currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toISOString() : null,
          daysLeft: daysUntil(sub.currentPeriodEnd),
          amount: Number(sub.amount) || 0,
          currency: String(sub.currency || (plan && plan.price && plan.price.currency) || 'USD').toUpperCase(),
          addons: (sub.addons || []).map((a) => ({ slug: a.slug, name: a.name || a.slug, amount: Number(a.amount) || 0 })),
          stripeConfigured: stripe.available,
          hasStripeSubscription: !!sub.stripeSubscriptionId,
          contactEmail: process.env.PLATFORM_CONTACT_EMAIL || ''
        }
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/billing/checkout   { billingCycle?: 'monthly' | 'yearly' }
  checkout: async (req, res) => {
    try {
      const gym = await freshGym(req);
      if (!gym.plan) return res.status(400).json({ success: false, code: 'NO_PLAN', message: 'This gym is not on a plan, so there is nothing to subscribe to.' });

      const body = req.body || {};
      if (body.billingCycle !== undefined && !Gym.BILLING_CYCLES.includes(body.billingCycle)) {
        return res.status(400).json({ success: false, message: `Billing cycle must be one of: ${Gym.BILLING_CYCLES.join(', ')}` });
      }

      const origin = frontendOrigin();
      const { url } = await createCheckoutSession({
        gym,
        billingCycle: body.billingCycle,
        successUrl: `${origin}/admin/settings?billing=success`,
        cancelUrl: `${origin}/admin/settings?billing=cancelled`
      });
      return res.json({ success: true, data: { url } });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/billing/portal
  portal: async (req, res) => {
    try {
      const gym = await freshGym(req);
      if (!(gym.subscription && gym.subscription.stripeCustomerId)) {
        return res.status(409).json({ success: false, code: 'NO_STRIPE_CUSTOMER', message: 'This gym has not paid through Stripe yet, so there is no billing account to open.' });
      }
      const { url } = await createPortalSession({ gym, returnUrl: `${frontendOrigin()}/admin/settings` });
      return res.json({ success: true, data: { url } });
    } catch (error) {
      return fail(res, error);
    }
  }
};
