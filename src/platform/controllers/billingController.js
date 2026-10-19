// src/platform/controllers/billingController.js
//
// A gym looking at, and paying for, its own GymsPilotPro subscription -- from
// its admin's Settings page. Mounted at /api/billing AFTER the tenant gate,
// so `req.tenant` is the gym and `auth` + requirePermission('settings') say
// who inside it may look and who may pay.
//
// The contract here is what the gym admin UI is built against:
//
//   GET  /api/billing/subscription  -> { success, data: { plan, status, billingCycle,
//                                        currentPeriodEnd, daysLeft, amount, currency,
//                                        addons, stripeConfigured, hasStripeSubscription,
//                                        contactEmail, usage } }
//                                   + pay: { provider, label, amount_due, currency, due_date,
//                                   bank_accounts, pending_request } -- how the gym pays GymsPilotPro
//                                   (platformPay.payBlock); null when it could not be worked out
//                                   usage: [{ key, label, used, limit }] -- one per plan
//                                   limit (planLimits.LIMIT_KINDS); limit null = unlimited.
//                                   null when it could not be counted, or when the
//                                   caller passed ?usage=0 (the admin banner).
//   POST /api/billing/checkout      { billingCycle?, planSlug? } -> { success, data: { url } }
//                                   planSlug subscribes to another (active) plan than the gym's.
//                                   409 { code: 'ALREADY_SUBSCRIBED' } when Stripe already bills the gym
//                                   -- including an expired gym whose Stripe subscription is still
//                                   waiting on a payment (open the portal instead);
//                                   409 { code: 'CHECKOUT_COMPLETED' } when the page opened last was
//                                   paid a moment ago and the webhook has not recorded it yet
//   POST /api/billing/portal        -> { success, data: { url } }
//   POST /api/billing/receipt       multipart `receipt` (JPG/PNG/WebP/PDF, 4 MB) + reference?, note?,
//                                   billingCycle? -> { success, data: { pending_request } }: a bank
//                                   transfer receipt for the super admin to approve
//   POST /api/billing/pay           { billingCycle?, planSlug? } -> { success, data: { url } }: Safepay's
//                                   page, with GymsPilotPro's own keys, when that is how gyms pay;
//                                   409 STRIPE_CHECKOUT / BANK_TRANSFER_ONLY / ONLINE_PAYMENT_OFF otherwise
//   GET  /api/billing/plans         -> { success, data: [{ slug, name, description, price, limits,
//                                        features, trialDays, current }] } -- what the gym can move to
//   POST /api/billing/change-plan   { planSlug, billingCycle? } -> { success, message, data: { plan,
//                                        billingCycle, amount, currency } } -- a gym Stripe bills,
//                                   moved at once, prorated. 409 { code: 'NO_STRIPE_SUBSCRIPTION' }
//                                   when Stripe does not bill it (subscribe through checkout instead)
//
// Stripe sends the owner back to /admin/settings?tab=billing, with
// &billing=success or &billing=cancelled after a checkout.

const Gym = require('../models/gymModel');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { planFor } = require('../entitlements');
// platformBillingAvailable: may a gym START paying by card (Stripe usable
// and the way gyms pay); platformStripeAvailable: may what Stripe already
// bills go on (the portal, a plan change on a running subscription).
const { platformBillingAvailable, platformStripeAvailable } = require('../services/platformStripe');
// Called through the modules, not destructured, so a test can stand in for Stripe.
const platformBilling = require('../services/platformBilling');
const subscriptionSync = require('../services/subscriptionSync');
const { invalidateTenantCache } = require('../middleware/resolveTenant');
const { frontendOrigin } = require('../tenantContext');
const { LIMIT_KINDS } = require('../planLimits');
const User = require('../../models/user');

const PlatformSettings = require('../models/platformSettingsModel');
// Paying GymsPilotPro another way than Stripe: which way, and for what.
const platformPay = require('../services/platformPay');
const platformSafepay = require('../services/platformSafepay');
const paymentRequests = require('../services/paymentRequests');
const { SafepayError } = require('../../services/safepay');

const { PlatformBillingError, PlatformStripeNotConfiguredError } = platformBilling;
const { SubscriptionSyncError } = subscriptionSync;
const { PlatformPayError } = platformPay;

function fail(res, error) {
  if (error instanceof PlatformStripeNotConfiguredError) {
    return res.status(409).json({ success: false, code: error.code, message: error.message });
  }
  if (error instanceof PlatformBillingError || error instanceof SubscriptionSyncError || error instanceof PlatformPayError || error instanceof SafepayError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.error('[billing]', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

/** The gym as it is now, not as the resolver cached it half a minute ago. */
async function freshGym(req) {
  return (await Gym.findByIdWithUri(req.tenant._id)) || req.tenant;
}

// A Stripe subscription in one of these is still charging the gym; a second
// checkout would bill it twice. Expired / cancelled gyms may start afresh.
const LIVE_STATUSES = ['trialing', 'active', 'past_due'];

function hasLiveStripeSubscription(gym) {
  const sub = (gym && gym.subscription) || {};
  return !!sub.stripeSubscriptionId && LIVE_STATUSES.includes(sub.status);
}

/** Where Stripe sends the owner back to: the Billing tab of Settings. */
function billingTabUrl(origin, outcome) {
  return `${origin}/admin/settings?tab=billing${outcome ? `&billing=${outcome}` : ''}`;
}

function daysUntil(date, now = new Date()) {
  if (!date) return null;
  const end = new Date(date).getTime();
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - now.getTime()) / 86400000);
}

/**
 * How much of each plan limit the gym is using, for the meter on the Billing
 * tab. Counted by the very functions planLimits enforces with -- the owner
 * left out of staff and all -- inside the gym's own tenant context, so the
 * meter reads full exactly when a create would be refused. A limit of 0, or
 * no plan at all, is unlimited and reported as null.
 *
 * @returns {Promise<{key: string, label: string, used: number, limit: number|null}[]>}
 */
async function planUsage(plan, kinds = LIMIT_KINDS) {
  const limits = (plan && plan.limits) || {};
  return Promise.all(
    Object.entries(kinds).map(async ([key, spec]) => {
      const limit = Number(limits[spec.field]);
      return {
        key,
        label: spec.label.charAt(0).toUpperCase() + spec.label.slice(1),
        used: Number(await spec.count()) || 0,
        limit: limit > 0 ? limit : null
      };
    })
  );
}

/** A plan as the Billing tab's picker shows it. Limits of 0 are unlimited, as everywhere. */
function planView(plan, currentPlanId = '') {
  const price = plan.price || {};
  const limits = plan.limits || {};
  return {
    slug: plan.slug,
    name: plan.name,
    description: plan.description || '',
    price: {
      monthly: Number(price.monthly) || 0,
      yearly: Number(price.yearly) || 0,
      currency: String(price.currency || 'USD').toUpperCase()
    },
    limits: {
      maxMembers: Number(limits.maxMembers) || 0,
      maxStaff: Number(limits.maxStaff) || 0,
      maxTrainers: Number(limits.maxTrainers) || 0,
      maxClasses: Number(limits.maxClasses) || 0
    },
    features: plan.features || [],
    trialDays: Number(plan.trialDays) || 0,
    current: !!currentPlanId && String(plan._id) === currentPlanId
  };
}

function currentPlanId(gym) {
  return gym && gym.plan ? String(gym.plan._id || gym.plan) : '';
}

/**
 * The plan an owner picked, if it is on sale and has a price for the cycle.
 * Answers { plan } or { status, body } to send back.
 */
async function pickPlan(slug, cycle) {
  const plan = slug ? await PlatformPlan.findOne({ slug: String(slug).toLowerCase().trim(), isActive: true }).lean() : null;
  if (!plan) return { status: 404, body: { success: false, code: 'PLAN_NOT_FOUND', message: 'That plan is not on sale any more. Pick another one.' } };
  if (!(Number(plan.price && plan.price[cycle]) > 0)) {
    return {
      status: 400,
      body: {
        success: false,
        code: 'CYCLE_NOT_OFFERED',
        message: Number(plan.price && plan.price.monthly) > 0 || Number(plan.price && plan.price.yearly) > 0 ? `${plan.name} is not sold ${cycle}.` : `${plan.name} is free, so there is nothing to pay for.`
      }
    };
  }
  return { plan };
}

/**
 * Whether an expired gym's Stripe subscription can still charge it. The
 * roll-over expires a gym whose card kept failing while Stripe goes on
 * retrying -- so its subscription is past due or unpaid there, not over. A
 * new checkout then would start a second subscription beside it; paying the
 * open invoice in the portal is what brings the gym back.
 */
async function stillBilledByStripe(gym) {
  const sub = (gym && gym.subscription) || {};
  if (!sub.stripeSubscriptionId) return false;
  return !(await platformBilling.stripeSubscriptionEnded(sub.stripeSubscriptionId));
}

module.exports = {
  // GET /api/billing/subscription
  subscription: async (req, res) => {
    try {
      const gym = await freshGym(req);
      const sub = gym.subscription || {};
      // A gym Stripe already bills keeps its card buttons whichever way new
      // payments go; any other gym is offered Stripe only when it is the way.
      const [plan, stripe] = await Promise.all([planFor(gym), hasLiveStripeSubscription(gym) ? platformStripeAvailable() : platformBillingAvailable()]);
      // The meter is extra: a count that fails must not cost the gym its
      // Billing tab or the admin shell its billing banner. The banner asks on
      // every admin page load and needs only the status, so it skips the
      // counts with ?usage=0.
      // How the gym pays GymsPilotPro, the same way: extra, never the tab.
      const pay = await platformPay.payBlock(gym).catch((error) => {
        console.error('[billing] pay block failed:', error.message);
        return null;
      });
      const usage =
        req.query.usage === '0'
          ? null
          : await planUsage(plan).catch((error) => {
              console.error('[billing] usage count failed:', error.message);
              return null;
            });

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
          contactEmail: process.env.PLATFORM_CONTACT_EMAIL || '',
          pay,
          usage
        }
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/billing/checkout   { billingCycle?: 'monthly' | 'yearly', planSlug?: string }
  checkout: async (req, res) => {
    try {
      const gym = await freshGym(req);
      const body = req.body || {};
      if (body.billingCycle !== undefined && !Gym.BILLING_CYCLES.includes(body.billingCycle)) {
        return res.status(400).json({ success: false, message: `Billing cycle must be one of: ${Gym.BILLING_CYCLES.join(', ')}` });
      }
      const sub = gym.subscription || {};
      if (!gym.plan && !body.planSlug) return res.status(400).json({ success: false, code: 'NO_PLAN', message: 'This gym is not on a plan, so there is nothing to subscribe to.' });

      if (hasLiveStripeSubscription(gym)) {
        return res.status(409).json({
          success: false,
          code: 'ALREADY_SUBSCRIBED',
          message: 'This gym already has a subscription. Change its plan on this page, and its card from Manage billing.'
        });
      }
      if (await stillBilledByStripe(gym)) {
        return res.status(409).json({
          success: false,
          code: 'ALREADY_SUBSCRIBED',
          message: 'This gym still has a subscription waiting on a payment. Pay it, or update the card, from Manage billing: the gym comes back as soon as Stripe is paid.'
        });
      }

      // Subscribing to another plan than the gym's (the plan picker, before
      // Stripe bills the gym): priced as that plan, and the gym moves to it
      // once the payment lands (platformWebhook.applyCheckoutToGym).
      let target = gym;
      if (body.planSlug && String(body.planSlug).toLowerCase().trim() !== ((await planFor(gym)) || {}).slug) {
        const cycle = body.billingCycle || sub.billingCycle || 'monthly';
        const picked = await pickPlan(body.planSlug, cycle);
        if (!picked.plan) return res.status(picked.status).json(picked.body);
        let next;
        try {
          next = await platformBilling.subscriptionForPlanChange(gym, picked.plan, cycle);
        } catch (error) {
          return res.status(error.status || 400).json({ success: false, message: error.message });
        }
        target = { ...gym, plan: picked.plan._id, subscription: { ...sub, billingCycle: next.billingCycle, planAmount: next.planAmount, addons: next.addons } };
      }

      // The page opened last time is closed first, so two tabs cannot start
      // two subscriptions.
      if (sub.checkoutSessionId) {
        const previous = await platformBilling.closeCheckoutSession(sub.checkoutSessionId);
        if (previous === 'complete') {
          return res.status(409).json({
            success: false,
            code: 'CHECKOUT_COMPLETED',
            message: 'A payment for this gym has just gone through. Give it a minute to show here before paying again.'
          });
        }
        if (previous === 'open') {
          return res.status(502).json({ success: false, message: 'We could not open a new payment page just now. Nothing was charged; please try again.' });
        }
      }

      const origin = frontendOrigin();
      const { url, id } = await platformBilling.createCheckoutSession({
        gym: target,
        billingCycle: body.billingCycle,
        successUrl: billingTabUrl(origin, 'success'),
        cancelUrl: billingTabUrl(origin, 'cancelled')
      });
      await Gym.updateOne({ _id: gym._id }, { $set: { 'subscription.checkoutSessionId': id || '' } });
      return res.json({ success: true, data: { url } });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/billing/pay   { billingCycle?: 'monthly' | 'yearly', planSlug?: string }
  //
  // "Pay now" when gyms pay GymsPilotPro through its Safepay account: a
  // Safepay hosted checkout with the PLATFORM's keys for what the gym owes
  // (platformPay.payTerms: its agreed amount, or another cycle or plan
  // priced from the list), returning to <gym's primary site>/admin/
  // settings?tab=billing&paid=1 (cancel: ...?tab=billing). The webhook
  // records the payment and moves the paid-until date. Any other way is a
  // 409 that says which: STRIPE_CHECKOUT (use /checkout and /portal),
  // BANK_TRANSFER_ONLY (upload a receipt), ONLINE_PAYMENT_OFF.
  pay: async (req, res) => {
    try {
      const gym = await freshGym(req);
      const settings = await PlatformSettings.getSettings();
      const provider = await platformPay.providerIdFor(gym, settings);
      if (provider === 'stripe') {
        return res.status(409).json({ success: false, code: 'STRIPE_CHECKOUT', message: 'This gym pays by card through Stripe: use Subscribe or Manage billing.' });
      }
      if (provider === 'generic') {
        return res.status(409).json({ success: false, code: 'BANK_TRANSFER_ONLY', message: 'Pay by bank transfer to a GymsPilotPro account, then upload the receipt.' });
      }
      if (provider !== 'safepay') {
        return res.status(409).json({ success: false, code: 'ONLINE_PAYMENT_OFF', message: `Online payment is not available. Contact ${process.env.PLATFORM_CONTACT_EMAIL || 'GymsPilotPro'} to pay.` });
      }
      const terms = await platformPay.payTerms(gym, req.body || {});
      const { url } = await platformSafepay.openCheckout({ gym, terms, settings, actor: req.user });
      return res.json({ success: true, data: { url } });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/billing/receipt   multipart: receipt (file), reference?, note?, billingCycle?
  //
  // "We have paid by bank transfer": the receipt for GymsPilotPro to check
  // (services/paymentRequests.js). Taken while GymsPilotPro lists a bank
  // account to pay into; replaces a receipt still waiting. 409 STRIPE_BILLED
  // for a gym Stripe bills, BANK_TRANSFER_OFF with no account to pay into,
  // REVIEW_IN_PROGRESS while the last one is being approved.
  receipt: async (req, res) => {
    try {
      const gym = await freshGym(req);
      // Who sent it, by name, for the super admin's list.
      const account = req.user && req.user.id ? await User.findById(req.user.id).select('firstName lastName email').lean().catch(() => null) : null;
      const user = { ...(account || {}), ...(req.user || {}), id: req.user && req.user.id };
      const row = await paymentRequests.submitReceipt({ gym, file: req.file, body: req.body || {}, user });
      PlatformAuditLog.record({
        actorId: null,
        actorEmail: (req.user && req.user.email) || 'gym admin',
        action: 'gym_receipt_submitted',
        gymId: gym._id,
        gymSlug: gym.slug,
        meta: { requestId: String(row._id), amount: row.amount, currency: row.currency, reference: row.reference }
      });
      return res.status(201).json({ success: true, message: 'Receipt sent. GymsPilotPro will confirm it.', data: { pending_request: paymentRequests.gymView(row) } });
    } catch (error) {
      // Refused or failed: the file is not kept (submitReceipt removes what it stored).
      if (req.file && req.file.path) require('fs').promises.unlink(req.file.path).catch(() => {});
      return fail(res, error);
    }
  },

  // GET /api/billing/plans
  //
  // The plans on sale, for the Billing tab's picker; `current` marks the
  // gym's own.
  plans: async (req, res) => {
    try {
      const gym = await freshGym(req);
      const plans = await PlatformPlan.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean();
      const current = currentPlanId(gym);
      return res.json({ success: true, data: plans.map((plan) => planView(plan, current)) });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/billing/change-plan   { planSlug, billingCycle?: 'monthly' | 'yearly' }
  //
  // An owner moving the gym to another plan, or cycle, with Stripe first:
  // the subscription's items are replaced, prorated, and the change is only
  // recorded once Stripe has taken it (services/subscriptionSync.js, as the
  // panel does it). An upgrade on a paid subscription charges the difference
  // for the rest of the period now; a downgrade leaves a credit on the next
  // invoice; on a trial nothing is charged until it ends. A gym Stripe does
  // not bill subscribes through checkout with the plan instead.
  changePlan: async (req, res) => {
    try {
      const gym = await freshGym(req);
      const body = req.body || {};
      if (!body.planSlug) return res.status(400).json({ success: false, message: 'Pick a plan.' });
      if (body.billingCycle !== undefined && !Gym.BILLING_CYCLES.includes(body.billingCycle)) {
        return res.status(400).json({ success: false, message: `Billing cycle must be one of: ${Gym.BILLING_CYCLES.join(', ')}` });
      }
      const sub = gym.subscription || {};
      const cycle = body.billingCycle || sub.billingCycle || 'monthly';

      const picked = await pickPlan(body.planSlug, cycle);
      if (!picked.plan) return res.status(picked.status).json(picked.body);
      const plan = picked.plan;

      const stripe = await platformStripeAvailable();
      if (!stripe.available) throw new PlatformStripeNotConfiguredError(stripe.reason);
      if (!hasLiveStripeSubscription(gym)) {
        return res.status(409).json({ success: false, code: 'NO_STRIPE_SUBSCRIPTION', message: 'This gym does not pay by card yet. Subscribe to the plan instead.' });
      }
      if (sub.status === 'past_due') {
        return res.status(409).json({ success: false, code: 'PAYMENT_OVERDUE', message: 'Your last payment did not go through. Update your card from Manage billing, then change the plan.' });
      }
      if (currentPlanId(gym) === String(plan._id) && cycle === (sub.billingCycle || 'monthly')) {
        return res.status(400).json({ success: false, code: 'SAME_PLAN', message: `This gym is already on ${plan.name}, billed ${cycle}.` });
      }

      // A running subscription cannot change currency -- subscriptionSync
      // refuses it too -- said here for an owner rather than the panel.
      const billed = String(sub.currency || '').toUpperCase();
      const priced = String((plan.price && plan.price.currency) || '').toUpperCase();
      if (billed && priced && billed !== priced) {
        return res.status(409).json({
          success: false,
          code: 'CURRENCY_MISMATCH',
          message: `${plan.name} is priced in ${priced}, but this gym pays in ${billed}. Contact ${process.env.PLATFORM_CONTACT_EMAIL || 'GymsPilotPro support'} to change currency.`
        });
      }
      let next;
      try {
        next = await platformBilling.subscriptionForPlanChange(gym, plan, cycle);
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, message: error.message });
      }

      const before = await planFor(gym);
      const synced = await subscriptionSync.syncStripeSubscription({ gym, plan, next });
      if (!synced.synced) {
        return res.status(409).json({ success: false, code: 'NO_STRIPE_SUBSCRIPTION', message: 'This gym\'s Stripe subscription has ended. Subscribe to the plan instead.' });
      }

      // Stripe has taken it: now the record. Named fields only -- the status,
      // period and Stripe's bookkeeping are the webhook's.
      await Gym.updateOne(
        { _id: gym._id },
        {
          $set: {
            plan: plan._id,
            'subscription.billingCycle': next.billingCycle,
            'subscription.planAmount': next.planAmount,
            'subscription.addons': next.addons,
            'subscription.amount': next.amount,
            'subscription.stripePriceSummary': synced.summary || sub.stripePriceSummary || ''
          }
        }
      );
      invalidateTenantCache();
      PlatformAuditLog.record({
        actorId: null,
        actorEmail: (req.user && req.user.email) || 'gym admin',
        action: 'gym_plan_changed',
        gymId: gym._id,
        gymSlug: gym.slug,
        meta: { by: 'owner', from: before ? before.slug : null, to: plan.slug, billingCycle: next.billingCycle, status: sub.status }
      });

      return res.json({
        success: true,
        message: sub.status === 'trialing' ? `You are on ${plan.name} now. Nothing is charged until your trial ends.` : `You are on ${plan.name} now.`,
        data: { plan: { name: plan.name, slug: plan.slug }, billingCycle: next.billingCycle, amount: next.amount, currency: String(next.currency).toUpperCase() }
      });
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
      const { url } = await platformBilling.createPortalSession({ gym, returnUrl: billingTabUrl(frontendOrigin()) });
      return res.json({ success: true, data: { url } });
    } catch (error) {
      return fail(res, error);
    }
  },

  // exported for tests
  hasLiveStripeSubscription,
  billingTabUrl,
  planUsage,
  planView
};
