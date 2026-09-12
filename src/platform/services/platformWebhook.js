// src/platform/services/platformWebhook.js
//
// What the platform does with a Stripe event once its signature has been
// checked (controllers/platformSettingsController.js webhook): finds the gym
// the event is about and brings its subscription record into line with what
// Stripe now says. Every write is a $set of named fields, so a webhook never
// wipes what the panel recorded beside them.
//
// Stripe's subscription object has moved `current_period_end` between API
// versions -- older ones carry it on the subscription, newer ones on each
// item -- so both are read.

const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const { planFor } = require('../entitlements');
const { invalidateTenantCache } = require('../middleware/resolveTenant');
const { fromMinorUnits, intervalFor } = require('./platformBilling');

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

const CLEARED_NOTICES = { trial7: null, trial3: null, trial1: null, pastDue: null, expired: null };

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

/** Applies named subscription fields to a gym. `newPeriodEnd` moving forward resets the notices. */
async function applyToGym(gym, fields) {
  const set = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) set[`subscription.${key}`] = value;
  }
  const before = gym.subscription && gym.subscription.currentPeriodEnd ? new Date(gym.subscription.currentPeriodEnd).getTime() : 0;
  const after = fields.currentPeriodEnd ? new Date(fields.currentPeriodEnd).getTime() : 0;
  if (after && after > before) {
    for (const [key, value] of Object.entries(CLEARED_NOTICES)) set[`subscription.notices.${key}`] = value;
  }
  if (!Object.keys(set).length) return;
  await Gym.updateOne({ _id: gym._id }, { $set: set });
  invalidateTenantCache();
}

async function onCheckoutCompleted(session, stripe) {
  if (session.mode !== 'subscription') return { gym: null, result: 'not a subscription checkout' };
  const gym =
    (session.client_reference_id && mongoose.Types.ObjectId.isValid(session.client_reference_id) && (await Gym.findById(session.client_reference_id).lean())) ||
    (await gymByMetadata(session.metadata));
  if (!gym) return { gym: null, result: 'no gym matched' };

  const subscriptionId = idOf(session.subscription);
  let subscription = null;
  if (subscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      console.warn(`[platform] could not read subscription ${subscriptionId}:`, error.message);
    }
  }

  const metadata = session.metadata || {};
  const billingCycle = metadata.billingCycle === 'yearly' || metadata.billingCycle === 'monthly' ? metadata.billingCycle : gym.subscription && gym.subscription.billingCycle;
  const fields = {
    stripeCustomerId: idOf(session.customer) || undefined,
    stripeSubscriptionId: subscriptionId || undefined,
    billingCycle,
    startedAt: new Date(),
    cancelledAt: null,
    status: 'active'
  };

  if (subscription) {
    fields.status = STATUS_MAP[subscription.status] || 'active';
    fields.currentPeriodEnd = periodEndOf(subscription) || undefined;
    const priced = amountOf(subscription);
    if (priced.currency) {
      fields.amount = priced.amount;
      fields.currency = priced.currency;
      fields.stripePriceSummary = await summaryFor(gym, { ...priced, billingCycle });
    }
  }

  await applyToGym(gym, fields);
  return { gym, result: `subscription ${fields.status}` };
}

async function onInvoicePaid(invoice, stripe) {
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  const gym = (await gymBySubscriptionId(subscriptionId)) || (await gymByMetadata(metadataOfInvoice(invoice)));
  if (!gym) return { gym: null, result: 'no gym matched' };

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

  await applyToGym(gym, fields);
  return { gym, result: fields.status ? 'period extended, active' : 'period recorded' };
}

async function onInvoicePaymentFailed(invoice) {
  const gym = (await gymBySubscriptionId(subscriptionIdOfInvoice(invoice))) || (await gymByMetadata(metadataOfInvoice(invoice)));
  if (!gym) return { gym: null, result: 'no gym matched' };
  if (gym.subscription && gym.subscription.status === 'cancelled') return { gym, result: 'already cancelled' };
  await applyToGym(gym, { status: 'past_due' });
  return { gym, result: 'past due' };
}

async function onSubscriptionUpdated(subscription) {
  const gym = (await gymBySubscriptionId(subscription.id)) || (await gymByMetadata(subscription.metadata));
  if (!gym) return { gym: null, result: 'no gym matched' };

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

  await applyToGym(gym, fields);
  return { gym, result: status ? `synced: ${status}` : `synced (${subscription.status} not mapped)` };
}

async function onSubscriptionDeleted(subscription) {
  const gym = (await gymBySubscriptionId(subscription.id)) || (await gymByMetadata(subscription.metadata));
  if (!gym) return { gym: null, result: 'no gym matched' };
  await applyToGym(gym, {
    status: 'cancelled',
    cancelledAt: new Date(),
    // The customer stays (their invoices live there); the subscription is gone.
    stripeSubscriptionId: ''
  });
  return { gym, result: 'cancelled' };
}

/**
 * Applies one verified event. Resolves { gym, result } -- `gym` is the gym
 * changed (or null) and `result` a few words for the audit log. Throws when
 * a write failed, so the caller can let Stripe retry.
 */
async function handlePlatformStripeEvent(event, stripe) {
  const object = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(object, stripe);
    case 'invoice.paid':
      return onInvoicePaid(object, stripe);
    case 'invoice.payment_failed':
      return onInvoicePaymentFailed(object);
    case 'customer.subscription.updated':
      return onSubscriptionUpdated(object);
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(object);
    default:
      return { gym: null, result: 'ignored' };
  }
}

module.exports = {
  handlePlatformStripeEvent,
  HANDLED_EVENTS: ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'],
  // exported for tests
  periodEndOf,
  subscriptionIdOfInvoice,
  amountOf,
  STATUS_MAP
};
