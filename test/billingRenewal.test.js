// Gym billing and renewal: a lapsed gym can still sign in and pay, Stripe's
// out-of-order events cannot undo newer state, the roll-over gives Stripe
// time to report, and the platform's own Stripe secrets are sealed at rest.
// No database: model statics are stubbed where a flow needs them.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'unit-test-settings-key';
delete process.env.DEFAULT_TENANT_SLUG;

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const Gym = require('../src/platform/models/gymModel');
const { resolveTenant, isRenewalRequest, invalidateTenantCache } = require('../src/platform/middleware/resolveTenant');
const { handlePlatformStripeEvent, checkoutStatus, notCurrentSubscription, staleEvent } = require('../src/platform/services/platformWebhook');
const { rollFilters, ownerNoticeEmail, STRIPE_SETTLE_DAYS } = require('../src/platform/jobs');
const { hasLiveStripeSubscription, billingTabUrl } = require('../src/platform/controllers/billingController');
const { reclaimStale, STALE_CLAIM_MS } = require('../src/platform/controllers/platformSettingsController');
const PlatformSettings = require('../src/platform/models/platformSettingsModel');
const PlatformStripeEvent = require('../src/platform/models/platformStripeEventModel');
const { isSealed, seal } = require('../src/services/secretBox');
const { runWithTenant } = require('../src/platform/tenantContext');

const DAY = 86400000;

/** Replaces model statics for one test and puts them back after. */
function stub(model, methods) {
  const saved = {};
  for (const [name, fn] of Object.entries(methods)) {
    saved[name] = model[name];
    model[name] = fn;
  }
  return () => {
    for (const [name, fn] of Object.entries(saved)) model[name] = fn;
  };
}

/* ------------------------------ renewal gate ------------------------------ */

test('only sign-in and the billing routes count as renewal requests', () => {
  const req = (method, path) => ({ method, path });
  assert.equal(isRenewalRequest(req('POST', '/user/login')), true);
  assert.equal(isRenewalRequest(req('POST', '/user/login/2fa')), true);
  assert.equal(isRenewalRequest(req('POST', '/user/login/')), true);
  assert.equal(isRenewalRequest(req('GET', '/api/billing/subscription')), true);
  assert.equal(isRenewalRequest(req('POST', '/api/billing/checkout')), true);
  assert.equal(isRenewalRequest(req('POST', '/api/billing/portal')), true);

  assert.equal(isRenewalRequest(req('GET', '/user/login')), false);
  assert.equal(isRenewalRequest(req('POST', '/user/signup')), false);
  assert.equal(isRenewalRequest(req('GET', '/roles/me')), false);
  assert.equal(isRenewalRequest(req('GET', '/settings/public')), false);
  assert.equal(isRenewalRequest(req('GET', '/api/billingx/anything')), false);
  assert.equal(isRenewalRequest(req('GET', '/api/gymfolio/packages')), false);
});

function fakeRequest(method, path) {
  const req = new EventEmitter();
  Object.assign(req, { method, path, originalUrl: path, headers: { 'x-tenant-slug': 'lapsed-gym' }, query: {} });
  return req;
}

function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function throughGate(gym, method, path) {
  invalidateTenantCache();
  const restore = stub(Gym, { findBySlug: async () => gym });
  try {
    const req = fakeRequest(method, path);
    const res = fakeResponse();
    let passed = false;
    await resolveTenant(req, res, () => {
      passed = true;
    });
    return { passed, req, res };
  } finally {
    restore();
    invalidateTenantCache();
  }
}

const lapsedGym = {
  _id: new mongoose.Types.ObjectId(),
  slug: 'lapsed-gym',
  status: 'active',
  database: { name: 'gympilot_unit_lapsed' },
  subscription: { status: 'expired' }
};

test('an expired gym still lets its owner sign in and pay, and nothing else', async () => {
  for (const [method, path] of [['POST', '/user/login'], ['POST', '/user/login/2fa'], ['POST', '/api/billing/checkout'], ['GET', '/api/billing/subscription']]) {
    const { passed, req } = await throughGate(lapsedGym, method, path);
    assert.equal(passed, true, `${method} ${path} goes through`);
    assert.equal(String(req.tenant._id), String(lapsedGym._id), 'with the gym bound');
  }

  const blocked = await throughGate(lapsedGym, 'GET', '/settings/public');
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 402);
  assert.equal(blocked.res.body.code, 'SUBSCRIPTION_INACTIVE');
  assert.equal(blocked.res.body.renewable, true);

  const cancelled = await throughGate({ ...lapsedGym, subscription: { status: 'cancelled' } }, 'GET', '/roles/me');
  assert.equal(cancelled.res.statusCode, 402);
  assert.equal(cancelled.res.body.renewable, true);
});

test('a suspended gym gets no renewal exception', async () => {
  const { passed, res } = await throughGate({ ...lapsedGym, status: 'suspended' }, 'POST', '/user/login');
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'TENANT_SUSPENDED');
  assert.equal(res.body.renewable, undefined);
});

/* ------------------------------ billing routes ------------------------------ */

test('a gym Stripe is still billing cannot start a second checkout', () => {
  const withSub = (status) => ({ subscription: { status, stripeSubscriptionId: 'sub_1' } });
  assert.equal(hasLiveStripeSubscription(withSub('trialing')), true);
  assert.equal(hasLiveStripeSubscription(withSub('active')), true);
  assert.equal(hasLiveStripeSubscription(withSub('past_due')), true);
  assert.equal(hasLiveStripeSubscription(withSub('expired')), false);
  assert.equal(hasLiveStripeSubscription(withSub('cancelled')), false);
  assert.equal(hasLiveStripeSubscription({ subscription: { status: 'active', stripeSubscriptionId: '' } }), false);
  assert.equal(hasLiveStripeSubscription(null), false);
});

test('Stripe sends the owner back to the Billing tab', () => {
  assert.equal(billingTabUrl('https://gym.example', 'success'), 'https://gym.example/admin/settings?tab=billing&billing=success');
  assert.equal(billingTabUrl('https://gym.example', 'cancelled'), 'https://gym.example/admin/settings?tab=billing&billing=cancelled');
  assert.equal(billingTabUrl('https://gym.example'), 'https://gym.example/admin/settings?tab=billing');
});

/* ------------------------------ platform webhook ------------------------------ */

test('a completed checkout records only statuses Stripe really means', () => {
  assert.equal(checkoutStatus({}, { status: 'active' }), 'active');
  assert.equal(checkoutStatus({}, { status: 'trialing' }), 'trialing');
  assert.equal(checkoutStatus({ payment_status: 'paid' }, { status: 'incomplete' }), undefined, 'incomplete is not paid');
  assert.equal(checkoutStatus({ payment_status: 'paid' }, null), 'active');
  assert.equal(checkoutStatus({ payment_status: 'unpaid' }, null), undefined);
  assert.equal(checkoutStatus({ payment_status: 'no_payment_required' }, null), undefined);
});

test('events about a subscription the gym is not on are recognised', () => {
  const on = (id, status = 'active') => ({ subscription: { stripeSubscriptionId: id, status } });
  assert.equal(notCurrentSubscription(on('sub_new'), 'sub_new'), false);
  assert.equal(notCurrentSubscription(on('sub_new'), 'sub_old'), true);
  // Cleared by a deletion: the one it had is not current any more.
  assert.equal(notCurrentSubscription(on('', 'cancelled'), 'sub_old'), true);
  // Never had one (a trial, or billed by hand): the first one is welcome.
  assert.equal(notCurrentSubscription(on('', 'trialing'), 'sub_first'), false);
  assert.equal(notCurrentSubscription(on('', 'expired'), 'sub_first'), false);
  assert.equal(notCurrentSubscription(on('sub_new'), ''), false);
});

test('an event older than the last one applied is stale', () => {
  const t = new Date('2026-09-01T10:00:00Z');
  const gym = { subscription: { stripeEventAt: t } };
  assert.equal(staleEvent(gym, new Date(t.getTime() - 1000)), true);
  assert.equal(staleEvent(gym, t), false, 'the same second is not older');
  assert.equal(staleEvent(gym, new Date(t.getTime() + 1000)), false);
  assert.equal(staleEvent({ subscription: {} }, t), false);
  assert.equal(staleEvent(gym, null), false);
});

function webhookStubs(gym) {
  const writes = [];
  const restore = stub(Gym, {
    findOne: () => ({ lean: async () => gym }),
    findById: () => ({ lean: async () => gym }),
    updateOne: async (filter, update) => {
      writes.push({ filter, update });
      return { matchedCount: 1, modifiedCount: 1 };
    }
  });
  return { writes, restore };
}

const subscriptionEvent = (type, created, subscription) => ({ id: `evt_${created}`, type, created, data: { object: subscription } });

test('a late "active" for a deleted subscription does not bring the gym back', async () => {
  const deletedAt = new Date('2026-09-10T12:00:00Z');
  const gym = {
    _id: new mongoose.Types.ObjectId(),
    slug: 'cancelled-gym',
    plan: null,
    subscription: { status: 'cancelled', stripeSubscriptionId: '', stripeEventAt: deletedAt }
  };
  const { writes, restore } = webhookStubs(gym);
  try {
    const late = subscriptionEvent('customer.subscription.updated', deletedAt.getTime() / 1000 - 60, {
      id: 'sub_old',
      status: 'active',
      metadata: { gymId: String(gym._id) },
      items: { data: [] }
    });
    const outcome = await handlePlatformStripeEvent(late, null);
    assert.match(outcome.result, /^ignored/);
    assert.equal(writes.length, 0);
  } finally {
    restore();
  }
});

test('an old subscription ending after a renewal does not cancel the new one', async () => {
  const gym = {
    _id: new mongoose.Types.ObjectId(),
    slug: 'renewed-gym',
    plan: null,
    subscription: { status: 'active', stripeSubscriptionId: 'sub_new' }
  };
  const { writes, restore } = webhookStubs(gym);
  try {
    const outcome = await handlePlatformStripeEvent(
      subscriptionEvent('customer.subscription.deleted', 1790000000, { id: 'sub_old', status: 'canceled', metadata: { gymId: String(gym._id) } }),
      null
    );
    assert.match(outcome.result, /not the gym's current subscription/);
    assert.equal(writes.length, 0);
  } finally {
    restore();
  }
});

test('updates for the current subscription are written with an ordering guard', async () => {
  const gym = {
    _id: new mongoose.Types.ObjectId(),
    slug: 'paying-gym',
    plan: null,
    subscription: { status: 'active', stripeSubscriptionId: 'sub_1' }
  };
  const { writes, restore } = webhookStubs(gym);
  try {
    const outcome = await handlePlatformStripeEvent(
      subscriptionEvent('customer.subscription.updated', 1790000000, { id: 'sub_1', status: 'past_due', metadata: {}, items: { data: [] } }),
      null
    );
    assert.equal(outcome.result, 'synced: past_due');
    assert.equal(writes.length, 1);
    const { filter, update } = writes[0];
    assert.equal(update.$set['subscription.status'], 'past_due');
    assert.equal(update.$set['subscription.stripeEventAt'].getTime(), 1790000000 * 1000);
    assert.ok(Array.isArray(filter.$or), 'the write only lands when no newer event got there first');
  } finally {
    restore();
  }
});

test('a checkout whose subscription is still incomplete does not mark the gym paid', async () => {
  const gym = {
    _id: new mongoose.Types.ObjectId(),
    slug: 'lapsed-gym',
    plan: null,
    subscription: { status: 'expired', stripeSubscriptionId: '' }
  };
  const { writes, restore } = webhookStubs(gym);
  const stripe = { subscriptions: { retrieve: async () => ({ id: 'sub_2', status: 'incomplete', items: { data: [] } }) } };
  try {
    const outcome = await handlePlatformStripeEvent(
      {
        id: 'evt_checkout',
        type: 'checkout.session.completed',
        created: 1790000000,
        data: { object: { mode: 'subscription', client_reference_id: String(gym._id), subscription: 'sub_2', customer: 'cus_1', payment_status: 'unpaid', metadata: {} } }
      },
      stripe
    );
    assert.equal(writes.length, 1);
    const set = writes[0].update.$set;
    assert.equal(set['subscription.status'], undefined, 'status left as it was');
    assert.equal(set['subscription.cancelledAt'], undefined);
    assert.equal(set['subscription.stripeSubscriptionId'], 'sub_2', 'but it is the gym\'s subscription now');
    assert.match(outcome.result, /incomplete, status not recorded/);
  } finally {
    restore();
  }
});

test('a checkout whose subscription cannot be read fails, so Stripe sends it again', async () => {
  const gym = { _id: new mongoose.Types.ObjectId(), slug: 'lapsed-gym', plan: null, subscription: { status: 'expired' } };
  const { writes, restore } = webhookStubs(gym);
  const quiet = console.warn;
  console.warn = () => {};
  const stripe = { subscriptions: { retrieve: async () => { throw new Error('Stripe is down'); } } };
  try {
    await assert.rejects(
      handlePlatformStripeEvent(
        { id: 'evt_c', type: 'checkout.session.completed', created: 1790000000, data: { object: { mode: 'subscription', client_reference_id: String(gym._id), subscription: 'sub_3', payment_status: 'paid', metadata: {} } } },
        stripe
      ),
      /Stripe is down/
    );
    assert.equal(writes.length, 0);
  } finally {
    console.warn = quiet;
    restore();
  }
});

/* ------------------------------ webhook claims ------------------------------ */

test('a claim left unfinished for too long is taken back; a fresh or finished one is not', async () => {
  const calls = [];
  let deletedCount = 1;
  const restore = stub(PlatformStripeEvent, {
    deleteOne: async (filter) => {
      calls.push(filter);
      return { deletedCount };
    },
    claim: async () => true
  });
  try {
    const now = Date.parse('2026-09-21T10:00:00Z');
    assert.equal(await reclaimStale({ id: 'evt_1' }, now), true);
    const filter = calls[0];
    assert.equal(filter.eventId, 'evt_1');
    assert.equal(filter.handledAt, null, 'a handled event is never taken back');
    assert.equal(filter.createdAt.$lt.getTime(), now - STALE_CLAIM_MS);
    assert.equal(STALE_CLAIM_MS, 10 * 60 * 1000);

    deletedCount = 0;
    assert.equal(await reclaimStale({ id: 'evt_2' }, now), false);
  } finally {
    restore();
  }
});

/* ------------------------------ daily roll-over ------------------------------ */

test('the roll-over gives Stripe time to renew before calling a gym past due', () => {
  const now = new Date('2026-09-21T06:00:00Z');
  const { toPastDue, toExpired } = rollFilters(now, 7);
  const [manual, stripe] = toPastDue.$or;

  assert.deepEqual(manual['subscription.stripeSubscriptionId'], { $in: ['', null] });
  assert.equal(manual['subscription.currentPeriodEnd'].$lt.getTime(), now.getTime(), 'billed by hand: due when the period ends');

  assert.deepEqual(stripe['subscription.stripeSubscriptionId'], { $nin: ['', null] });
  assert.equal(STRIPE_SETTLE_DAYS, 2);
  assert.equal(stripe['subscription.currentPeriodEnd'].$lt.getTime(), now.getTime() - 2 * DAY, 'billed by Stripe: two days later');

  assert.deepEqual(toPastDue['subscription.status'], { $in: ['trialing', 'active'] });
  assert.equal(toExpired['subscription.currentPeriodEnd'].$lt.getTime(), now.getTime() - 7 * DAY);
});

/* ------------------------------ owner emails ------------------------------ */

test('owner emails point at the Billing tab and say how an expired gym renews', () => {
  const gym = {
    name: 'Iron Den',
    owner: { firstName: 'Sam' },
    subscription: { status: 'expired', currentPeriodEnd: new Date(Date.now() - 10 * DAY) }
  };
  const expired = ownerNoticeEmail({ notice: 'expired', gym, siteUrl: 'https://irondengym.com/', daysLeft: -10 });
  assert.match(expired.html, /https:\/\/irondengym\.com\/admin\/settings\?tab=billing/);
  assert.match(expired.html, /Sign in to renew/);

  const trial = ownerNoticeEmail({ notice: 'trial3', gym: { ...gym, subscription: { status: 'trialing', currentPeriodEnd: new Date(Date.now() + 3 * DAY) } }, siteUrl: 'https://irondengym.com', daysLeft: 3 });
  assert.match(trial.html, /admin\/settings\?tab=billing/);

  // A failed card: Stripe already moved the period on, so no "was due" date.
  const failed = ownerNoticeEmail({
    notice: 'pastDue',
    gym: { ...gym, subscription: { status: 'past_due', stripeSubscriptionId: 'sub_1', currentPeriodEnd: new Date(Date.now() + 25 * DAY) } },
    siteUrl: 'https://irondengym.com',
    daysLeft: 25
  });
  assert.match(failed.html, /did not go through/);
  assert.doesNotMatch(failed.html, /was due on/);
});

/* ------------------------------ platform secrets ------------------------------ */

test("the platform's Stripe secrets are sealed at rest and open inside any gym's request", async () => {
  const doc = new PlatformSettings({ stripe: { secretKey: '  sk_test_platform  ', webhookSecret: 'whsec_platform', publishableKey: 'pk_test_platform' } });
  assert.ok(isSealed(doc.get('stripe.secretKey', null, { getters: false })));
  assert.ok(isSealed(doc.get('stripe.webhookSecret', null, { getters: false })));
  assert.equal(doc.get('stripe.publishableKey', null, { getters: false }), 'pk_test_platform');
  assert.equal(doc.stripe.secretKey, 'sk_test_platform');
  assert.equal(doc.stripe.webhookSecret, 'whsec_platform');

  // A gym's /api/billing checkout reads these with that gym in context, and
  // a value sealed inside one gym's request opens outside it (the webhook).
  const gymA = { _id: '000000000000000000000001', slug: 'a', database: { name: 'gympilot_unit_a' } };
  const sealedInGym = await runWithTenant(gymA, () => {
    assert.equal(doc.stripe.secretKey, 'sk_test_platform');
    return new PlatformSettings({ stripe: { webhookSecret: 'whsec_from_a_request' } });
  });
  assert.ok(isSealed(sealedInGym.get('stripe.webhookSecret', null, { getters: false })));
  assert.equal(sealedInGym.stripe.webhookSecret, 'whsec_from_a_request');
});

test('plaintext saved before sealing still reads, and is sealed on the next save', () => {
  const legacy = PlatformSettings.hydrate({ _id: new mongoose.Types.ObjectId(), singleton: 'platform', stripe: { secretKey: 'sk_live_legacy', webhookSecret: seal('whsec_sealed') } });
  assert.equal(legacy.stripe.secretKey, 'sk_live_legacy');
  assert.equal(legacy.stripe.webhookSecret, 'whsec_sealed');

  const hooks = PlatformSettings.schema.s.hooks._pres.get('save') || [];
  const sealLegacy = hooks.find((hook) => hook.fn && hook.fn.name === 'sealLegacySecrets');
  assert.ok(sealLegacy, 'a pre-save hook seals legacy values');
  sealLegacy.fn.call(legacy);
  assert.ok(isSealed(legacy.get('stripe.secretKey', null, { getters: false })));
  assert.equal(legacy.stripe.secretKey, 'sk_live_legacy');
  assert.equal(legacy.stripe.webhookSecret, 'whsec_sealed', 'an already sealed value is not sealed twice');
});
