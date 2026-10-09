// src/platform/controllers/signupController.js
//
// Signing up and paying on the marketing site, with nobody in the panel in
// between. `start` checks the form the way a demo request is checked
// (demoRequestsController.validateDemoRequest), prices it on the server,
// makes sure the web address is free BEFORE anyone pays for it, keeps the
// answers as a DemoRequest of kind 'signup', and hands back a Stripe
// Checkout page. The webhook builds the gym once Stripe says it is paid
// (services/signupProvisioning.js); `status` is what the success page polls
// meanwhile.
//
// Offered only when it can work end to end (selfServeAvailable). When it
// cannot, checkout sends a request as it always did and the panel sets the
// gym up.

const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const DemoRequest = require('../models/demoRequestModel');
const PlatformPlan = require('../models/platformPlanModel');
const { validateDemoRequest, priceSelection } = require('./demoRequestsController');
const { resolveAddons } = require('./addonsController');
const { slugify, isReservedSlug, freeSlugFrom } = require('../provisioning');
const { subdomainHostFor } = require('../tenantContext');
const { platformBillingAvailable, platformStripeConfig, PlatformStripeNotConfiguredError } = require('../services/platformStripe');
// Called through the modules, not destructured, so a test can stand in for them.
const platformBilling = require('../services/platformBilling');
const signupProvisioning = require('../services/signupProvisioning');
const platformEmail = require('../services/platformEmail');
const { afterResponse } = require('../../services/afterResponse');

const { PlatformBillingError } = platformBilling;

// provisioning.freeSlugFrom caps a slug here so the database name built
// from it fits; the address checked must be the address the gym gets.
const MAX_SLUG_LENGTH = 44;
// How long an unpaid signup keeps its web address from others: as long as
// Stripe keeps a Checkout page open by default.
const HOLD_MS = 24 * 60 * 60 * 1000;
// How long a signup that paid but could not be set up blocks its buyer from
// paying again: Stripe's retry window, during which it may yet succeed.
const FAILED_BLOCK_MS = 3 * 24 * 60 * 60 * 1000;

const UNAVAILABLE = {
  success: false,
  code: 'SELF_SERVE_UNAVAILABLE',
  message: 'Paying online is not available right now. Send your details instead and we will set your gym up.'
};

// What the success page says at each step. Nothing about who signed up.
const STATUS_MESSAGES = {
  awaiting_payment: 'Waiting for Stripe to confirm your payment.',
  provisioning: 'Payment confirmed. We are setting up your gym now.',
  ready: 'Your gym is ready. Check your email for the link to set your admin password.',
  failed: 'Your payment went through, but setting up your gym hit a problem. We are retrying automatically and our team has been told. There is no need to pay again.'
};
const READY_NO_EMAIL = 'Your gym is ready, but the email with your set-password link did not go out. Our team has been told and will send it shortly.';
const GAVE_UP = 'Your payment went through, but we could not set up your gym. We have cancelled the subscription so nothing more is charged, and emailed you. Our team will be in touch.';

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Whether the platform's email settings are there at all (services/
// platformEmail.js, which also asks the mail server whether they work).
const { platformEmailConfigured } = platformEmail;

/**
 * Whether checkout may take payment and build the gym itself. Everything
 * that has to be true for a buyer who pays to end up with a working gym:
 *   * a platform root domain, or a new gym has no web address and its
 *     owner's set-password link opens on nothing (provisioning requireSite);
 *   * the platform's Stripe keys saved and charging switched on;
 *   * a webhook signing secret, or every event is refused and the gym is
 *     never made after the buyer has paid;
 *   * the platform's own email, and working: a gym made a moment ago has
 *     nothing under Settings → Email yet, so its owner's set-password link
 *     goes out through the env SMTP -- and that email is the only way into
 *     the gym they have just paid for. The settings being filled in is not
 *     enough (a wrong password is filled in too), so the mail server is
 *     asked whether it accepts the connection and login
 *     (platformEmail.verifyPlatformEmail, remembered for a couple of
 *     minutes). Asked last: it is the one check that leaves the building.
 * PLATFORM_SELF_SERVE_SIGNUP=off turns it off whatever else is true, for an
 * operator who wants every new gym to go through the panel.
 *
 * @returns {Promise<{available: boolean, reason: string}>}
 */
async function selfServeAvailable() {
  if (['off', '0', 'false', 'no'].includes(String(process.env.PLATFORM_SELF_SERVE_SIGNUP || '').toLowerCase().trim())) {
    return { available: false, reason: 'Switched off by PLATFORM_SELF_SERVE_SIGNUP' };
  }
  if (!subdomainHostFor('gym')) return { available: false, reason: 'PLATFORM_ROOT_DOMAIN is not set, so a new gym would have no web address' };
  if (!platformEmailConfigured()) {
    return { available: false, reason: 'SMTP_HOST, SMTP_USER and SMTP_PASS are not all set, so the owner of a new gym would never get the link to set their password' };
  }
  const billing = await platformBillingAvailable();
  if (!billing.available) return billing;
  const { webhookSecret } = await platformStripeConfig();
  if (!webhookSecret) return { available: false, reason: 'The platform has no Stripe webhook signing secret, so a payment could never create its gym' };
  const email = await platformEmail.verifyPlatformEmail();
  if (!email.ok) {
    return { available: false, reason: `The platform's mail server (SMTP_HOST) would not accept a connection and login (${email.error}), so the owner of a new gym would never get the link to set their password` };
  }
  return { available: true, reason: '' };
}

/**
 * The form, checked as a checkout request is, plus what paying needs: a
 * plan, and both halves of the owner's name (their account inside the gym
 * is made from them). Returns { spam } for a filled honeypot, otherwise
 * { errors, data }.
 */
function validateSignup(body) {
  const b = body && typeof body === 'object' ? body : {};
  const result = validateDemoRequest({ ...b, kind: 'trial' });
  if (result.spam) return result;
  const data = { ...result.data, kind: 'signup', timezone: text(b.timezone, 64) };
  const errors = [...result.errors];
  // With no name at all, validateDemoRequest has already said so.
  if (data.name && !data.firstName) errors.push('Your first name is required');
  if (data.name && !data.lastName) errors.push('Your last name is required');
  if (!data.planSlug) errors.push('Pick a plan');
  return { spam: false, errors, data };
}

/** The address a gym gets for what was typed, exactly as provisioning will make it. */
function webAddressFor(preferred, gymName) {
  return slugify(preferred || gymName).slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
}

/**
 * Why `slug` cannot be this buyer's web address, or null when it can: not
 * a valid label, reserved, a gym's already, or held by somebody else's
 * signup that is paying or has paid.
 */
async function webAddressProblem(slug, email, now = Date.now()) {
  if (!slug || !Gym.SLUG_PATTERN.test(slug)) {
    return { status: 400, code: 'SLUG_INVALID', message: 'Choose a web address with at least two letters or numbers.' };
  }
  const host = subdomainHostFor(slug) || slug;
  const [gym, held] = isReservedSlug(slug)
    ? [true, null]
    : await Promise.all([
        Gym.findOne({ $or: [{ slug }, { 'domains.host': host }] }).select('_id').lean(),
        DemoRequest.findOne({
          kind: 'signup',
          preferredSlug: slug,
          email: { $ne: email },
          gymId: null,
          'signup.stripeSessionId': { $nin: ['', null] },
          // Given up on: its subscription is cancelled, and the address free.
          'signup.gaveUpAt': null,
          $or: [
            { 'signup.state': { $in: ['provisioning', 'failed'] } },
            { 'signup.state': 'awaiting_payment', updatedAt: { $gte: new Date(now - HOLD_MS) } }
          ]
        })
          .select('_id')
          .lean()
      ]);
  if (!gym && !held) return null;

  // Somewhere to go next. Only a hint: it is checked again when they send it.
  let suggestion = await freeSlugFrom(slug).catch(() => '');
  if (suggestion === slug) suggestion = await freeSlugFrom(`${slug}-2`).catch(() => '');
  return {
    status: 409,
    code: 'SLUG_TAKEN',
    message: `${host} is already taken. Choose another web address${suggestion ? `, such as ${suggestion}` : ''}.`,
    suggestion: suggestion || ''
  };
}

/**
 * The marketing site, for Stripe to send the buyer back to. The origin the
 * request came from when it is one PLATFORM_ADMIN_ORIGIN names (the www and
 * the bare domain can both be listed), otherwise the first listed. Never an
 * origin nobody configured.
 */
function marketingOrigin(req) {
  const listed = String(process.env.PLATFORM_ADMIN_ORIGIN || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const origin = String((req && req.headers && req.headers.origin) || '').trim().replace(/\/+$/, '');
  const match = origin && listed.find((o) => o.toLowerCase() === origin.toLowerCase());
  return match || listed[0] || 'http://localhost:3001';
}

function statusView(doc) {
  const s = doc.signup || {};
  const state = s.state || 'awaiting_payment';
  const data = { status: state, message: STATUS_MESSAGES[state] || STATUS_MESSAGES.awaiting_payment };
  if (state === 'failed' && s.gaveUpAt) data.message = GAVE_UP;
  if (state === 'ready') {
    if (!s.inviteSent) data.message = READY_NO_EMAIL;
    data.siteUrl = s.siteUrl || null;
    data.trialEndsAt = s.trialEndsAt || null;
  }
  return data;
}

module.exports = {
  selfServeAvailable,
  // exported for tests
  platformEmailConfigured,
  validateSignup,
  webAddressFor,
  webAddressProblem,
  marketingOrigin,
  statusView,

  // POST /api/platform/public/signup
  //
  // Answers 201 { url } -- the Stripe page to send the buyer to -- or 409
  // with a `code` the site acts on: SELF_SERVE_UNAVAILABLE (send a request
  // instead), SLUG_TAKEN (with a `suggestion`), SIGNUP_IN_PROGRESS.
  start: async (req, res) => {
    try {
      const availability = await selfServeAvailable();
      if (!availability.available) return res.status(409).json(UNAVAILABLE);

      const result = validateSignup(req.body);
      // A bot is told thanks, sent nowhere, and nothing is stored.
      if (result.spam) return res.status(201).json({ success: true, message: 'Thanks.' });
      if (result.errors.length) return res.status(400).json({ success: false, message: result.errors[0], errors: result.errors });
      const data = result.data;

      const plan = await PlatformPlan.findOne({ slug: data.planSlug, isActive: true });
      if (!plan) return res.status(400).json({ success: false, message: 'That plan is no longer on sale. Pick another one.' });
      // Yearly only where the plan has a yearly price, as checkout shows it.
      if (data.billingCycle === 'yearly' && !(Number(plan.price && plan.price.yearly) > 0)) data.billingCycle = 'monthly';

      // Priced here, not taken from the form: the record says what Stripe
      // is about to charge.
      const priced = await priceSelection(data);
      if (!priced) return res.status(400).json({ success: false, message: 'That plan is no longer on sale. Pick another one.' });
      // Nothing to pay means nothing to take a card for: the panel sets
      // those up, as before.
      if (!(priced.plan.amount > 0)) return res.status(409).json(UNAVAILABLE);
      let addons;
      try {
        addons = await resolveAddons(priced.plan.addonSlugs, plan);
      } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
      }

      // Their own signup that is still open. One being set up (or paid for
      // but not yet set up) means they have paid: never take a second card.
      // One still waiting for payment is picked up again rather than
      // duplicated.
      // One given up on had its subscription cancelled: they may start again.
      const pending = await DemoRequest.findOne(
        {
          kind: 'signup',
          email: data.email,
          gymId: null,
          'signup.gaveUpAt': null,
          $or: [
            { 'signup.state': { $in: ['awaiting_payment', 'provisioning'] } },
            { 'signup.state': 'failed', updatedAt: { $gte: new Date(Date.now() - FAILED_BLOCK_MS) } }
          ]
        },
        null,
        { sort: { createdAt: -1 } }
      );
      const inProgress = {
        success: false,
        code: 'SIGNUP_IN_PROGRESS',
        message: 'A gym is already being set up for this email address. Check your inbox (and spam folder); there is no need to pay again.'
      };
      if (pending && pending.signup && pending.signup.state !== 'awaiting_payment') return res.status(409).json(inProgress);

      const slug = webAddressFor(data.preferredSlug, data.gymName);
      const problem = await webAddressProblem(slug, data.email);
      if (problem) {
        const { status, ...body } = problem;
        return res.status(status).json({ success: false, ...body });
      }

      // The page they opened last time is closed before anything on the
      // record changes: if it was paid meanwhile, the gym is built from what
      // they paid for, not from what they have just typed.
      if (pending && pending.signup && pending.signup.stripeSessionId) {
        const previous = await platformBilling.closeSignupCheckoutSession(pending.signup.stripeSessionId);
        if (previous === 'complete') return res.status(409).json(inProgress);
        if (previous === 'open') {
          return res.status(502).json({ success: false, message: 'We could not open a new payment page just now. Nothing was charged; please try again.' });
        }
      }

      const fields = {
        kind: 'signup',
        name: data.name,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        gymName: data.gymName,
        gymSize: data.gymSize,
        country: data.country,
        message: data.message,
        source: data.source,
        preferredSlug: slug,
        plan: priced.plan,
        warnings: priced.warnings
      };
      let doc;
      if (pending) {
        pending.set(fields);
        pending.set({ 'signup.state': 'awaiting_payment', 'signup.timezone': data.timezone, 'signup.stripeSessionId': '', 'signup.error': '' });
        doc = await pending.save();
      } else {
        doc = await DemoRequest.create({
          ...fields,
          signup: { state: 'awaiting_payment', timezone: data.timezone },
          ip: clientIp(req),
          userAgent: text(req.headers['user-agent'], 500)
        });
      }

      const origin = marketingOrigin(req);
      let session;
      try {
        session = await platformBilling.createSignupCheckoutSession({
          signupId: doc._id,
          email: data.email,
          plan,
          addons,
          billingCycle: priced.plan.billingCycle,
          successUrl: `${origin}/checkout/success?signup=${doc._id}`,
          cancelUrl: `${origin}/checkout?plan=${encodeURIComponent(plan.slug)}&cycle=${priced.plan.billingCycle}&cancelled=1`
        });
      } catch (error) {
        if (error instanceof PlatformStripeNotConfiguredError) return res.status(409).json(UNAVAILABLE);
        if (error instanceof PlatformBillingError) {
          return res.status(error.code === 'FREE_PLAN' ? 409 : error.status).json(error.code === 'FREE_PLAN' ? UNAVAILABLE : { success: false, code: error.code, message: error.message });
        }
        console.error('[platform] signup checkout failed:', error.message);
        return res.status(502).json({ success: false, message: 'We could not open the payment page just now. Nothing was charged; please try again.' });
      }

      // Saved after Stripe answered: only a signup that reached the payment
      // page holds its web address from others.
      await DemoRequest.updateOne({ _id: doc._id }, { $set: { 'signup.stripeSessionId': session.id } });
      return res.status(201).json({ success: true, id: String(doc._id), url: session.url });
    } catch (error) {
      console.error('[platform] signup failed:', error);
      return res.status(500).json({ success: false, message: 'Could not start your sign-up right now. Nothing was charged; please try again.' });
    }
  },

  // GET /api/platform/public/signup/:id/status
  //
  // What the success page shows while the gym is made. The id is only in
  // the buyer's own return link; even so, nothing personal comes back --
  // the state, a sentence, and once it exists the gym's public address.
  //
  // A signup stuck being set up (its webhook delivery died) or failed is
  // set going again from here, after the answer, so a buyer still watching
  // does not wait for the daily job. recoverSignup claims the retry itself:
  // polling cannot run it more than once every RETRY_EVERY_MS.
  status: async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const notFound = { success: false, message: 'We could not find that sign-up.' };
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json(notFound);
      const doc = await DemoRequest.findById(id).select('kind gymId signup').lean();
      if (!doc || doc.kind !== 'signup' || !doc.signup) return res.status(404).json(notFound);
      if (signupProvisioning.recoveryDue(doc)) afterResponse(() => signupProvisioning.recoverSignup(doc._id), 'signup recovery');
      return res.json({ success: true, data: statusView(doc) });
    } catch (error) {
      console.error('[platform] signup status failed:', error);
      return res.status(500).json({ success: false, message: 'Could not check on your sign-up right now.' });
    }
  }
};
