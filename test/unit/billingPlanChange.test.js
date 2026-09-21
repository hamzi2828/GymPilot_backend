// An owner changing their gym's plan from Settings → Billing, and what the
// Billing tab's checkout does before opening a Stripe page: the plans on
// offer, the move itself (Stripe first, then the record), the gyms that
// must subscribe instead, an expired gym Stripe still bills, a second tab,
// and the webhook moving a gym to the plan its checkout paid for. No
// database and no Stripe: statics and the billing services are stubbed.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.DEFAULT_TENANT_SLUG;
delete process.env.PLATFORM_CONTACT_EMAIL;

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const PlatformPlan = require('../../src/platform/models/platformPlanModel');
const PlatformAddon = require('../../src/platform/models/platformAddonModel');
const PlatformSettings = require('../../src/platform/models/platformSettingsModel');
const PlatformAuditLog = require('../../src/platform/models/platformAuditLogModel');
const platformBilling = require('../../src/platform/services/platformBilling');
const subscriptionSync = require('../../src/platform/services/subscriptionSync');
const billing = require('../../src/platform/controllers/billingController');
const { handlePlatformStripeEvent } = require('../../src/platform/services/platformWebhook');

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

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

const plan = (slug, name, monthly, yearly, extra = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  slug,
  name,
  isActive: true,
  price: { monthly, yearly, currency: 'PKR' },
  limits: { maxMembers: monthly > 9000 ? 0 : 200, maxStaff: 3, maxTrainers: 0, maxClasses: 10 },
  features: [],
  includedAddons: [],
  trialDays: 14,
  order: monthly,
  ...extra
});

const STARTER = plan('starter', 'Starter', 5000, 50000, { includedAddons: ['website'] });
const GROWTH = plan('growth', 'Growth', 8000, 80000, { includedAddons: ['website'] });
const PRO = plan('pro', 'Pro', 15000, 0);
const DOLLARS = plan('global', 'Global', 99, 990, { price: { monthly: 99, yearly: 990, currency: 'USD' } });
const PLANS = [STARTER, GROWTH, PRO, DOLLARS];

const ADDONS = [
  new PlatformAddon({ slug: 'website', name: 'Website', price: { monthly: 3000, yearly: 30000, currency: 'PKR' } }),
  new PlatformAddon({ slug: 'member-app', name: 'Member app', price: { monthly: 1500, yearly: 15000, currency: 'PKR' } })
];

function gymOn(p, subscription = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    slug: 'iron-den',
    name: 'Iron Den',
    plan: p ? p._id : null,
    owner: { email: 'sam@irondengym.com' },
    subscription: {
      status: 'active',
      billingCycle: 'monthly',
      currency: 'PKR',
      planAmount: 7000,
      amount: 8500,
      // The website came with the plan; the member app is bought.
      addons: [
        { slug: 'website', name: 'Website', amount: 0 },
        { slug: 'member-app', name: 'Member app', amount: 1500 }
      ],
      stripeSubscriptionId: 'sub_live',
      stripeCustomerId: 'cus_1',
      currentPeriodEnd: new Date(Date.now() + 20 * 86400000),
      ...subscription
    }
  };
}

/** Everything the billing routes touch, stubbed; `calls` records what they did. */
function billingWorld(gym, { stripeOn = true, synced = true, ended = false, previous = 'expired' } = {}) {
  const calls = { gymWrites: [], syncs: [], sessions: [], closed: [], audits: [], endedAsked: [] };
  const restore = [
    stub(Gym, {
      findByIdWithUri: async () => gym,
      updateOne: async (filter, update) => {
        calls.gymWrites.push({ filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }),
    stub(PlatformPlan, {
      findOne: (filter) => query(PLANS.find((p) => p.slug === filter.slug && (!filter.isActive || p.isActive)) || null),
      findById: (id) => query(PLANS.find((p) => String(p._id) === String(id)) || null),
      find: () => query(PLANS)
    }),
    stub(PlatformAddon, { find: async (filter) => ADDONS.filter((a) => filter.slug.$in.includes(a.slug)) }),
    stub(PlatformSettings, { getSettings: async () => ({ stripe: { secretKey: 'sk_test_unit_plans', enabled: stripeOn } }) }),
    stub(PlatformAuditLog, { record: async (entry) => calls.audits.push(entry) }),
    stub(subscriptionSync, {
      syncStripeSubscription: async (args) => {
        calls.syncs.push(args);
        return synced ? { synced: true, summary: `${args.plan.name} · PKR ${args.next.amount} / month` } : { synced: false, skipped: 'Stripe subscription is canceled' };
      }
    }),
    stub(platformBilling, {
      stripeSubscriptionEnded: async (id) => {
        calls.endedAsked.push(id);
        return ended;
      },
      closeCheckoutSession: async (id) => {
        calls.closed.push(id);
        return previous;
      },
      createCheckoutSession: async (args) => {
        calls.sessions.push(args);
        return { url: 'https://checkout.stripe.test/cs_new', id: 'cs_new' };
      }
    })
  ];
  return { calls, restore: () => restore.forEach((r) => r()) };
}

const req = (gym, body = {}) => ({ tenant: { _id: gym._id }, body, query: {}, user: { email: 'sam@irondengym.com' } });

/* --------------------------------- the list --------------------------------- */

test('the picker lists the plans on sale, prices and limits, with the gym\'s own marked', async () => {
  const gym = gymOn(GROWTH);
  const { restore } = billingWorld(gym);
  try {
    const res = fakeRes();
    await billing.plans(req(gym), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.map((p) => [p.slug, p.current]), [['starter', false], ['growth', true], ['pro', false], ['global', false]]);
    const pro = res.body.data.find((p) => p.slug === 'pro');
    assert.deepEqual(pro.price, { monthly: 15000, yearly: 0, currency: 'PKR' });
    assert.equal(pro.limits.maxMembers, 0, '0 is unlimited, as everywhere');
    assert.equal(pro._id, undefined, 'no ids go out');
  } finally {
    restore();
  }
});

/* ------------------------------ changing plan ------------------------------- */

test('an upgrade goes to Stripe first -- paid add-ons kept, the old plan\'s free ones left -- then the record', async () => {
  const gym = gymOn(STARTER);
  const { calls, restore } = billingWorld(gym);
  try {
    const res = fakeRes();
    await billing.changePlan(req(gym, { planSlug: 'growth' }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /You are on Growth now/);

    assert.equal(calls.syncs.length, 1);
    const { next, plan: to } = calls.syncs[0];
    assert.equal(to.slug, 'growth');
    assert.equal(next.planAmount, 8000, 'the new plan at its list price');
    assert.deepEqual(next.addons.map((a) => [a.slug, a.amount]).sort(), [['member-app', 1500], ['website', 0]]);
    assert.equal(next.amount, 9500);
    assert.equal(next.billingCycle, 'monthly');

    const write = calls.gymWrites[0];
    assert.equal(String(write.update.$set.plan), String(GROWTH._id));
    assert.equal(write.update.$set['subscription.planAmount'], 8000);
    assert.equal(write.update.$set['subscription.amount'], 9500);
    assert.match(write.update.$set['subscription.stripePriceSummary'], /^Growth/);
    // Status, period and Stripe's own bookkeeping are left to the webhook.
    for (const key of ['subscription.status', 'subscription.currentPeriodEnd', 'subscription.stripeEventAt', 'subscription']) {
      assert.equal(write.update.$set[key], undefined, key);
    }
    assert.equal(calls.audits[0].action, 'gym_plan_changed');
    assert.equal(calls.audits[0].meta.from, 'starter');
    assert.equal(calls.audits[0].meta.to, 'growth');
  } finally {
    restore();
  }
});

test('on a trial the move costs nothing now, and says so', async () => {
  const gym = gymOn(GROWTH, { status: 'trialing' });
  const { calls, restore } = billingWorld(gym);
  try {
    const res = fakeRes();
    await billing.changePlan(req(gym, { planSlug: 'pro' }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.message, /Nothing is charged until your trial ends/);
    assert.equal(calls.syncs[0].next.status, 'trialing');
  } finally {
    restore();
  }
});

test('switching cycle on the same plan is a change too; the same plan and cycle is not', async () => {
  const gym = gymOn(GROWTH);
  const { calls, restore } = billingWorld(gym);
  try {
    const yearly = fakeRes();
    await billing.changePlan(req(gym, { planSlug: 'growth', billingCycle: 'yearly' }), yearly);
    assert.equal(yearly.statusCode, 200, JSON.stringify(yearly.body));
    assert.equal(calls.syncs[0].next.planAmount, 80000);

    const same = fakeRes();
    await billing.changePlan(req(gym, { planSlug: 'growth' }), same);
    assert.equal(same.statusCode, 400);
    assert.equal(same.body.code, 'SAME_PLAN');
  } finally {
    restore();
  }
});

test('what cannot be changed here is refused before Stripe is asked', async () => {
  const cases = [
    [gymOn(GROWTH), { planSlug: 'nope' }, 404, 'PLAN_NOT_FOUND'],
    [gymOn(GROWTH), { planSlug: 'pro', billingCycle: 'yearly' }, 400, 'CYCLE_NOT_OFFERED'],
    [gymOn(GROWTH), { planSlug: 'global' }, 409, 'CURRENCY_MISMATCH'],
    [gymOn(GROWTH, { status: 'past_due' }), { planSlug: 'pro' }, 409, 'PAYMENT_OVERDUE'],
    // Not billed by Stripe (yet): the picker subscribes through checkout instead.
    [gymOn(GROWTH, { status: 'trialing', stripeSubscriptionId: '' }), { planSlug: 'pro' }, 409, 'NO_STRIPE_SUBSCRIPTION'],
    [gymOn(GROWTH, { status: 'expired' }), { planSlug: 'pro' }, 409, 'NO_STRIPE_SUBSCRIPTION']
  ];
  for (const [gym, body, status, code] of cases) {
    const { calls, restore } = billingWorld(gym);
    try {
      const res = fakeRes();
      await billing.changePlan(req(gym, body), res);
      assert.equal(res.statusCode, status, `${code}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, code);
      assert.equal(calls.syncs.length, 0, code);
      assert.equal(calls.gymWrites.length, 0, code);
    } finally {
      restore();
    }
  }

  const gym = gymOn(GROWTH);
  const off = billingWorld(gym, { stripeOn: false });
  try {
    const res = fakeRes();
    await billing.changePlan(req(gym, { planSlug: 'pro' }), res);
    assert.equal(res.body.code, 'PLATFORM_STRIPE_NOT_CONFIGURED');
  } finally {
    off.restore();
  }
});

test('when Stripe says no, nothing is recorded', async () => {
  const gym = gymOn(GROWTH);
  const { calls, restore } = billingWorld(gym);
  const refuse = stub(subscriptionSync, {
    syncStripeSubscription: async () => {
      throw new subscriptionSync.SubscriptionSyncError('Stripe did not accept the change, so nothing was saved: Your card was declined.');
    }
  });
  try {
    const res = fakeRes();
    await billing.changePlan(req(gym, { planSlug: 'pro' }), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /card was declined/);
    assert.equal(calls.gymWrites.length, 0);
  } finally {
    refuse();
    restore();
  }

  const ended = billingWorld(gym, { synced: false });
  try {
    const res = fakeRes();
    await billing.changePlan(req(gym, { planSlug: 'pro' }), res);
    assert.equal(res.body.code, 'NO_STRIPE_SUBSCRIPTION');
    assert.equal(ended.calls.gymWrites.length, 0);
  } finally {
    ended.restore();
  }
});

/* ------------------------------ the checkout ------------------------------- */

test('a gym not billed by Stripe subscribes to the plan it picked, priced as that plan', async () => {
  const gym = gymOn(STARTER, { status: 'trialing', stripeSubscriptionId: '', stripeCustomerId: '' });
  const { calls, restore } = billingWorld(gym);
  try {
    const res = fakeRes();
    await billing.checkout(req(gym, { planSlug: 'growth', billingCycle: 'yearly' }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const { gym: target, billingCycle } = calls.sessions[0];
    assert.equal(billingCycle, 'yearly');
    assert.equal(String(target.plan), String(GROWTH._id));
    assert.equal(target.subscription.billingCycle, 'yearly');
    assert.equal(target.subscription.planAmount, 80000);
    assert.deepEqual(target.subscription.addons.map((a) => [a.slug, a.amount]).sort(), [['member-app', 15000], ['website', 0]]);
    assert.equal(target.subscription.currentPeriodEnd, gym.subscription.currentPeriodEnd, 'the trial is kept');
    assert.equal(String(gym.plan), String(STARTER._id), 'the gym itself moves only once it has paid');
    // The page is remembered, to be closed if they come back and open another.
    assert.equal(calls.gymWrites[0].update.$set['subscription.checkoutSessionId'], 'cs_new');
  } finally {
    restore();
  }
});

test('the page opened last time is closed first; one paid a moment ago stops a second', async () => {
  const gym = gymOn(GROWTH, { status: 'trialing', stripeSubscriptionId: '', checkoutSessionId: 'cs_old' });
  const closed = billingWorld(gym, { previous: 'expired' });
  try {
    const res = fakeRes();
    await billing.checkout(req(gym, {}), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(closed.calls.closed, ['cs_old']);
    assert.equal(closed.calls.sessions.length, 1);
  } finally {
    closed.restore();
  }

  const paid = billingWorld(gym, { previous: 'complete' });
  try {
    const res = fakeRes();
    await billing.checkout(req(gym, {}), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'CHECKOUT_COMPLETED');
    assert.equal(paid.calls.sessions.length, 0);
  } finally {
    paid.restore();
  }

  const stuck = billingWorld(gym, { previous: 'open' });
  try {
    const res = fakeRes();
    await billing.checkout(req(gym, {}), res);
    assert.equal(res.statusCode, 502);
    assert.equal(stuck.calls.sessions.length, 0);
  } finally {
    stuck.restore();
  }
});

test('an expired gym Stripe still bills is sent to the portal, not a second subscription', async () => {
  const gym = gymOn(GROWTH, { status: 'expired', stripeSubscriptionId: 'sub_unpaid' });
  const unpaid = billingWorld(gym, { ended: false });
  try {
    const res = fakeRes();
    await billing.checkout(req(gym, {}), res);
    assert.equal(res.statusCode, 409);
    // The code the renew page already answers by opening the portal.
    assert.equal(res.body.code, 'ALREADY_SUBSCRIBED');
    assert.match(res.body.message, /Manage billing/);
    assert.deepEqual(unpaid.calls.endedAsked, ['sub_unpaid']);
    assert.equal(unpaid.calls.sessions.length, 0);
  } finally {
    unpaid.restore();
  }

  // Over in Stripe (its webhook lost, say): a new checkout is the way back.
  const over = billingWorld(gym, { ended: true });
  try {
    const res = fakeRes();
    await billing.checkout(req(gym, {}), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(over.calls.sessions.length, 1);
  } finally {
    over.restore();
  }

  const live = gymOn(GROWTH);
  const subscribed = billingWorld(live);
  try {
    const res = fakeRes();
    await billing.checkout(req(live, {}), res);
    assert.equal(res.body.code, 'ALREADY_SUBSCRIBED');
    assert.doesNotMatch(res.body.message, /cycle from Manage billing/, 'the portal does not change plans');
  } finally {
    subscribed.restore();
  }
});

/* ------------------------------ the webhook -------------------------------- */

test('a paid checkout for another plan moves the gym to it, and clears the page it was paid on', async () => {
  const gym = gymOn(STARTER, { status: 'trialing', stripeSubscriptionId: '', checkoutSessionId: 'cs_paid' });
  const writes = [];
  const restore = [
    stub(Gym, {
      findById: () => query(gym),
      findOne: () => query(gym),
      updateOne: async (filter, update) => {
        writes.push({ filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }),
    stub(PlatformPlan, {
      findOne: (filter) => query(PLANS.find((p) => p.slug === filter.slug) || null),
      findById: (id) => query(PLANS.find((p) => String(p._id) === String(id)) || null)
    }),
    stub(PlatformAddon, { find: async (filter) => ADDONS.filter((a) => filter.slug.$in.includes(a.slug)) })
  ];
  const stripe = {
    subscriptions: {
      retrieve: async (id) => ({
        id,
        status: 'trialing',
        items: { data: [{ current_period_end: 1800000000, quantity: 1, price: { unit_amount: 9500000, currency: 'pkr', recurring: { interval: 'year' } } }] }
      })
    }
  };
  try {
    const outcome = await handlePlatformStripeEvent(
      {
        id: 'evt_plan',
        type: 'checkout.session.completed',
        created: 1790000000,
        data: {
          object: {
            id: 'cs_paid',
            mode: 'subscription',
            client_reference_id: String(gym._id),
            subscription: 'sub_new',
            customer: 'cus_1',
            metadata: { gymId: String(gym._id), planSlug: 'growth', billingCycle: 'yearly' }
          }
        }
      },
      stripe
    );
    assert.match(outcome.result, /plan growth/);
    const cleared = writes.find((w) => w.update.$set['subscription.checkoutSessionId'] === '');
    assert.ok(cleared, 'the page is no longer open');
    assert.equal(cleared.filter['subscription.checkoutSessionId'], 'cs_paid');

    const applied = writes.find((w) => w.update.$set['subscription.stripeSubscriptionId'] === 'sub_new').update.$set;
    assert.equal(String(applied.plan), String(GROWTH._id));
    assert.equal(applied['subscription.planAmount'], 80000);
    assert.deepEqual(applied['subscription.addons'].map((a) => a.slug).sort(), ['member-app', 'website']);
    assert.match(applied['subscription.stripePriceSummary'], /^Growth/);
    assert.equal(applied['subscription.billingCycle'], 'yearly');
  } finally {
    restore.forEach((r) => r());
  }
});
