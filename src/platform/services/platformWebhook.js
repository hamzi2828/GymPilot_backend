// src/platform/services/platformWebhook.js
//
// What the platform does with a Stripe event once its signature has been
// checked (controllers/platformSettingsController.js webhook): finds the gym
// the event is about and brings its subscription record into line with what
// Stripe now says. Every write is a $set of named fields, so a webhook never
// wipes what the panel recorded beside them. The one checkout with no gym
// behind it yet -- somebody signing up and paying on the marketing site --
// is handed to services/signupProvisioning.js, which makes the gym.
//
// Stripe's subscription object has moved `current_period_end` between API
// versions -- older ones carry it on the subscription, newer ones on each
// item -- so both are read.
//
// Stripe also delivers out of order and keeps talking about subscriptions
// the gym has moved on from. Two guards keep that from undoing newer state:
//   * an event about a subscription that is not the gym's current one is
//     ignored (only a completed checkout makes a subscription current);
//   * an event created before the last one applied to the gym is ignored
//     (subscription.stripeEventAt, checked atomically in the write).

const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const PlatformPlan = require('../models/platformPlanModel');
const { planFor } = require('../entitlements');
const { invalidateTenantCache } = require('../middleware/resolveTenant');
const { fromMinorUnits, intervalFor, subscriptionForPlanChange } = require('./platformBilling');

// Stripe's subscription statuses -> the platform's. Anything not listed
// (incomplete, say) is a state we do not record.
const STATUS_MAP = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  paused: 'past_due',
  canceled: 'cancelled',
  incomplete_expired: 'cancelled'
};

const CLEARED_NOTICES = { trial7: null, trial3: null, trial1: null, pastDue: null, expired: null, cancelled: null };

/** A Stripe reference may arrive as an id or as the expanded object. */
function idOf(ref) {
  if (!ref) return '';
  return typeof ref === 'string' ? ref : String(ref.id || '');
}

function unix(seconds) {
  const n = Number(seconds);
  return n > 0 ? new Date(n * 1000) : null;
}

/** When the subscription's current period ends, wherever this API version put it. */
function periodEndOf(subscription) {
  if (!subscription) return null;
  const onSubscription = unix(subscription.current_period_end);
  if (onSubscription) return onSubscription;
  const items = (subscription.items && subscription.items.data) || [];
  const ends = items.map((item) => unix(item.current_period_end)).filter(Boolean);
  return ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;
}

/** The subscription an invoice belongs to, wherever this API version put it. */
function subscriptionIdOfInvoice(invoice) {
  if (!invoice) return '';
  return idOf(invoice.subscription) || idOf(invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
}

function metadataOfInvoice(invoice) {
  return (
    (invoice && invoice.subscription_details && invoice.subscription_details.metadata) ||
    (invoice && invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.metadata) ||
    (invoice && invoice.metadata) ||
    {}
  );
}

/** What the subscription charges a period: total of its items, in major units. */
function amountOf(subscription) {
  const items = (subscription && subscription.items && subscription.items.data) || [];
  const first = items[0] && items[0].price;
  const currency = String((first && first.currency) || subscription.currency || '').toUpperCase();
  const minor = items.reduce((sum, item) => sum + (Number(item.price && item.price.unit_amount) || 0) * (Number(item.quantity) || 1), 0);
  const interval = (first && first.recurring && first.recurring.interval) || null;
  return { amount: fromMinorUnits(minor, currency), currency, interval };
}

/** The latest period end an invoice pays for. */
function periodEndOfInvoice(invoice) {
  const lines = (invoice && invoice.lines && invoice.lines.data) || [];
  const ends = lines.map((line) => unix(line.period && line.period.end)).filter(Boolean);
  return ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;
}

async function gymByMetadata(metadata) {
  const m = metadata || {};
  if (m.gymId && mongoose.Types.ObjectId.isValid(String(m.gymId))) {
    const gym = await Gym.findById(m.gymId).lean();
    if (gym) return gym;
  }
  if (m.gymSlug) return Gym.findOne({ slug: String(m.gymSlug).toLowerCase() }).lean();
  return null;
}

async function gymBySubscriptionId(id) {
  if (!id) return null;
  return Gym.findOne({ 'subscription.stripeSubscriptionId': id }).lean();
}

/** "Growth (GymPilot) + Member app · PKR 10,400 / month" */
async function summaryFor(gym, { amount, currency, interval, billingCycle }) {
  const plan = await planFor(gym).catch(() => null);
  const parts = [plan ? plan.name : 'Plan'];
  for (const addon of (gym.subscription && gym.subscription.addons) || []) {
    if (Number(addon.amount) > 0) parts.push(addon.name || addon.slug);
  }
  const money = `${currency || ''} ${Number(amount || 0).toLocaleString('en-US')}`.trim();
  return `${parts.join(' + ')} · ${money} / ${interval || intervalFor(billingCycle)}`;
}

/**
 * Whether an event about `subscriptionId` concerns some subscription other
 * than the one the gym is on now: an old one it replaced, or -- once its
 * subscription was deleted and cleared -- the one it had. A new one only
 * becomes current through checkout.session.completed.
 */
function notCurrentSubscription(gym, subscriptionId) {
  if (!subscriptionId) return false;
  const sub = (gym && gym.subscription) || {};
  if (sub.stripeSubscriptionId) return sub.stripeSubscriptionId !== subscriptionId;
  return sub.status === 'cancelled';
}

/** Whether an event created at `eventAt` is older than the last one applied to the gym. */
function staleEvent(gym, eventAt) {
  const last = gym && gym.subscription && gym.subscription.stripeEventAt;
  if (!eventAt || !last) return false;
  return new Date(eventAt).getTime() < new Date(last).getTime();
}

const IGNORED_OLD_EVENT = 'ignored: older than the last event applied';
const IGNORED_OTHER_SUBSCRIPTION = 'ignored: not the gym\'s current subscription';

/**
 * What a new status does to the rest of the record. A gym the grace period
 * ran out on stays expired until it is paid: Stripe still calling it past
 * due -- its retries of the card -- is not a payment. And the past-due clock
 * the roll-over expires gyms by (jobs.js rollFilters) starts when the gym
 * goes past due, keeps running while it stays there, and stops at any other
 * status.
 */
function withStatusEffects(gym, fields, eventAt) {
  const sub = (gym && gym.subscription) || {};
  if (fields.status === 'past_due' && sub.status === 'expired') return { ...fields, status: undefined };
  if (fields.status === 'past_due') return { ...fields, pastDueSince: sub.pastDueSince || eventAt || new Date() };
  if (fields.status) return { ...fields, pastDueSince: null };
  return fields;
}

/**
 * Applies named subscription fields to a gym. `newPeriodEnd` moving forward
 * resets the notices. With `eventAt`, the write only lands when no newer
 * event got there first; resolves false when it did not land for that reason.
 * `top` is set beside the subscription (the plan a checkout moved it to).
 */
async function applyToGym(gym, fields, eventAt = null, top = {}) {
  const set = {};
  for (const [key, value] of Object.entries(withStatusEffects(gym, fields, eventAt))) {
    if (value !== undefined) set[`subscription.${key}`] = value;
  }
  for (const [key, value] of Object.entries(top)) {
    if (value !== undefined) set[key] = value;
  }
  const before = gym.subscription && gym.subscription.currentPeriodEnd ? new Date(gym.subscription.currentPeriodEnd).getTime() : 0;
  const after = fields.currentPeriodEnd ? new Date(fields.currentPeriodEnd).getTime() : 0;
  if (after && after > before) {
    for (const [key, value] of Object.entries(CLEARED_NOTICES)) set[`subscription.notices.${key}`] = value;
  }
  if (!Object.keys(set).length) return true;

  const filter = { _id: gym._id };
  if (eventAt) {
    set['subscription.stripeEventAt'] = eventAt;
    // Checked in the write itself, so two deliveries racing cannot both win.
    filter.$or = [{ 'subscription.stripeEventAt': null }, { 'subscription.stripeEventAt': { $lte: eventAt } }];
  }
  const result = await Gym.updateOne(filter, { $set: set });
  if (eventAt && result && result.matchedCount === 0) return false;
  invalidateTenantCache();
  return true;
}

/** The subscription a completed checkout started, or null when it names none. Throws when Stripe cannot be read. */
async function retrieveCheckoutSubscription(session, stripe) {
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return null;
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    // Without it the gym's status and new period are unknown, and the
    // invoice.paid that would have said so is usually older than this
    // event, so it will not fill the gap. Failing makes Stripe redeliver.
    console.warn(`[platform] could not read subscription ${subscriptionId}:`, error.message);
    throw error;
  }
}

async function onCheckoutCompleted(session, stripe, eventAt) {
  if (session.mode !== 'subscription') return { gym: null, result: 'not a subscription checkout' };
  // Somebody who signed up and paid on the marketing site: there is no gym
  // yet, and this payment is what creates it. Required here, not at the top,
  // because signupProvisioning requires this file.
  if (session.metadata && session.metadata.kind === 'signup') {
    return require('./signupProvisioning').completeSignupCheckout(session, stripe, eventAt);
  }
  const gym =
    (session.client_reference_id && mongoose.Types.ObjectId.isValid(session.client_reference_id) && (await Gym.findById(session.client_reference_id).lean())) ||
    (await gymByMetadata(session.metadata));
  if (!gym) return { gym: null, result: 'no gym matched' };
  // The page the Billing tab last opened has been paid: there is nothing
  // left open to close before the next one (billingController.checkout).
  if (session.id && gym.subscription && gym.subscription.checkoutSessionId === session.id) {
    await Gym.updateOne({ _id: gym._id, 'subscription.checkoutSessionId': session.id }, { $set: { 'subscription.checkoutSessionId': '' } });
  }
  if (staleEvent(gym, eventAt)) return { gym, result: IGNORED_OLD_EVENT };

  const subscription = await retrieveCheckoutSubscription(session, stripe);
  return applyCheckoutToGym(gym, session, subscription, eventAt);
}

/**
 * What a checkout for another plan than the gym's changes beside the price:
 * the plan its limits come from, and the breakdown of its bill, worked out
 * the way the checkout priced it (platformBilling.subscriptionForPlanChange).
 * Null when the checkout was for the gym's own plan, or names none.
 */
async function planChangeFor(gym, metadata, billingCycle) {
  const slug = String((metadata && metadata.planSlug) || '').toLowerCase().trim();
  if (!slug) return null;
  const plan = await PlatformPlan.findOne({ slug }).lean();
  const current = gym.plan ? String(gym.plan._id || gym.plan) : '';
  if (!plan || String(plan._id) === current) return null;
  try {
    const next = await subscriptionForPlanChange(gym, plan, billingCycle);
    return { plan, planAmount: next.planAmount, addons: next.addons };
  } catch (error) {
    // An add-on taken off sale since the checkout: the plan is what was
    // paid for, and the add-ons stay as they were for the panel to sort.
    console.warn(`[platform] ${gym.slug} moved to ${plan.slug}, add-ons left as they were:`, error.message);
    return { plan, planAmount: Number(plan.price && plan.price[billingCycle === 'yearly' ? 'yearly' : 'monthly']) || 0 };
  }
}

/**
 * Makes a completed checkout's subscription the gym's current one: the
 * Stripe customer and subscription, the status, the period, and what it
 * charges. `subscription` is Stripe's, already retrieved (or null).
 */
async function applyCheckoutToGym(gym, session, subscription, eventAt) {
  const subscriptionId = idOf(session.subscription);
  const metadata = session.metadata || {};
  const billingCycle = metadata.billingCycle === 'yearly' || metadata.billingCycle === 'monthly' ? metadata.billingCycle : gym.subscription && gym.subscription.billingCycle;
  const fields = {
    stripeCustomerId: idOf(session.customer) || undefined,
    stripeSubscriptionId: subscriptionId || undefined,
    billingCycle,
    startedAt: new Date(),
    // Undefined (left as it is) for a status we do not record, such as a
    // subscription still `incomplete`: invoice.paid or the next update says.
    status: checkoutStatus(session, subscription)
  };
  fields.cancelledAt = fields.status === 'cancelled' ? new Date() : fields.status ? null : undefined;

  // Paid for another plan (the Billing tab's plan picker): the gym moves to it.
  const change = await planChangeFor(gym, metadata, billingCycle);
  if (change) {
    fields.planAmount = change.planAmount;
    fields.addons = change.addons;
  }
  const priced = subscription ? amountOf(subscription) : null;
  if (subscription) {
    fields.currentPeriodEnd = periodEndOf(subscription) || undefined;
    if (priced.currency) {
      fields.amount = priced.amount;
      fields.currency = priced.currency;
      const named = change ? { ...gym, plan: change.plan._id, subscription: { ...gym.subscription, addons: change.addons || (gym.subscription && gym.subscription.addons) } } : gym;
      fields.stripePriceSummary = await summaryFor(named, { ...priced, billingCycle });
    }
  }

  if (!(await applyToGym(gym, fields, eventAt, { plan: change ? change.plan._id : undefined }))) return { gym, result: IGNORED_OLD_EVENT };
  const status = fields.status ? `subscription ${fields.status}` : `subscription ${subscription ? subscription.status : 'unknown'}, status not recorded`;
  return { gym, result: change ? `${status}, plan ${change.plan.slug}` : status };
}

/**
 * The status a completed checkout leaves the gym in. The subscription's own
 * status when it is one we record -- `incomplete` (a card still being
 * authenticated, say) is not, and must not read as paid. Failing that, a paid
 * session is active; anything else leaves the status alone (undefined).
 */
function checkoutStatus(session, subscription) {
  if (subscription) return STATUS_MAP[subscription.status];
  return session && session.payment_status === 'paid' ? 'active' : undefined;
}

async function onInvoicePaid(invoice, stripe, eventAt) {
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  const gym = (await gymBySubscriptionId(subscriptionId)) || (await gymByMetadata(metadataOfInvoice(invoice)));
  if (!gym) return { gym: null, result: 'no gym matched' };
  if (notCurrentSubscription(gym, subscriptionId)) return { gym, result: IGNORED_OTHER_SUBSCRIPTION };
  if (staleEvent(gym, eventAt)) return { gym, result: IGNORED_OLD_EVENT };

  let end = periodEndOfInvoice(invoice);
  if (!end && subscriptionId) {
    try {
      end = periodEndOf(await stripe.subscriptions.retrieve(subscriptionId));
    } catch (error) {
      console.warn(`[platform] could not read subscription ${subscriptionId}:`, error.message);
    }
  }

  const current = gym.subscription && gym.subscription.currentPeriodEnd ? new Date(gym.subscription.currentPeriodEnd).getTime() : 0;
  const fields = {
    // Only ever forward: an invoice for an earlier period must not shorten what was already recorded.
    currentPeriodEnd: end && end.getTime() > current ? end : undefined,
    stripeSubscriptionId: subscriptionId && !(gym.subscription && gym.subscription.stripeSubscriptionId) ? subscriptionId : undefined,
    stripeCustomerId: idOf(invoice.customer) && !(gym.subscription && gym.subscription.stripeCustomerId) ? idOf(invoice.customer) : undefined,
    cancelledAt: null
  };
  // A zero invoice is the start of a trial, not a payment: the trial stands.
  if (Number(invoice.amount_paid) > 0) fields.status = 'active';

  if (!(await applyToGym(gym, fields, eventAt))) return { gym, result: IGNORED_OLD_EVENT };
  return { gym, result: fields.status ? 'period extended, active' : 'period recorded' };
}

async function onInvoicePaymentFailed(invoice, eventAt) {
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  const gym = (await gymBySubscriptionId(subscriptionId)) || (await gymByMetadata(metadataOfInvoice(invoice)));
  if (!gym) return { gym: null, result: 'no gym matched' };
  if (gym.subscription && gym.subscription.status === 'cancelled') return { gym, result: 'already cancelled' };
  // Out of grace already; another failed retry changes nothing until it is paid.
  if (gym.subscription && gym.subscription.status === 'expired') return { gym, result: 'already expired' };
  if (notCurrentSubscription(gym, subscriptionId)) return { gym, result: IGNORED_OTHER_SUBSCRIPTION };
  if (staleEvent(gym, eventAt)) return { gym, result: IGNORED_OLD_EVENT };
  if (!(await applyToGym(gym, { status: 'past_due' }, eventAt))) return { gym, result: IGNORED_OLD_EVENT };
  return { gym, result: 'past due' };
}

async function onSubscriptionUpdated(subscription, eventAt) {
  const gym = (await gymBySubscriptionId(subscription.id)) || (await gymByMetadata(subscription.metadata));
  if (!gym) return { gym: null, result: 'no gym matched' };
  if (notCurrentSubscription(gym, subscription.id)) return { gym, result: IGNORED_OTHER_SUBSCRIPTION };
  if (staleEvent(gym, eventAt)) return { gym, result: IGNORED_OLD_EVENT };

  const status = STATUS_MAP[subscription.status];
  const priced = amountOf(subscription);
  const billingCycle = priced.interval === 'year' ? 'yearly' : priced.interval === 'month' ? 'monthly' : undefined;
  const fields = {
    status,
    currentPeriodEnd: periodEndOf(subscription) || undefined,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: idOf(subscription.customer) || undefined,
    billingCycle,
    cancelledAt: status === 'cancelled' ? new Date() : status ? null : undefined
  };
  if (priced.currency) {
    fields.amount = priced.amount;
    fields.currency = priced.currency;
    fields.stripePriceSummary = await summaryFor(gym, { ...priced, billingCycle: billingCycle || (gym.subscription && gym.subscription.billingCycle) });
  }

  if (!(await applyToGym(gym, fields, eventAt))) return { gym, result: IGNORED_OLD_EVENT };
  return { gym, result: status ? `synced: ${status}` : `synced (${subscription.status} not mapped)` };
}

async function onSubscriptionDeleted(subscription, eventAt) {
  const gym = (await gymBySubscriptionId(subscription.id)) || (await gymByMetadata(subscription.metadata));
  if (!gym) return { gym: null, result: 'no gym matched' };
  // An old subscription ending after the gym moved to a new one must not
  // cancel the new one.
  if (notCurrentSubscription(gym, subscription.id)) return { gym, result: IGNORED_OTHER_SUBSCRIPTION };
  if (staleEvent(gym, eventAt)) return { gym, result: IGNORED_OLD_EVENT };
  const applied = await applyToGym(gym, {
    status: 'cancelled',
    cancelledAt: new Date(),
    // The customer stays (their invoices live there); the subscription is gone.
    stripeSubscriptionId: ''
  }, eventAt);
  if (!applied) return { gym, result: IGNORED_OLD_EVENT };
  return { gym, result: 'cancelled' };
}

/**
 * Applies one verified event. Resolves { gym, result } -- `gym` is the gym
 * changed (or null) and `result` a few words for the audit log. Throws when
 * a write failed, so the caller can let Stripe retry.
 */
async function handlePlatformStripeEvent(event, stripe) {
  const object = event.data && event.data.object;
  // When Stripe created the event: what orders it against the others.
  const eventAt = unix(event.created);
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(object, stripe, eventAt);
    case 'invoice.paid':
      return onInvoicePaid(object, stripe, eventAt);
    case 'invoice.payment_failed':
      return onInvoicePaymentFailed(object, eventAt);
    case 'customer.subscription.updated':
      return onSubscriptionUpdated(object, eventAt);
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(object, eventAt);
    default:
      return { gym: null, result: 'ignored' };
  }
}

module.exports = {
  handlePlatformStripeEvent,
  HANDLED_EVENTS: ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'],
  // for services/signupProvisioning.js
  applyCheckoutToGym,
  retrieveCheckoutSubscription,
  idOf,
  // exported for tests
  periodEndOf,
  subscriptionIdOfInvoice,
  amountOf,
  checkoutStatus,
  notCurrentSubscription,
  staleEvent,
  withStatusEffects,
  STATUS_MAP
};
