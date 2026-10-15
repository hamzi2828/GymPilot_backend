// src/platform/services/signupProvisioning.js
//
// Turning a paid signup from the marketing site into a gym. Called by the
// platform webhook (services/platformWebhook.js) for a
// checkout.session.completed whose metadata says kind 'signup': the buyer
// filled in checkout (controllers/signupController.js), paid on Stripe, and
// nobody in the panel is involved. The gym is made by the same provisionGym
// the panel's "New gym" uses -- which rolls itself back when a step fails --
// the Stripe subscription goes on it, and the owner gets the usual email with
// a link to set their password.
//
// Stripe delivers at least once and retries whatever fails, so everything
// here is safe to run twice:
//   * a gym is looked for before one is made: the one the signup already
//     points at, or the one carrying this payment's Stripe subscription
//     (provisionGym writes it in the same insert as the gym, so it is found
//     even when the process died before the signup was updated);
//   * the signup is claimed in one atomic write before provisioning, so two
//     deliveries racing cannot both build a gym;
//   * a failure is written on the signup for the panel and then thrown, so
//     the webhook answers 500 and Stripe tries again later.
//
// And when Stripe does not come back -- the delivery that was building the
// gym was killed, and the retry that followed was told "duplicate" -- the
// daily job and the success page do (recoverSignup): a signup stuck for
// longer than STUCK_MS is set up again from what Stripe says it paid for.
// One that still cannot be after GIVE_UP_AFTER_MS is given up on: its Stripe
// subscription cancelled, the buyer and the admins told.

const crypto = require('crypto');
const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const DemoRequest = require('../models/demoRequestModel');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const provisioning = require('../provisioning');
const { siteUrlFor, inviteSiteUrlFor, runWithTenant } = require('../tenantContext');
const { applyCheckoutToGym, retrieveCheckoutSubscription, checkoutStatus, periodEndOf, idOf } = require('./platformWebhook');
// Called through the modules, not destructured, so a test can stand in for them.
const platformBilling = require('./platformBilling');
const emailService = require('../../services/emailService');
const { getPlatformStripe } = require('./platformStripe');
const { emailAdmins, panelLink } = require('../controllers/demoRequestsController');
// The same window after which the webhook lets a retry take over an event
// nobody finished: a signup claim that old belongs to a delivery that died.
const { STALE_CLAIM_MS } = require('../controllers/platformSettingsController');
const { afterResponse } = require('../../services/afterResponse');
const { shell, paragraph, detailTable, callout, dateLabel, escapeHtml } = require('../../templates/gymEmails');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';

// A signup whose last attempt began this long ago and is still being set up
// (its delivery died), or failed, is stuck. Longer than STALE_CLAIM_MS, so
// provision()'s claim lets the retry in.
const STUCK_MS = 15 * 60 * 1000;
// However often it is asked -- the success page polls every few seconds --
// a stuck signup is retried at most this often.
const RETRY_EVERY_MS = 15 * 60 * 1000;
// Retries after which the admins are told it is still stuck. Once.
const ALERT_AFTER_ATTEMPTS = 3;
// How long retries go on before the signup is given up on: Stripe's own
// window for retrying the webhook, and how long the buyer is kept from
// paying again (signupController FAILED_BLOCK_MS).
const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// A subscription in one of these has been paid for, or has a card on file
// for when its trial ends. Anything else is not a gym yet.
const PAID = new Set(['trialing', 'active']);

// What the free-text "City / country" says about the gym's own money and
// clock -- what it charges its members in, not what it pays us in. The same
// table the panel's New gym form fills itself in from
// (GymPilot_marketing super-admin/gyms/new); keep the two in step.
const PLACE_LOCALES = [
  { match: /\b(pakistan|karachi|lahore|islamabad|rawalpindi|faisalabad|multan|peshawar)\b/i, country: 'PK', currency: 'PKR', timezone: 'Asia/Karachi' },
  { match: /\b(uk|united kingdom|great britain|britain|england|scotland|wales|london|manchester|birmingham|leeds|glasgow|edinburgh)\b/i, country: 'GB', currency: 'GBP', timezone: 'Europe/London' },
  { match: /\b(uae|united arab emirates|dubai|abu dhabi|sharjah)\b/i, country: 'AE', currency: 'AED', timezone: 'Asia/Dubai' },
  { match: /\b(saudi arabia|saudi|ksa|riyadh|jeddah|dammam)\b/i, country: 'SA', currency: 'SAR', timezone: 'Asia/Riyadh' },
  { match: /\b(qatar|doha)\b/i, country: 'QA', currency: 'QAR', timezone: 'Asia/Qatar' },
  { match: /\b(india|mumbai|delhi|bangalore|bengaluru)\b/i, country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' },
  { match: /\b(bangladesh|dhaka)\b/i, country: 'BD', currency: 'BDT', timezone: 'Asia/Dhaka' },
  { match: /\b(ireland|dublin)\b/i, country: 'IE', currency: 'EUR', timezone: 'Europe/Dublin' },
  { match: /\b(germany|berlin|munich)\b/i, country: 'DE', currency: 'EUR', timezone: 'Europe/Berlin' },
  { match: /\b(france|paris)\b/i, country: 'FR', currency: 'EUR', timezone: 'Europe/Paris' },
  { match: /\b(spain|madrid|barcelona)\b/i, country: 'ES', currency: 'EUR', timezone: 'Europe/Madrid' },
  { match: /\b(turkey|istanbul|ankara)\b/i, country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' },
  { match: /\b(nigeria|lagos|abuja)\b/i, country: 'NG', currency: 'NGN', timezone: 'Africa/Lagos' },
  { match: /\b(kenya|nairobi)\b/i, country: 'KE', currency: 'KES', timezone: 'Africa/Nairobi' },
  { match: /\b(south africa|johannesburg|cape town|durban)\b/i, country: 'ZA', currency: 'ZAR', timezone: 'Africa/Johannesburg' },
  { match: /\b(singapore)\b/i, country: 'SG', currency: 'SGD', timezone: 'Asia/Singapore' },
  { match: /\b(philippines|manila)\b/i, country: 'PH', currency: 'PHP', timezone: 'Asia/Manila' },
  { match: /\b(australia)\b/i, country: 'AU', currency: 'AUD', timezone: 'Australia/Sydney' },
  { match: /\b(canada)\b/i, country: 'CA', currency: 'CAD', timezone: 'America/Toronto' },
  { match: /\b(usa|united states|america)\b/i, country: 'US', currency: 'USD', timezone: 'America/New_York' }
];

function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The gym's locale from what the buyer typed as their place and the clock
 * their browser was on. The place decides the country and currency; the
 * browser's timezone is used when it is on the same continent as the place
 * (Chicago rather than the table's New York), or when the place said nothing.
 */
function localeFor(place, browserTimezone) {
  const tz = validTimezone(browserTimezone) ? browserTimezone : '';
  const byPlace = PLACE_LOCALES.find((l) => l.match.test(place || ''));
  if (byPlace) {
    const sameRegion = tz && tz.split('/')[0] === byPlace.timezone.split('/')[0];
    return { country: byPlace.country, currency: byPlace.currency, timezone: sameRegion ? tz : byPlace.timezone };
  }
  const byClock = tz && PLACE_LOCALES.find((l) => l.timezone === tz);
  if (byClock) return { country: byClock.country, currency: byClock.currency, timezone: tz };
  return { country: '', currency: 'USD', timezone: tz || 'UTC' };
}

/**
 * What to do with a paid checkout for `signup`, given the gym already found
 * for it (or null). Pure, so the rules can be tested without Stripe or a
 * database.
 *
 *   link       a finished gym exists for this signup or this payment: attach the payment to it
 *   conflict   the signup's gym is on another Stripe subscription: this is a second payment
 *   gone       the signup became a gym that has since been deleted
 *   half       a gym for this payment exists but never finished being made
 *   wait       another delivery is building the gym right now
 *   unpaid     Stripe does not say trialing or active
 *   provision  make the gym
 */
function signupDecision(signup, { gym = null, subscriptionId = '', status, now = Date.now(), staleMs = STALE_CLAIM_MS } = {}) {
  const s = (signup && signup.signup) || {};
  const claimedAt = s.claimedAt ? new Date(s.claimedAt).getTime() : 0;
  const inFlight = s.state === 'provisioning' && claimedAt > now - staleMs;

  if (gym) {
    // provisionGym stamps provisionedAt last; without it the gym is either
    // still being made or was left behind by a delivery that died.
    if (!gym.provisionedAt) return inFlight ? 'wait' : 'half';
    const current = (gym.subscription && gym.subscription.stripeSubscriptionId) || '';
    return !current || current === subscriptionId ? 'link' : 'conflict';
  }
  if (signup && signup.gymId) return 'gone';
  if (inFlight) return 'wait';
  if (!subscriptionId || !PAID.has(status)) return 'unpaid';
  return 'provision';
}

/** The gym this signup became, else the one already carrying this payment. */
async function gymFor(signup, subscriptionId) {
  if (signup.gymId) return Gym.findById(signup.gymId).lean();
  if (!subscriptionId) return null;
  return Gym.findOne({ 'subscription.stripeSubscriptionId': subscriptionId }).lean();
}

function trialEndOf(subscription) {
  if (!subscription || subscription.status !== 'trialing') return null;
  const end = Number(subscription.trial_end);
  return end > 0 ? new Date(end * 1000) : periodEndOf(subscription);
}

/** What provisionGym is given: the signup's answers, the plan it paid for, what Stripe says. */
function provisionInput(signup, plan, { status, subscription, billingCycle }) {
  const [first, ...rest] = String(signup.name || '').trim().split(/\s+/);
  const created = signup.createdAt ? new Date(signup.createdAt) : new Date();
  return {
    name: signup.gymName,
    // A preference, checked free when they chose it; if somebody has taken it
    // since, a number goes on the end rather than the gym not being made.
    preferredSlug: signup.preferredSlug || signup.gymName,
    owner: {
      firstName: signup.firstName || first || '',
      lastName: signup.firstName ? signup.lastName || '' : rest.join(' '),
      email: signup.email,
      phone: signup.phone || '',
      // Never shown to anyone: provisionGym wants one, and the owner sets
      // their own from the invite email.
      password: crypto.randomBytes(24).toString('base64url')
    },
    planId: plan._id,
    subscription: {
      status,
      billingCycle,
      addonSlugs: (signup.plan && signup.plan.addonSlugs) || [],
      currentPeriodEnd: periodEndOf(subscription) || undefined
    },
    locale: localeFor(signup.country, signup.signup && signup.signup.timezone),
    notes: [
      `Signed up and paid on the website on ${created.toISOString().slice(0, 10)}.`,
      signup.country ? `Where: ${signup.country}` : '',
      signup.gymSize ? `Size: ${signup.gymSize}` : '',
      signup.message ? `They said: ${signup.message}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  };
}

/**
 * Emails the admins without holding up the webhook's answer -- and, on
 * Vercel, without the email being cut off once it has gone. Resolves when
 * sent (never rejects), for a caller that does want to wait.
 */
function tell(subject, heading, parts) {
  return afterResponse(() => emailAdmins(subject, heading, parts.filter(Boolean).join('')), 'signup email to admins');
}

/** Marks the signup done and linked to its gym. */
async function markReady(signup, gym, { subscription, subscriptionId, customerId, inviteSent }) {
  const set = {
    gymId: gym._id,
    status: 'converted',
    convertedAt: signup.convertedAt || new Date(),
    'signup.state': 'ready',
    'signup.error': '',
    'signup.siteUrl': siteUrlFor(gym),
    'signup.trialEndsAt': trialEndOf(subscription),
    'signup.stripeCustomerId': customerId,
    'signup.stripeSubscriptionId': subscriptionId
  };
  if (inviteSent !== undefined) set['signup.inviteSent'] = inviteSent;
  await DemoRequest.updateOne({ _id: signup._id }, { $set: set });
}

/**
 * Records why the gym could not be made and throws, so Stripe tries again.
 * `notify` is the caller's call: admins hear about it when it first goes
 * wrong, not on each of Stripe's retries.
 */
async function fail(signup, reason, { notify = false } = {}) {
  await DemoRequest.updateOne({ _id: signup._id }, { $set: { 'signup.state': 'failed', 'signup.error': String(reason).slice(0, 2000) } }).catch(() => null);
  if (notify) {
    tell(`Paid signup needs attention: ${signup.gymName || signup.email}`, 'A signup could not be set up', [
      paragraph(`${escapeHtml(signup.name || signup.email)} paid for ${escapeHtml(signup.gymName || 'a gym')} on the website, but the gym could not be set up.`),
      detailTable([
        ['Why', String(reason)],
        ['Email', signup.email],
        ['Plan', signup.plan && signup.plan.name ? `${signup.plan.name} (${signup.plan.billingCycle})` : '']
      ]),
      paragraph(
        'Stripe retries the payment\'s webhook for up to three days, and the daily job retries the signup too; each retry tries again. Fix what the reason says, or set the gym up by hand from the request: the next retry then attaches the payment to it. ' +
          'A signup still not set up after three days of retries is given up on: its Stripe subscription is cancelled and the buyer told.'
      ),
      panelLink()
    ]);
  }
  throw new Error(reason);
}

/**
 * Clears away a gym a delivery that died left half made, so the signup can
 * be set up afresh. Only one this very payment made -- it carries the
 * payment's Stripe subscription, which provisionGym writes in the gym's
 * first insert, and the buyer as its owner -- that never finished (no
 * provisionedAt), has sat untouched longer than any delivery runs, and
 * lives on the shared cluster in the database provisioning named for it
 * alone: nothing but its own half-finished seed was ever in there, so the
 * database goes too. Resolves true when it was removed.
 */
async function removeHalfMadeGym(signup, gym, subscriptionId, now = Date.now()) {
  const sub = gym.subscription || {};
  const made = gym.createdAt ? new Date(gym.createdAt).getTime() : now;
  const ours =
    !!subscriptionId &&
    sub.stripeSubscriptionId === subscriptionId &&
    !signup.gymId &&
    String((gym.owner && gym.owner.email) || '') === String(signup.email || '').toLowerCase();
  if (!ours || gym.provisionedAt || now - made < STALE_CLAIM_MS) return false;

  const withUri = await Gym.findByIdWithUri(gym._id);
  if (!withUri || withUri.provisionedAt || (withUri.database && withUri.database.uri)) return false;
  // The subscription stays: it is the payment the gym is about to be made
  // again from.
  await provisioning.deleteGym(withUri, { confirmSlug: withUri.slug, dropDatabase: true, keepSubscription: true });
  PlatformAuditLog.record({
    actorId: null,
    actorEmail: 'signup',
    action: 'gym_deleted',
    gymId: gym._id,
    gymSlug: gym.slug,
    meta: { slug: gym.slug, databaseDropped: true, reason: 'left half made by a signup delivery that died; set up again', signupId: String(signup._id) }
  });
  return true;
}

/**
 * Sends the owner of a gym a fresh set-password email, from inside the gym.
 * For a gym a delivery made and then died before recording whether that
 * email went: the link in this one replaces any earlier. Resolves whether it
 * was sent; never throws.
 */
async function resendOwnerInvite(gym) {
  try {
    const target = (await Gym.findByIdWithUri(gym._id)) || gym;
    const { sendOwnerInvite } = require('../ownerInvite');
    const invite = await runWithTenant(target, () =>
      sendOwnerInvite({ gym: target, email: target.owner && target.owner.email, siteUrl: inviteSiteUrlFor(target) })
    );
    return !!(invite && invite.sent);
  } catch (error) {
    console.error(`[platform] set-password email for ${gym.slug} could not be sent again:`, error.message);
    return false;
  }
}

/** A payment for a signup whose gym is already on another subscription. */
async function secondPayment(signup, gym, subscriptionId) {
  const note = `A second payment (Stripe subscription ${subscriptionId}) completed after this signup's gym was set up. It is not on any gym: cancel and refund it in Stripe.`;
  const pushed = await DemoRequest.updateOne({ _id: signup._id, warnings: { $ne: note } }, { $push: { warnings: note } });
  if (pushed && pushed.modifiedCount) {
    tell(`Second payment for ${signup.gymName || signup.email}`, 'A signup paid twice', [paragraph(escapeHtml(note)), panelLink()]);
  }
  return { gym, result: `signup ${signup._id}: second payment ${subscriptionId} not linked to ${gym.slug}` };
}

async function provision(signup, session, subscription, eventAt, { subscriptionId, customerId, status }) {
  const now = new Date();
  // Claimed in the write, so of two deliveries only one goes on to build.
  const claimed = await DemoRequest.findOneAndUpdate(
    {
      _id: signup._id,
      gymId: null,
      $or: [
        { 'signup.state': { $in: ['awaiting_payment', 'failed'] } },
        { 'signup.state': 'provisioning', 'signup.claimedAt': null },
        { 'signup.state': 'provisioning', 'signup.claimedAt': { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } }
      ]
    },
    {
      $set: {
        'signup.state': 'provisioning',
        'signup.claimedAt': now,
        'signup.error': '',
        'signup.stripeCustomerId': customerId,
        'signup.stripeSubscriptionId': subscriptionId,
        // The page that was paid on, which is what a retry reads back from
        // Stripe (recoverSignup).
        ...(session.id ? { 'signup.stripeSessionId': session.id } : {})
      },
      $inc: { 'signup.attempts': 1 }
    },
    { new: true }
  ).lean();
  if (!claimed) throw new Error(`Signup ${signup._id} is being set up by another delivery; try again later`);

  const metadata = session.metadata || {};
  const billingCycle = metadata.billingCycle === 'yearly' ? 'yearly' : metadata.billingCycle === 'monthly' ? 'monthly' : (claimed.plan && claimed.plan.billingCycle) || 'monthly';
  let made;
  try {
    const planSlug = (claimed.plan && claimed.plan.slug) || metadata.planSlug;
    // Sold or not any more: this is what they paid for.
    const plan = planSlug ? await PlatformPlan.findOne({ slug: planSlug }).lean() : null;
    if (!plan) throw new Error(`the plan "${planSlug || ''}" this signup paid for no longer exists`);
    made = await provisioning.provisionGym(provisionInput(claimed, plan, { status, subscription, billingCycle }), {
      enforceDatabasePolicy: true,
      requireSite: true,
      stripe: { customerId, subscriptionId }
    });
  } catch (error) {
    // provisionGym has already removed whatever it had made.
    return fail(claimed, `Could not set the gym up: ${error.message}`, { notify: (claimed.signup.attempts || 0) <= 1 });
  }

  const gym = made.gym.toObject ? made.gym.toObject() : made.gym;
  const inviteSent = !!(made.ownerInvite && made.ownerInvite.sent);
  // The signup first: from here on a retry finds the gym and only links it.
  await markReady(claimed, gym, { subscription, subscriptionId, customerId, inviteSent });
  if (made.warnings && made.warnings.length) {
    await DemoRequest.updateOne({ _id: claimed._id }, { $push: { warnings: { $each: made.warnings } } }).catch(() => null);
  }
  // Then what Stripe charges, in the same words a gym's own checkout gets.
  await applyCheckoutToGym(gym, session, subscription, eventAt);

  PlatformAuditLog.record({
    actorId: null,
    actorEmail: 'signup',
    action: 'gym_created',
    gymId: gym._id,
    gymSlug: gym.slug,
    meta: { slug: gym.slug, domains: (gym.domains || []).map((d) => d.host), ownerInviteSent: inviteSent, signupId: String(claimed._id), stripeSubscriptionId: subscriptionId }
  });

  const plan = claimed.plan || {};
  tell(`New gym signed up and paid: ${gym.name}`, 'A gym signed up on its own', [
    paragraph(`${escapeHtml(claimed.name || claimed.email)} signed up and paid on the website. The gym has been set up; nothing needs doing.`),
    detailTable([
      ['Gym', gym.name],
      ['Website', siteUrlFor(gym)],
      ['Owner', `${claimed.name || ''} <${claimed.email}>`],
      ['Plan', plan.name ? `${plan.name} (${billingCycle})` : ''],
      ['Price', plan.currency ? `${plan.currency} ${Number(plan.amount || 0).toLocaleString('en-US')} / ${billingCycle === 'yearly' ? 'year' : 'month'}` : ''],
      ['Stripe', status === 'trialing' ? 'on trial, card on file' : status],
      ['Set-password email', inviteSent ? 'sent' : 'NOT sent -- resend it from the gym page']
    ]),
    made.warnings && made.warnings.length ? paragraph(`Still to do: ${escapeHtml(made.warnings.join(' '))}`) : ''
  ]);

  return { gym, result: `signup: gym created (${status})` };
}

/**
 * Handles a completed signup checkout. Resolves { gym, result } like the
 * webhook's other handlers; throws when Stripe should deliver it again.
 */
async function completeSignupCheckout(session, stripe, eventAt) {
  const metadata = session.metadata || {};
  const signupId = String(metadata.signupId || session.client_reference_id || '');
  if (!mongoose.Types.ObjectId.isValid(signupId)) return { gym: null, result: 'signup checkout without a signup id' };

  const signup = await DemoRequest.findById(signupId).lean();
  if (!signup) {
    // Deleted from the panel after they paid. The audit log line is what
    // tells somebody to look.
    console.error(`[platform] paid signup ${signupId} no longer exists; no gym was made`);
    return { gym: null, result: `paid signup ${signupId} no longer exists, so no gym was made: set it up by hand` };
  }
  // Given up on (giveUp): its subscription is cancelled and the buyer has
  // been told, so a late delivery changes nothing.
  if (signup.signup && signup.signup.gaveUpAt) return { gym: null, result: `signup ${signupId} was given up on; nothing done` };

  const subscription = await retrieveCheckoutSubscription(session, stripe);
  const subscriptionId = idOf(session.subscription);
  const customerId = idOf(session.customer);
  const status = checkoutStatus(session, subscription);
  const gym = await gymFor(signup, subscriptionId);

  switch (signupDecision(signup, { gym, subscriptionId, status })) {
    case 'link': {
      // The gym first, then the signup: a retry after a failure in between
      // still finds the gym and comes back here.
      const outcome = await applyCheckoutToGym(gym, session, subscription, eventAt);
      // A signup already marked ready keeps what it recorded. One the panel
      // set up by hand had its owner invited then. One an earlier delivery
      // made, then died before recording it, may have died before the
      // owner's email went: they get a fresh one.
      const alreadyReady = signup.signup && signup.signup.state === 'ready';
      const inviteSent = alreadyReady ? undefined : signup.gymId ? true : await resendOwnerInvite(gym);
      await markReady(signup, gym, { subscription, subscriptionId, customerId, inviteSent });
      return { gym, result: `signup linked to ${gym.slug}: ${outcome.result}` };
    }
    case 'conflict':
      return secondPayment(signup, gym, subscriptionId);
    case 'gone': {
      const note = `Paid (Stripe subscription ${subscriptionId}), but the gym this signup was set up as has been deleted. The subscription is on no gym: cancel it in Stripe, or set the gym up again by hand.`;
      await DemoRequest.updateOne({ _id: signup._id }, { $set: { 'signup.error': note } }).catch(() => null);
      tell(`Payment for a deleted gym: ${signup.gymName || signup.email}`, 'A signup paid for a deleted gym', [paragraph(escapeHtml(note)), panelLink()]);
      return { gym: null, result: `signup ${signupId}'s gym was deleted; subscription ${subscriptionId} is on no gym` };
    }
    case 'wait':
      throw new Error(`Signup ${signupId} is being set up by another delivery; try again later`);
    case 'half': {
      // Left by a delivery that died: cleared away, and the gym made afresh.
      const removed = await removeHalfMadeGym(signup, gym, subscriptionId).catch((error) => {
        console.error(`[platform] half-made gym ${gym.slug} could not be removed:`, error.message);
        return false;
      });
      if (removed) return provision(signup, session, subscription, eventAt, { subscriptionId, customerId, status });
      return fail(signup, `A half-made gym (${gym.slug}) exists for this payment. Delete it under Gyms; Stripe's next retry sets the gym up again.`, {
        notify: !signup.signup || signup.signup.state !== 'failed'
      });
    }
    case 'unpaid':
      // Not a failure of ours: the payment is not through yet. The signup
      // keeps waiting, and a retry reads the subscription afresh.
      await DemoRequest.updateOne({ _id: signup._id }, { $set: { 'signup.error': `Stripe says the subscription is ${subscription ? subscription.status : 'missing'}; waiting for the payment.` } }).catch(() => null);
      throw new Error(`Signup ${signupId}: subscription ${subscription ? subscription.status : 'missing'}, not paid yet`);
    default:
      return provision(signup, session, subscription, eventAt, { subscriptionId, customerId, status });
  }
}

/* --------------------------------- recovery -------------------------------- */

/** The signups that are stuck and due another try, as a query. */
function recoveryFilter(now = Date.now()) {
  return {
    kind: 'signup',
    gymId: null,
    'signup.state': { $in: ['provisioning', 'failed'] },
    'signup.gaveUpAt': null,
    $and: [
      { $or: [{ 'signup.claimedAt': null }, { 'signup.claimedAt': { $lt: new Date(now - STUCK_MS) } }] },
      { $or: [{ 'signup.recoveryAt': null }, { 'signup.recoveryAt': { $lt: new Date(now - RETRY_EVERY_MS) } }] }
    ]
  };
}

/** The same question for one signup already read (the success page's). */
function recoveryDue(doc, now = Date.now()) {
  const s = (doc && doc.signup) || {};
  if (!doc || doc.kind !== 'signup' || doc.gymId || s.gaveUpAt) return false;
  if (s.state !== 'provisioning' && s.state !== 'failed') return false;
  const at = (date) => (date ? new Date(date).getTime() : 0);
  return at(s.claimedAt) < now - STUCK_MS && at(s.recoveryAt) < now - RETRY_EVERY_MS;
}

function planLine(signup) {
  return signup.plan && signup.plan.name ? `${signup.plan.name} (${signup.plan.billingCycle})` : '';
}

/** Tells the admins, once, that retrying has not set a signup up. */
async function alertStillStuck(signup, reason, now) {
  const marked = await DemoRequest.updateOne({ _id: signup._id, 'signup.alertedAt': null }, { $set: { 'signup.alertedAt': now } });
  if (!marked || !marked.modifiedCount) return false;
  const startedAt = new Date((signup.signup && signup.signup.recoveryStartedAt) || now);
  await tell(`Paid signup still not set up: ${signup.gymName || signup.email}`, 'A signup is still stuck', [
    paragraph(`${escapeHtml(signup.name || signup.email)} paid for ${escapeHtml(signup.gymName || 'a gym')} on the website. It has been retried ${signup.signup.recoveryAttempts || 0} times and is still not set up.`),
    detailTable([
      ['Why', reason],
      ['Email', signup.email],
      ['Plan', planLine(signup)],
      ['Stripe subscription', (signup.signup && signup.signup.stripeSubscriptionId) || '']
    ]),
    paragraph(
      `Retries go on every day. If it is still not set up by ${escapeHtml(dateLabel(new Date(startedAt.getTime() + GIVE_UP_AFTER_MS)))}, it is given up on: its Stripe subscription is cancelled, so nothing more is charged, and the buyer is told.`
    ),
    panelLink()
  ]);
  return true;
}

/**
 * Gives up on a signup that could not be set up however often it was
 * tried: its Stripe subscription is cancelled at once -- nothing more is
 * charged, and on a trial nothing ever was -- the signup is marked, and the
 * buyer and the admins are told. Resolves false, having changed nothing,
 * when Stripe would not cancel: the next run tries again.
 */
async function giveUp(signup, reason, { stripe = null, subscriptionId = '', now = new Date() } = {}) {
  let cancelled = null;
  if (subscriptionId) {
    try {
      cancelled = await platformBilling.cancelSubscriptionNow(subscriptionId, stripe);
    } catch (error) {
      console.error(`[platform] could not cancel ${subscriptionId} for signup ${signup._id}:`, error.message);
      return false;
    }
  }
  const charged = cancelled && cancelled.amountPaid > 0 ? `${cancelled.currency} ${cancelled.amountPaid.toLocaleString('en-US')}` : '';
  const note = [
    `Given up on after ${(signup.signup && signup.signup.recoveryAttempts) || 0} automatic retries: ${reason}.`,
    subscriptionId ? `Stripe subscription ${subscriptionId} was cancelled, so nothing more is charged.` : 'No Stripe subscription was on record.',
    charged ? `It had taken ${charged}: refund it in Stripe.` : ''
  ]
    .filter(Boolean)
    .join(' ');
  // Marked once, whoever gets here first; only they tell anybody.
  const marked = await DemoRequest.updateOne(
    { _id: signup._id, 'signup.gaveUpAt': null },
    { $set: { 'signup.state': 'failed', 'signup.gaveUpAt': now, 'signup.alertedAt': (signup.signup && signup.signup.alertedAt) || now, 'signup.error': note.slice(0, 2000) } }
  );
  if (!marked || !marked.modifiedCount) return true;

  const first = signup.firstName || String(signup.name || '').trim().split(/\s+/)[0] || 'there';
  const gymName = signup.gymName || 'your gym';
  const contact = process.env.PLATFORM_CONTACT_EMAIL || '';
  const body = [
    paragraph(`Hi ${escapeHtml(first)}, thank you for signing up for ${escapeHtml(PLATFORM_NAME)}. Your payment went through, but we could not set up ${escapeHtml(gymName)}, and we are sorry.`),
    callout(
      charged
        ? `We have cancelled the subscription, so your card will not be charged again. The ${escapeHtml(charged)} already taken will be refunded.`
        : 'We have cancelled the subscription, so your card will not be charged. You have not paid anything.',
      'bad'
    ),
    paragraph(`Our team knows what happened and will be in touch${contact ? `, or you can write to ${escapeHtml(contact)}` : ''}. You are also welcome to sign up again on our website.`)
  ].join('');
  const buyer = await emailService.sendEmail(signup.email, `We could not set up ${gymName} on ${PLATFORM_NAME}`, shell(PLATFORM_NAME, 'Your gym could not be set up', body)).catch((error) => ({ success: false, error: error.message }));
  if (!buyer || !buyer.success) console.error(`[platform] could not tell ${signup.email} their signup was given up on:`, (buyer && buyer.error) || 'unknown error');

  await tell(`Paid signup given up on: ${signup.gymName || signup.email}`, 'A signup was given up on', [
    paragraph(`${escapeHtml(signup.name || signup.email)} paid for ${escapeHtml(signup.gymName || 'a gym')} on the website, but after days of retries it still could not be set up.`),
    detailTable([
      ['Why', reason],
      ['Email', signup.email],
      ['Plan', planLine(signup)],
      ['Stripe', subscriptionId ? `subscription ${subscriptionId} cancelled` : 'no subscription on record'],
      ['Refund', charged ? `${charged} was taken: refund it in Stripe` : 'nothing was charged'],
      ['Buyer told', buyer && buyer.success ? 'yes' : 'NO -- the email could not be sent']
    ]),
    panelLink()
  ]);
  return true;
}

/**
 * Tries a stuck signup again, as Stripe's retry of the webhook would have:
 * reads the checkout it was paid on back from Stripe and runs
 * completeSignupCheckout on it -- which links a gym already made rather than
 * making another, and clears away one left half made. Claimed in one
 * write, so the daily job and the success page never retry one signup at
 * the same time, nor more often than RETRY_EVERY_MS.
 *
 * Still not set up after ALERT_AFTER_ATTEMPTS tries: the admins are told,
 * once. Still not after GIVE_UP_AFTER_MS of trying: it is given up on.
 *
 * Never throws. Resolves { id, outcome, result?, error? }; outcome is 'not
 * due', 'ready', 'failed' or 'gave up'.
 */
async function recoverSignup(id, { now = new Date(), stripe = null } = {}) {
  const at = now.getTime();
  let claimed;
  try {
    claimed = await DemoRequest.findOneAndUpdate(
      { _id: id, ...recoveryFilter(at) },
      { $set: { 'signup.recoveryAt': now }, $inc: { 'signup.recoveryAttempts': 1 } },
      { new: true }
    ).lean();
  } catch (error) {
    return { id: String(id), outcome: 'failed', error: error.message };
  }
  if (!claimed) return { id: String(id), outcome: 'not due' };

  let client = stripe;
  let session = null;
  let result = '';
  let reason = '';
  try {
    if (!claimed.signup.recoveryStartedAt) {
      await DemoRequest.updateOne({ _id: claimed._id, 'signup.recoveryStartedAt': null }, { $set: { 'signup.recoveryStartedAt': now } });
      claimed.signup.recoveryStartedAt = now;
    }
    if (!client) client = await getPlatformStripe();
    const sessionId = claimed.signup.stripeSessionId;
    if (!sessionId) throw new Error('it has no Stripe checkout on record to read back');
    // Taken before Stripe is read: an event created after this is newer
    // news than what is about to be written (platformWebhook.staleEvent).
    const readAt = new Date();
    session = await client.checkout.sessions.retrieve(sessionId);
    if (session.status !== 'complete') throw new Error(`its Stripe checkout ${sessionId} is ${session.status}, not paid`);
    result = (await completeSignupCheckout(session, client, readAt)).result;
  } catch (error) {
    reason = error.message;
  }

  try {
    const after = (await DemoRequest.findById(claimed._id).lean()) || claimed;
    if (after.gymId || (after.signup && after.signup.state === 'ready')) return { id: String(claimed._id), outcome: 'ready', result };
    reason = reason || result || (after.signup && after.signup.error) || 'still not set up';

    const attempts = claimed.signup.recoveryAttempts || 0;
    const startedAt = new Date(claimed.signup.recoveryStartedAt).getTime();
    const signup = { ...after, signup: { ...after.signup, recoveryAttempts: attempts, recoveryStartedAt: claimed.signup.recoveryStartedAt } };
    if (attempts >= ALERT_AFTER_ATTEMPTS && at - startedAt >= GIVE_UP_AFTER_MS) {
      const subscriptionId = (after.signup && after.signup.stripeSubscriptionId) || idOf(session && session.subscription);
      if (await giveUp(signup, reason, { stripe: client, subscriptionId, now })) return { id: String(claimed._id), outcome: 'gave up', error: reason };
      reason = `${reason} (and its Stripe subscription could not be cancelled yet)`;
    }
    if (attempts >= ALERT_AFTER_ATTEMPTS) await alertStillStuck(signup, reason, now);
  } catch (error) {
    reason = `${reason}; then ${error.message}`;
  }
  return { id: String(claimed._id), outcome: 'failed', error: reason };
}

module.exports = {
  completeSignupCheckout,
  recoverSignup,
  recoveryDue,
  recoveryFilter,
  STUCK_MS,
  RETRY_EVERY_MS,
  ALERT_AFTER_ATTEMPTS,
  GIVE_UP_AFTER_MS,
  // exported for tests
  signupDecision,
  localeFor,
  provisionInput,
  PLACE_LOCALES
};
