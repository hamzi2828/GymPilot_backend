// A paid signup's checkout.session.completed: it makes the gym once, with the
// Stripe subscription on it; a retry links rather than makes another; a
// failure is recorded and thrown so Stripe tries again; a gym's own checkout
// is untouched. Also what the signup's Stripe page is asked for. No database
// and no Stripe: statics, provisionGym and the Stripe client are stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
process.env.PLATFORM_ROOT_DOMAIN = 'gympilot.app';
delete process.env.DEFAULT_TENANT_SLUG;
delete process.env.FRONTEND_ORIGIN;

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const DemoRequest = require('../../src/platform/models/demoRequestModel');
const PlatformPlan = require('../../src/platform/models/platformPlanModel');
const PlatformSettings = require('../../src/platform/models/platformSettingsModel');
const PlatformAuditLog = require('../../src/platform/models/platformAuditLogModel');
const SuperAdmin = require('../../src/platform/models/superAdminModel');
const provisioning = require('../../src/platform/provisioning');
const ownerInvite = require('../../src/platform/ownerInvite');
const emailService = require('../../src/services/emailService');
const { handlePlatformStripeEvent } = require('../../src/platform/services/platformWebhook');
const { recoverSignup } = require('../../src/platform/services/signupProvisioning');
const { createSignupCheckoutSession, closeSignupCheckoutSession } = require('../../src/platform/services/platformBilling');
const { getPlatformStripe } = require('../../src/platform/services/platformStripe');

function stub(target, methods) {
  const saved = {};
  for (const [name, fn] of Object.entries(methods)) {
    saved[name] = target[name];
    target[name] = fn;
  }
  return () => {
    for (const [name, fn] of Object.entries(saved)) target[name] = fn;
  };
}

function query(value) {
  const q = {
    select: () => q,
    lean: () => q,
    sort: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject)
  };
  return q;
}

const PLAN = {
  _id: new mongoose.Types.ObjectId(),
  slug: 'growth',
  name: 'Growth',
  isActive: true,
  price: { monthly: 8000, yearly: 80000, currency: 'PKR' },
  includedAddons: ['website'],
  trialDays: 14
};

const TRIAL_END = 1791000000;

function signupRecord(fields = {}, signup = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    kind: 'signup',
    name: 'Aisha Khan',
    firstName: 'Aisha',
    lastName: 'Khan',
    email: 'aisha@ironworks.fit',
    phone: '+92 300 1234567',
    gymName: 'Iron Works Fitness',
    country: 'Karachi, Pakistan',
    preferredSlug: 'iron-works',
    plan: { slug: 'growth', name: 'Growth', billingCycle: 'monthly', addonSlugs: ['website', 'member-app'], amount: 9500, currency: 'PKR', trialDays: 14 },
    gymId: null,
    createdAt: new Date('2026-09-21T09:00:00Z'),
    ...fields,
    signup: { state: 'awaiting_payment', timezone: 'Asia/Karachi', attempts: 0, claimedAt: null, ...signup }
  };
}

function madeGym(fields = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: 'Iron Works Fitness',
    slug: 'iron-works',
    plan: PLAN._id,
    domains: [{ host: 'iron-works.gympilot.app', isPrimary: true }],
    provisionedAt: new Date(),
    subscription: { status: 'trialing', billingCycle: 'monthly', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', addons: [] },
    ...fields
  };
}

function signupEvent(signupId, { subscription = 'sub_1', kind = 'signup' } = {}) {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    type: 'checkout.session.completed',
    created: 1790000000,
    data: {
      object: {
        id: 'cs_1',
        mode: 'subscription',
        client_reference_id: String(signupId),
        subscription,
        customer: 'cus_1',
        payment_status: 'no_payment_required',
        metadata: { kind, signupId: String(signupId), planSlug: 'growth', billingCycle: 'monthly' }
      }
    }
  };
}

const stripeSaying = (status) => ({
  subscriptions: { retrieve: async (id) => ({ id, status, trial_end: TRIAL_END, current_period_end: TRIAL_END, items: { data: [] } }) }
});

/**
 * Everything the webhook touches, stubbed. `world` says what the database
 * holds; `calls` records what was done to it.
 */
function webhookWorld(world) {
  const calls = { provisioned: [], claims: [], signupWrites: [], gymWrites: [], audits: [], adminEmails: 0 };
  const restore = [
    stub(DemoRequest, {
      findById: () => query(world.signup),
      findOneAndUpdate: (filter, update) => {
        calls.claims.push({ filter, update });
        if (world.claimLost) return query(null);
        const claimed = { ...world.signup, signup: { ...world.signup.signup, state: 'provisioning', attempts: (world.signup.signup.attempts || 0) + 1 } };
        return query(claimed);
      },
      updateOne: async (filter, update) => {
        calls.signupWrites.push({ filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }),
    stub(Gym, {
      findById: () => query(world.gymById || null),
      findOne: () => query(world.gymBySubscription || null),
      updateOne: async (filter, update) => {
        calls.gymWrites.push({ filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }),
    stub(PlatformPlan, { findOne: () => query(PLAN), findById: () => query(PLAN) }),
    stub(SuperAdmin, {
      find: () => {
        calls.adminEmails += 1;
        return query([]);
      }
    }),
    stub(PlatformAuditLog, { record: async (entry) => calls.audits.push(entry) }),
    stub(provisioning, {
      provisionGym: async (input, options) => {
        calls.provisioned.push({ input, options });
        if (world.provisionFails) throw new provisioning.ProvisioningError(world.provisionFails, 500);
        return { gym: madeGym(), warnings: [], ownerInvite: { sent: true }, siteUrl: 'https://iron-works.gympilot.app' };
      }
    })
  ];
  return { calls, restore: () => restore.forEach((r) => r()) };
}

const readySet = (calls) => (calls.signupWrites.find((w) => w.update.$set && w.update.$set['signup.state'] === 'ready') || {}).update;

test('a paid signup makes its gym, with the payment on it from the start', async () => {
  const signup = signupRecord();
  const { calls, restore } = webhookWorld({ signup });
  try {
    const outcome = await handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('trialing'));
    assert.equal(outcome.result, 'signup: gym created (trialing)');
    assert.equal(outcome.gym.slug, 'iron-works');

    // Claimed before anything was made, and only from a state that may be.
    assert.equal(calls.claims.length, 1);
    assert.equal(calls.claims[0].filter.gymId, null);
    assert.equal(calls.claims[0].update.$set['signup.state'], 'provisioning');

    assert.equal(calls.provisioned.length, 1);
    const { input, options } = calls.provisioned[0];
    assert.equal(input.name, 'Iron Works Fitness');
    assert.equal(input.preferredSlug, 'iron-works');
    assert.equal(input.owner.email, 'aisha@ironworks.fit');
    assert.equal(input.owner.firstName, 'Aisha');
    assert.ok(typeof input.owner.password === 'string' && input.owner.password.length >= 8, 'a throwaway password provisionGym needs');
    assert.equal(String(input.planId), String(PLAN._id));
    assert.equal(input.subscription.status, 'trialing');
    assert.equal(input.subscription.billingCycle, 'monthly');
    assert.deepEqual(input.subscription.addonSlugs, ['website', 'member-app']);
    assert.equal(input.subscription.currentPeriodEnd.getTime(), TRIAL_END * 1000);
    assert.deepEqual(input.locale, { country: 'PK', currency: 'PKR', timezone: 'Asia/Karachi' });
    assert.deepEqual(options.stripe, { customerId: 'cus_1', subscriptionId: 'sub_1' });
    assert.equal(options.requireSite, true);
    assert.equal(options.enforceDatabasePolicy, true);

    const ready = readySet(calls);
    assert.ok(ready, 'the signup is marked ready');
    assert.equal(ready.$set.status, 'converted');
    assert.equal(ready.$set['signup.siteUrl'], 'https://iron-works.gympilot.app');
    assert.equal(ready.$set['signup.inviteSent'], true);
    assert.equal(ready.$set['signup.trialEndsAt'].getTime(), TRIAL_END * 1000);

    // The gym's subscription gets what Stripe says, the way a gym's own checkout does.
    assert.equal(calls.gymWrites.length, 1);
    assert.equal(calls.gymWrites[0].update.$set['subscription.stripeSubscriptionId'], 'sub_1');
    assert.equal(calls.gymWrites[0].update.$set['subscription.status'], 'trialing');

    assert.equal(calls.audits[0].action, 'gym_created');
    assert.equal(calls.adminEmails, 1, 'admins are told a gym signed up');
  } finally {
    restore();
  }
});

test('a retry after the gym exists links it and never makes a second', async () => {
  const gym = madeGym();
  // The signup already points at its gym.
  const done = signupRecord({ gymId: gym._id }, { state: 'ready' });
  const linked = webhookWorld({ signup: done, gymById: gym });
  try {
    const outcome = await handlePlatformStripeEvent(signupEvent(done._id), stripeSaying('trialing'));
    assert.match(outcome.result, /^signup linked to iron-works/);
    assert.equal(linked.calls.provisioned.length, 0);
    assert.equal(linked.calls.claims.length, 0);
    assert.equal(readySet(linked.calls).$set['signup.inviteSent'], undefined, 'a ready signup keeps what it recorded');
  } finally {
    linked.restore();
  }

  // The process died after the gym was made but before the signup said so:
  // the gym is found by the Stripe subscription written with it. Whether
  // the owner's email went before it died is not known, so a fresh one goes.
  const signup = signupRecord({}, { state: 'provisioning', claimedAt: new Date() });
  const orphan = webhookWorld({ signup, gymBySubscription: gym });
  const invites = [];
  const restoreInvite = stub(ownerInvite, {
    sendOwnerInvite: async (args) => {
      invites.push(args);
      return { sent: true };
    }
  });
  try {
    const outcome = await handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('trialing'));
    assert.match(outcome.result, /^signup linked/);
    assert.equal(orphan.calls.provisioned.length, 0);
    assert.equal(String(readySet(orphan.calls).$set.gymId), String(gym._id));
    assert.equal(invites.length, 1, 'the owner is sent their set-password link again');
    assert.equal(invites[0].siteUrl, 'https://iron-works.gympilot.app');
    assert.equal(readySet(orphan.calls).$set['signup.inviteSent'], true);
  } finally {
    restoreInvite();
    orphan.restore();
  }

  // Set up by hand from the panel before the payment landed: the panel invited them.
  const byHand = webhookWorld({ signup: signupRecord({ gymId: gym._id }), gymById: gym });
  try {
    await handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('trialing'));
    assert.equal(readySet(byHand.calls).$set['signup.inviteSent'], true);
  } finally {
    byHand.restore();
  }
});

test('the claim records the page that was paid on, for a retry to read back', async () => {
  const signup = signupRecord();
  const { calls, restore } = webhookWorld({ signup });
  try {
    await handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('trialing'));
    assert.equal(calls.claims[0].update.$set['signup.stripeSessionId'], 'cs_1');
  } finally {
    restore();
  }
});

test('a signup given up on is left alone by a late delivery', async () => {
  const signup = signupRecord({}, { state: 'failed', gaveUpAt: new Date() });
  const { calls, restore } = webhookWorld({ signup });
  try {
    const outcome = await handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('trialing'));
    assert.match(outcome.result, /given up on/);
    assert.equal(calls.claims.length, 0);
    assert.equal(calls.provisioned.length, 0);
    assert.equal(calls.gymWrites.length, 0);
  } finally {
    restore();
  }
});

test('a gym left half made by a delivery that died is cleared away and made afresh', async () => {
  const halfMade = madeGym({
    provisionedAt: null,
    createdAt: new Date(Date.now() - 3600000),
    owner: { email: 'aisha@ironworks.fit' },
    database: { name: 'gpit_iron_works_abc123' }
  });
  const signup = signupRecord({}, { state: 'provisioning', claimedAt: new Date(Date.now() - 3600000) });
  const world = webhookWorld({ signup, gymBySubscription: halfMade, gymById: halfMade });
  const deleted = [];
  const restoreDelete = stub(provisioning, {
    deleteGym: async (gym, options) => {
      deleted.push({ gym, options });
      return { deleted: true, databaseDropped: true };
    }
  });
  try {
    const outcome = await handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('trialing'));
    assert.equal(outcome.result, 'signup: gym created (trialing)');
    assert.equal(deleted.length, 1);
    assert.deepEqual(deleted[0].options, { confirmSlug: 'iron-works', dropDatabase: true });
    assert.equal(world.calls.provisioned.length, 1, 'then made again');
    assert.ok(world.calls.audits.some((a) => a.action === 'gym_deleted'));
  } finally {
    restoreDelete();
    world.restore();
  }

  // Somebody else's gym, or one that is on a dedicated database, is never touched.
  for (const other of [
    madeGym({ provisionedAt: null, createdAt: new Date(Date.now() - 3600000), owner: { email: 'someone@else.fit' } }),
    madeGym({ provisionedAt: null, createdAt: new Date(Date.now() - 3600000), owner: { email: 'aisha@ironworks.fit' }, database: { name: 'x', uri: 'mongodb://elsewhere' } })
  ]) {
    const kept = webhookWorld({ signup: signupRecord({}, { state: 'failed', attempts: 1 }), gymBySubscription: other, gymById: other });
    const gone = [];
    const restoreKept = stub(provisioning, { deleteGym: async (gym) => gone.push(gym) });
    try {
      await assert.rejects(handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('trialing')), /half-made gym/);
      assert.equal(gone.length, 0);
      assert.equal(kept.calls.provisioned.length, 0);
    } finally {
      restoreKept();
      kept.restore();
    }
  }
});

test('a failed setup is recorded and thrown so Stripe retries; admins hear once', async () => {
  const signup = signupRecord();
  const first = webhookWorld({ signup, provisionFails: 'database unreachable' });
  try {
    await assert.rejects(handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('active')), /database unreachable/);
    const failed = first.calls.signupWrites.find((w) => w.update.$set['signup.state'] === 'failed');
    assert.match(failed.update.$set['signup.error'], /database unreachable/);
    assert.equal(first.calls.adminEmails, 1);
  } finally {
    first.restore();
  }

  const retry = webhookWorld({ signup: signupRecord({}, { state: 'failed', attempts: 1 }), provisionFails: 'still unreachable' });
  try {
    await assert.rejects(handlePlatformStripeEvent(signupEvent(signup._id), stripeSaying('active')), /still unreachable/);
    assert.equal(retry.calls.provisioned.length, 1, 'a retry tries again');
    assert.equal(retry.calls.adminEmails, 0, 'but does not email again');
  } finally {
    retry.restore();
  }
});

test('a signup another delivery holds, or that is not paid, is left for a retry', async () => {
  const lost = webhookWorld({ signup: signupRecord(), claimLost: true });
  try {
    await assert.rejects(handlePlatformStripeEvent(signupEvent(new mongoose.Types.ObjectId()), stripeSaying('trialing')), /another delivery/);
    assert.equal(lost.calls.provisioned.length, 0);
  } finally {
    lost.restore();
  }

  const busy = webhookWorld({ signup: signupRecord({}, { state: 'provisioning', claimedAt: new Date() }) });
  try {
    await assert.rejects(handlePlatformStripeEvent(signupEvent(new mongoose.Types.ObjectId()), stripeSaying('trialing')), /another delivery/);
    assert.equal(busy.calls.claims.length, 0);
    assert.equal(busy.calls.provisioned.length, 0);
  } finally {
    busy.restore();
  }

  const unpaid = webhookWorld({ signup: signupRecord() });
  try {
    await assert.rejects(handlePlatformStripeEvent(signupEvent(new mongoose.Types.ObjectId()), stripeSaying('incomplete')), /not paid yet/);
    assert.equal(unpaid.calls.provisioned.length, 0);
  } finally {
    unpaid.restore();
  }
});

test('a second payment for a signup that already has its gym is flagged, not attached', async () => {
  const gym = madeGym({ subscription: { status: 'trialing', stripeSubscriptionId: 'sub_1' } });
  const signup = signupRecord({ gymId: gym._id }, { state: 'ready' });
  const { calls, restore } = webhookWorld({ signup, gymById: gym });
  try {
    const outcome = await handlePlatformStripeEvent(signupEvent(signup._id, { subscription: 'sub_2' }), stripeSaying('trialing'));
    assert.match(outcome.result, /second payment sub_2/);
    assert.equal(calls.provisioned.length, 0);
    assert.equal(calls.gymWrites.length, 0, 'the gym stays on its own subscription');
    assert.match(calls.signupWrites[0].update.$push.warnings, /cancel and refund it in Stripe/);
  } finally {
    restore();
  }
});

test('a gym\'s own checkout still goes the old way', async () => {
  const gym = madeGym({ subscription: { status: 'expired', stripeSubscriptionId: '' } });
  const { calls, restore } = webhookWorld({ signup: null, gymById: gym });
  try {
    const event = signupEvent(gym._id, { kind: undefined });
    event.data.object.metadata = { gymId: String(gym._id) };
    const outcome = await handlePlatformStripeEvent(event, stripeSaying('active'));
    assert.equal(outcome.result, 'subscription active');
    assert.equal(calls.provisioned.length, 0);
    assert.equal(calls.claims.length, 0);
    assert.equal(calls.gymWrites.length, 1);
  } finally {
    restore();
  }
});

/* ------------------------------ a stuck signup ----------------------------- */

const HOUR = 3600000;
const DAY = 24 * HOUR;

/**
 * webhookWorld, plus what recoverSignup asks of it: the retry's own claim
 * (answered with `attempts` retries so far, the first `startedAgo` ms ago),
 * the signup read back afterwards (ready once markReady ran), Stripe's copy
 * of the checkout, and the buyer's email.
 */
function recoveryWorld({ signup, attempts = 1, startedAgo = 0, due = true, provisionFails = null, cancelRefused = false, amountPaid = 0 }) {
  const world = webhookWorld({ signup, provisionFails });
  const calls = Object.assign(world.calls, { recoveryClaims: [], stripe: [], buyerEmails: [] });
  const startedAt = attempts > 1 ? new Date(Date.now() - startedAgo) : null;
  const webhookClaim = DemoRequest.findOneAndUpdate;
  const restore = [
    stub(DemoRequest, {
      findOneAndUpdate: (filter, update, options) => {
        if (!(update.$set && update.$set['signup.recoveryAt'])) return webhookClaim(filter, update, options);
        calls.recoveryClaims.push({ filter, update });
        return query(due ? { ...signup, signup: { ...signup.signup, recoveryAttempts: attempts, recoveryStartedAt: startedAt } } : null);
      },
      findById: () => query(readySet(world.calls) ? { ...signup, gymId: 'g1', signup: { ...signup.signup, state: 'ready' } } : signup)
    }),
    stub(emailService, {
      sendEmail: async (to, subject) => {
        calls.buyerEmails.push({ to, subject });
        return { success: true };
      }
    })
  ];
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          calls.stripe.push(['session', id]);
          return { ...signupEvent(signup._id).data.object, id, status: 'complete' };
        }
      }
    },
    subscriptions: {
      retrieve: async (id) => ({ id, status: cancelRefused ? 'active' : 'trialing', trial_end: TRIAL_END, current_period_end: TRIAL_END, items: { data: [] } }),
      cancel: async (id, params) => {
        calls.stripe.push(['cancel', id, params]);
        if (cancelRefused) throw new Error('Stripe is down');
        return { id, status: 'canceled', currency: 'pkr', latest_invoice: 'in_1' };
      }
    },
    invoices: { retrieve: async () => ({ id: 'in_1', currency: 'pkr', amount_paid: amountPaid }) }
  };
  return {
    calls,
    stripe,
    restore: () => {
      restore.forEach((r) => r());
      world.restore();
    }
  };
}

const stuckSignup = (signup = {}) =>
  signupRecord({}, { state: 'provisioning', claimedAt: new Date(Date.now() - 2 * HOUR), stripeSessionId: 'cs_paid', stripeSubscriptionId: 'sub_1', ...signup });

test('a stuck signup is set up again from the checkout Stripe says it paid on', async () => {
  const signup = stuckSignup();
  const { calls, stripe, restore } = recoveryWorld({ signup });
  try {
    const outcome = await recoverSignup(signup._id, { stripe });
    assert.equal(outcome.outcome, 'ready', JSON.stringify(outcome));
    assert.deepEqual(calls.stripe[0], ['session', 'cs_paid']);
    assert.equal(calls.provisioned.length, 1);
    // Claimed first: only when it is still stuck, and not retried a moment ago.
    const { filter } = calls.recoveryClaims[0];
    assert.equal(String(filter._id), String(signup._id));
    assert.deepEqual(filter['signup.state'], { $in: ['provisioning', 'failed'] });
    assert.equal(filter['signup.gaveUpAt'], null);
    assert.ok(calls.signupWrites.some((w) => w.update.$set && w.update.$set['signup.recoveryStartedAt']), 'the first retry starts the clock');
  } finally {
    restore();
  }
});

test('a signup somebody else is already retrying, or that is not stuck, is left alone', async () => {
  const signup = stuckSignup();
  const { calls, stripe, restore } = recoveryWorld({ signup, due: false });
  try {
    assert.equal((await recoverSignup(signup._id, { stripe })).outcome, 'not due');
    assert.equal(calls.stripe.length, 0);
    assert.equal(calls.provisioned.length, 0);
  } finally {
    restore();
  }
});

test('still stuck after a few retries: the admins are told, once', async () => {
  const signup = stuckSignup();
  const quiet = console.error;
  console.error = () => {};
  const early = recoveryWorld({ signup, attempts: 2, startedAgo: HOUR, provisionFails: 'database unreachable' });
  try {
    const outcome = await recoverSignup(signup._id, { stripe: early.stripe });
    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.error, /database unreachable/);
    assert.ok(!early.calls.signupWrites.some((w) => w.update.$set && w.update.$set['signup.alertedAt']), 'two retries is not yet worth an email');
  } finally {
    early.restore();
  }

  const third = recoveryWorld({ signup, attempts: 3, startedAgo: 2 * HOUR, provisionFails: 'database unreachable' });
  try {
    const outcome = await recoverSignup(signup._id, { stripe: third.stripe });
    assert.equal(outcome.outcome, 'failed');
    const alert = third.calls.signupWrites.find((w) => w.update.$set && w.update.$set['signup.alertedAt']);
    assert.ok(alert, 'the admins are told');
    assert.equal(alert.filter['signup.alertedAt'], null, 'only if nobody told them before');
    assert.ok(third.calls.adminEmails >= 1);
    assert.equal(third.calls.stripe.filter((c) => c[0] === 'cancel').length, 0, 'nothing is cancelled yet');
  } finally {
    console.error = quiet;
    third.restore();
  }
});

test('stuck for days: the subscription is cancelled at once and the buyer and admins told', async () => {
  const signup = stuckSignup();
  const quiet = console.error;
  console.error = () => {};
  const { calls, stripe, restore } = recoveryWorld({ signup, attempts: 4, startedAgo: 4 * DAY, provisionFails: 'database unreachable', amountPaid: 950000 });
  try {
    const outcome = await recoverSignup(signup._id, { stripe });
    assert.equal(outcome.outcome, 'gave up', JSON.stringify(outcome));
    assert.deepEqual(calls.stripe.find((c) => c[0] === 'cancel'), ['cancel', 'sub_1', { invoice_now: false, prorate: false }]);
    const mark = calls.signupWrites.find((w) => w.update.$set && w.update.$set['signup.gaveUpAt']);
    assert.ok(mark, 'marked as given up');
    assert.equal(mark.filter['signup.gaveUpAt'], null, 'once');
    assert.match(mark.update.$set['signup.error'], /sub_1 was cancelled/);
    assert.match(mark.update.$set['signup.error'], /PKR 9,500.*refund it in Stripe/);
    assert.equal(calls.buyerEmails.length, 1);
    assert.equal(calls.buyerEmails[0].to, 'aisha@ironworks.fit');
    assert.ok(calls.adminEmails >= 1);
  } finally {
    console.error = quiet;
    restore();
  }
});

test('when Stripe will not cancel, nothing is given up and the next run tries again', async () => {
  const signup = stuckSignup();
  const quiet = console.error;
  console.error = () => {};
  const { calls, stripe, restore } = recoveryWorld({ signup, attempts: 4, startedAgo: 4 * DAY, provisionFails: 'database unreachable', cancelRefused: true });
  try {
    const outcome = await recoverSignup(signup._id, { stripe });
    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.error, /could not be cancelled/);
    assert.ok(!calls.signupWrites.some((w) => w.update.$set && w.update.$set['signup.gaveUpAt']));
    assert.equal(calls.buyerEmails.length, 0);
  } finally {
    console.error = quiet;
    restore();
  }
});

/* ------------------------- the signup's Stripe page ------------------------ */

test('the signup\'s Stripe page takes a card, carries the trial, and is priced like the gym will be', async () => {
  // priceLinesFor reads the plan back by id; this is the one it finds.
  let stored = PLAN;
  const restore = [
    stub(PlatformSettings, { getSettings: async () => ({ stripe: { secretKey: 'sk_test_unit_signup', enabled: true, webhookSecret: 'whsec_unit' } }) }),
    stub(PlatformPlan, { findById: () => query(stored) })
  ];
  const stripe = await getPlatformStripe('sk_test_unit_signup');
  const sent = [];
  const restoreStripe = stub(stripe.checkout.sessions, {
    create: async (params) => {
      sent.push(params);
      return { id: 'cs_new', url: 'https://checkout.stripe.test/cs_new' };
    }
  });
  const addons = [
    { slug: 'website', name: 'Website', price: { monthly: 3000, yearly: 30000, currency: 'PKR' } },
    { slug: 'member-app', name: 'Member app', price: { monthly: 1500, yearly: 15000, currency: 'PKR' } }
  ];
  try {
    const session = await createSignupCheckoutSession({
      signupId: 'sig_1',
      email: 'aisha@ironworks.fit',
      plan: PLAN,
      addons,
      billingCycle: 'monthly',
      successUrl: 'https://gympilot.app/checkout/success?signup=sig_1',
      cancelUrl: 'https://gympilot.app/checkout?cancelled=1'
    });
    assert.deepEqual(session, { url: 'https://checkout.stripe.test/cs_new', id: 'cs_new' });

    const params = sent[0];
    assert.equal(params.mode, 'subscription');
    assert.deepEqual(params.payment_method_types, ['card']);
    assert.equal(params.customer_email, 'aisha@ironworks.fit');
    assert.equal(params.client_reference_id, 'sig_1');
    assert.deepEqual(params.metadata, { signupId: 'sig_1', kind: 'signup', planSlug: 'growth', billingCycle: 'monthly' });
    assert.equal(params.subscription_data.trial_period_days, 14);
    assert.equal(params.subscription_data.metadata.kind, 'signup');
    // The plan and the paid add-on; the included one costs nothing and gets no line.
    assert.deepEqual(
      params.line_items.map((l) => [l.price_data.product_data.name, l.price_data.unit_amount, l.price_data.currency, l.price_data.recurring.interval]),
      [
        ['Growth (GymPilot)', 800000, 'pkr', 'month'],
        ['Member app (GymPilot)', 150000, 'pkr', 'month']
      ]
    );
    assert.equal(params.success_url, 'https://gympilot.app/checkout/success?signup=sig_1');

    // No trial: charged today.
    stored = { ...PLAN, trialDays: 0 };
    await createSignupCheckoutSession({ signupId: 'sig_2', email: 'a@b.co', plan: stored, addons: [], billingCycle: 'monthly', successUrl: 's', cancelUrl: 'c' });
    assert.equal(sent[1].subscription_data.trial_period_days, undefined);

    // Nothing to charge, nothing to open.
    stored = { ...PLAN, price: { monthly: 0, yearly: 0, currency: 'PKR' } };
    await assert.rejects(
      createSignupCheckoutSession({ signupId: 'sig_3', email: 'a@b.co', plan: stored, addons: [], billingCycle: 'monthly', successUrl: 's', cancelUrl: 'c' }),
      (error) => error.code === 'FREE_PLAN'
    );
  } finally {
    restoreStripe();
    restore.forEach((r) => r());
  }
});

test('an old signup page is closed, or reported paid', async () => {
  const restore = stub(PlatformSettings, { getSettings: async () => ({ stripe: { secretKey: 'sk_test_unit_close', enabled: true } }) });
  const stripe = await getPlatformStripe('sk_test_unit_close');
  let expire = async () => ({ status: 'expired' });
  let retrieve = async () => ({ status: 'complete' });
  const restoreStripe = stub(stripe.checkout.sessions, { expire: (...a) => expire(...a), retrieve: (...a) => retrieve(...a) });
  try {
    assert.equal(await closeSignupCheckoutSession('cs_old'), 'expired');
    expire = async () => {
      throw new Error('This Checkout Session is not open');
    };
    assert.equal(await closeSignupCheckoutSession('cs_old'), 'complete');
    retrieve = async () => {
      throw new Error('No such checkout.session');
    };
    assert.equal(await closeSignupCheckoutSession('cs_old'), 'unknown');
  } finally {
    restoreStripe();
    restore();
  }
});
