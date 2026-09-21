// Member card payments against a real MongoDB: what the gym's Stripe webhook
// and the expiry sweep do to package orders, run through the same
// middleware, controllers and services the routes use. Stripe itself is a
// stand-in (h.setStripe) that records what it was asked.
//
//   - card is offered only once the webhook signing secret is saved too
//   - a free package is refused with a clear 400, not a 500
//   - checkout.session.expired closes the abandoned order
//   - a lapsed gym's webhooks are still applied; a suspended gym's get a 503
//   - a renewing Stripe subscription has two days to settle before expiring
//   - "membership ended" goes out once per lapse, and only when it is true
//   - deleting an account can stop its Stripe subscriptions first

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const test = h.suite(setup);

const DAY = 86400000;
const HOUR = 3600000;
const WEBHOOK_SECRET = 'whsec_integration';
const STRIPE_READY = {
  stripe: { enabled: true, publishableKey: 'pk_test_integration', secretKey: 'sk_test_integration', webhookSecret: WEBHOOK_SECRET }
};

let gym;
let noWebhookGym;
let lapsedGym;
let suspendedGym;
let sweepGym;
let PackageOrder;
let Package;
let User;
let payments;
let controller;
let expiry;
let middleware;

async function setup() {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  payments = h.src('services/gymfolioPaymentService');
  controller = h.src('gymfolio/controller/gymfolioPaymentController');
  expiry = h.src('gymfolio/services/membershipExpiry');
  middleware = h.src('platform/middleware/tenantFromPayload');

  gym = await h.createGym('pay-gym', { settings: STRIPE_READY });
  noWebhookGym = await h.createGym('pay-nowebhook', {
    settings: { stripe: { enabled: true, publishableKey: 'pk_test_x', secretKey: 'sk_test_x', webhookSecret: '' } }
  });
  lapsedGym = await h.createGym('pay-lapsed', { settings: STRIPE_READY });
  suspendedGym = await h.createGym('pay-suspended', { settings: STRIPE_READY });
  sweepGym = await h.createGym('pay-sweep');

  // Before anything has looked them up, so no cached copy is stale.
  const Gym = h.src('platform/models/gymModel');
  await Gym.updateOne({ slug: 'pay-lapsed' }, { $set: { 'subscription.status': 'expired' } });
  await Gym.updateOne({ slug: 'pay-suspended' }, { $set: { status: 'suspended' } });
}

let seq = 0;

/** A package order as the collection holds it, straight in (no hooks). */
function orderDoc({
  status = 'active',
  paymentStatus = status === 'pending' ? 'pending' : 'paid',
  endDate = new Date(Date.now() + 20 * DAY),
  startDate,
  userId = null,
  email,
  kind = 'membership',
  subscriptionId = null,
  stripeStatus = subscriptionId ? 'active' : '',
  cancelAtPeriodEnd = false,
  sessionId = null
} = {}) {
  seq += 1;
  const { Types } = h.state.mongoose;
  const pending = status === 'pending';
  const start = startDate || new Date(endDate.getTime() - 30 * DAY);
  return {
    _id: new Types.ObjectId(),
    orderNumber: `MP-${seq}`,
    userId,
    packageId: new Types.ObjectId(),
    packageDetails: {
      name: 'Monthly',
      price: '40',
      currency: 'gbp',
      period: 'month',
      features: [],
      kind,
      durationDays: 0,
      sessions: 0,
      joiningFee: 0,
      billing: { mode: subscriptionId ? 'recurring' : 'one_time', interval: 'month', intervalCount: 1, trialDays: 0 }
    },
    customerInfo: { fullName: `Member ${seq}`, email: email || `member${seq}@example.test`, phone: '', country: '' },
    payment: {
      method: 'stripe',
      amount: 40,
      currency: 'gbp',
      status: paymentStatus,
      paidAt: paymentStatus === 'paid' ? start : null,
      stripeSessionId: sessionId,
      stripeSubscriptionId: subscriptionId,
      lastPaymentError: ''
    },
    subscription: pending
      ? { isActive: false, autoRenew: !!subscriptionId, cancelAtPeriodEnd: false, stripeStatus: '', renewals: [] }
      : { startDate: start, endDate, isActive: true, autoRenew: !!subscriptionId, cancelAtPeriodEnd, stripeStatus, renewals: [] },
    status,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

async function insert(options) {
  const doc = orderDoc(options);
  await PackageOrder.collection.insertOne(doc);
  return doc;
}

async function member(email, extra = {}) {
  const { Types } = h.state.mongoose;
  const doc = { _id: new Types.ObjectId(), firstName: 'Test', lastName: 'Member', email, role: 'user', isActive: true, ...extra };
  await User.collection.insertOne(doc);
  return doc;
}

/** A Stripe whose webhook signature check accepts 'good' against the gym's secret. */
function stripeFake(extra = {}) {
  return {
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 'good' || secret !== WEBHOOK_SECRET) throw new Error('No signatures found matching the expected signature for payload');
        return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body);
      }
    },
    ...extra
  };
}

function expiredSession(id, orderNumber, tenantSlug) {
  return {
    id,
    object: 'checkout.session',
    status: 'expired',
    payment_status: 'unpaid',
    client_reference_id: orderNumber,
    metadata: { type: 'gymfolio_package_subscription', orderNumber, tenantSlug }
  };
}

/** POST /api/gymfolio/payment/webhook/:slug, through its middleware, as Stripe sends it. */
function deliver(slug, type, object) {
  const body = Buffer.from(JSON.stringify({ id: `evt_${++seq}`, type, data: { object } }));
  return h.call((req, res) => middleware.tenantFromSlugParam(req, res, () => controller.handleWebhook(req, res)), {
    params: { slug },
    body,
    headers: { 'stripe-signature': 'good' }
  });
}

async function activePackage(price) {
  return Package.create({ name: price === '0' ? 'Open day' : 'Monthly', price, currency: 'GBP', period: 'month', features: ['Gym floor'], isActive: true });
}

/* -------------------------------- B1 -------------------------------- */

test('card is not offered, and a card checkout is refused, until the webhook secret is saved', async () => {
  await h.inGym(noWebhookGym, async () => {
    const methods = await h.call(controller.paymentMethods, {});
    assert.equal(methods.body.data.card, false);
    assert.equal(methods.body.data.cardUnavailable.code, 'STRIPE_WEBHOOK_NOT_CONFIGURED');
    assert.match(methods.body.data.cardUnavailable.reason, /Stripe/);

    const pkg = await activePackage('40');
    const res = await h.call(controller.createPackageCheckoutSession, {
      body: { packageId: String(pkg._id), customerInfo: { email: 'buyer@example.test', fullName: 'Buyer' } }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'STRIPE_WEBHOOK_NOT_CONFIGURED');
    assert.equal(await PackageOrder.countDocuments({}), 0, 'no pending order is left behind');
  });

  await h.inGym(gym, async () => {
    const methods = await h.call(controller.paymentMethods, {});
    assert.equal(methods.body.data.card, true);
    assert.equal(methods.body.data.cardUnavailable, null);
  });
});

test("the default gym's environment webhook secret counts", async () => {
  const saved = { ...process.env };
  process.env.DEFAULT_TENANT_SLUG = 'pay-nowebhook';
  // Its settings were sealed with its own key, not the legacy one a
  // default gym would otherwise switch to (services/secretBox.js).
  process.env.LEGACY_KEY_TENANT_SLUG = 'not-this-gym';
  process.env.STRIPE_SECRET_KEY = 'sk_test_env';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_env';
  try {
    await h.inGym(noWebhookGym, async () => {
      const methods = await h.call(controller.paymentMethods, {});
      assert.equal(methods.body.data.card, true);
    });
    // Never borrowed by another gym.
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await h.inGym(noWebhookGym, async () => {
      const methods = await h.call(controller.paymentMethods, {});
      assert.equal(methods.body.data.cardUnavailable.code, 'STRIPE_WEBHOOK_NOT_CONFIGURED');
    });
  } finally {
    for (const key of ['DEFAULT_TENANT_SLUG', 'LEGACY_KEY_TENANT_SLUG', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

/* -------------------------------- C9 -------------------------------- */

test('a free package is refused with a clear 400, and nothing reaches Stripe', async () => {
  const asked = [];
  h.setStripe(stripeFake({ checkout: { sessions: { create: async (p) => asked.push(p) } } }));
  try {
    await h.inGym(gym, async () => {
      const before = await PackageOrder.countDocuments({});
      const pkg = await activePackage('0');
      const res = await h.call(controller.createPackageCheckoutSession, {
        body: { packageId: String(pkg._id), customerInfo: { email: 'free@example.test', fullName: 'Free' } }
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'PACKAGE_NOT_PURCHASABLE');
      assert.match(res.body.message, /free/i);
      assert.equal(asked.length, 0);
      assert.equal(await PackageOrder.countDocuments({}), before);
    });
  } finally {
    h.setStripe(null);
  }
});

/* -------------------------------- C4 -------------------------------- */

test('checkout.session.expired closes the abandoned order and leaves a paid one alone', async () => {
  h.setStripe(stripeFake());
  try {
    let abandoned;
    let unsaved;
    let paid;
    await h.inGym(gym, async () => {
      abandoned = await insert({ status: 'pending', sessionId: 'cs_abandoned' });
      // The crash window: the session opened but its id never reached the order.
      unsaved = await insert({ status: 'pending' });
      paid = await insert({ sessionId: 'cs_paid' });
    });

    for (const [id, order] of [['cs_abandoned', abandoned], ['cs_unsaved', unsaved], ['cs_paid', paid]]) {
      const res = await deliver('pay-gym', 'checkout.session.expired', expiredSession(id, order.orderNumber, 'pay-gym'));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { received: true });
    }

    await h.inGym(gym, async () => {
      for (const order of [abandoned, unsaved]) {
        const after = await PackageOrder.findById(order._id).lean();
        assert.equal(after.status, 'cancelled');
        assert.equal(after.payment.status, 'failed');
        assert.match(after.payment.lastPaymentError, /expired/);
      }
      const still = await PackageOrder.findById(paid._id).lean();
      assert.equal(still.status, 'active');
      assert.equal(still.payment.status, 'paid');
    });

    // Delivered again (Stripe delivers at least once): nothing changes.
    const again = await deliver('pay-gym', 'checkout.session.expired', expiredSession('cs_abandoned', abandoned.orderNumber, 'pay-gym'));
    assert.equal(again.statusCode, 200);
  } finally {
    h.setStripe(null);
  }
});

/* -------------------------------- C3 -------------------------------- */

test("a lapsed gym's webhooks are still applied; a suspended gym's are refused for Stripe to retry", async () => {
  h.setStripe(stripeFake());
  try {
    let lapsedOrder;
    let suspendedOrder;
    await h.inGym(lapsedGym, async () => {
      lapsedOrder = await insert({ status: 'pending', sessionId: 'cs_lapsed' });
    });
    await h.inGym(suspendedGym, async () => {
      suspendedOrder = await insert({ status: 'pending', sessionId: 'cs_suspended' });
    });

    const lapsed = await deliver('pay-lapsed', 'checkout.session.expired', expiredSession('cs_lapsed', lapsedOrder.orderNumber, 'pay-lapsed'));
    assert.equal(lapsed.statusCode, 200);
    assert.deepEqual(lapsed.body, { received: true });

    const suspended = await deliver('pay-suspended', 'checkout.session.expired', expiredSession('cs_suspended', suspendedOrder.orderNumber, 'pay-suspended'));
    assert.equal(suspended.statusCode, 503, 'a 2xx would tell Stripe to stop retrying');
    assert.equal(suspended.body.code, 'TENANT_SUSPENDED');

    await h.inGym(lapsedGym, async () => {
      assert.equal((await PackageOrder.findById(lapsedOrder._id).lean()).status, 'cancelled');
    });
    await h.inGym(suspendedGym, async () => {
      assert.equal((await PackageOrder.findById(suspendedOrder._id).lean()).status, 'pending');
    });
  } finally {
    h.setStripe(null);
  }
});

/* -------------------------------- C7 -------------------------------- */

test('a renewing Stripe subscription has two days to settle; one told to stop, and past-due, are not stretched', async () => {
  const now = new Date();
  await h.inGym(sweepGym, async () => {
    const renewingHourAgo = await insert({ endDate: new Date(now - HOUR), subscriptionId: 'sub_settling' });
    const renewingDaysAgo = await insert({ endDate: new Date(now - 3 * DAY), subscriptionId: 'sub_never_paid' });
    const stopping = await insert({ endDate: new Date(now - HOUR), subscriptionId: 'sub_stopping', cancelAtPeriodEnd: true });
    const cancelledAtStripe = await insert({ endDate: new Date(now - HOUR), subscriptionId: 'sub_gone', stripeStatus: 'canceled' });
    const oneOff = await insert({ endDate: new Date(now - HOUR) });
    const pastDue = await insert({ status: 'past_due', endDate: new Date(now - 5 * DAY), subscriptionId: 'sub_retrying', stripeStatus: 'past_due' });

    await expiry.expireLapsedOrders(now);

    const status = async (doc) => (await PackageOrder.findById(doc._id).lean()).status;
    assert.equal(await status(renewingHourAgo), 'active', 'invoice.paid may still be on its way');
    assert.equal(await status(renewingDaysAgo), 'expired');
    assert.equal(await status(stopping), 'expired');
    assert.equal(await status(cancelledAtStripe), 'expired');
    assert.equal(await status(oneOff), 'expired');
    assert.equal(await status(pastDue), 'past_due', 'past due is Stripe\'s to end, not the calendar\'s');
    assert.equal(await expiry.countLapsed(now), 0);
  });
});

/* -------------------------------- C10 ------------------------------- */

test('"membership ended" goes out once, only for a membership that really ended', async () => {
  const now = new Date();
  await h.inGym(sweepGym, async () => {
    const ended = await member('ended@example.test');
    const renewed = await member('renewed@example.test');
    const closed = await member('closed@example.test', { isActive: false });

    const endedOrder = await insert({ userId: ended._id, email: ended.email, endDate: new Date(now - HOUR) });
    // Renewed early: the next term started when this one ended.
    const renewedOld = await insert({ userId: renewed._id, email: renewed.email, endDate: new Date(now - HOUR) });
    await insert({ userId: renewed._id, email: renewed.email, startDate: new Date(now - HOUR), endDate: new Date(now.getTime() + 29 * DAY) });
    const pack = await insert({ userId: ended._id, email: ended.email, kind: 'session_pack', endDate: new Date(now - HOUR) });
    const longAgo = await insert({ email: 'backlog@example.test', endDate: new Date(now - 40 * DAY) });
    const closedOrder = await insert({ userId: closed._id, email: closed.email, endDate: new Date(now - HOUR) });

    h.calls.notifications.length = 0;
    // Two sweeps at once (two instances, or the cron and a page load).
    const [a, b] = await Promise.all([expiry.expireLapsedOrders(now), expiry.expireLapsedOrders(now)]);
    assert.equal(a.expired + b.expired, 5);

    const told = h.calls.notifications.filter((c) => c.name === 'membershipExpired');
    assert.deepEqual(told.map((c) => c.args[0].orderNumber), [endedOrder.orderNumber]);
    assert.equal(String(told[0].args[1]._id), String(ended._id));

    for (const doc of [endedOrder, renewedOld, pack, longAgo, closedOrder]) {
      assert.equal((await PackageOrder.findById(doc._id).lean()).status, 'expired');
    }

    // And never again for the same lapse.
    const third = await expiry.expireLapsedOrders(now);
    assert.deepEqual(third, { expired: 0, notified: 0 });
    assert.equal(h.calls.notifications.filter((c) => c.name === 'membershipExpired').length, 1);
  });
});

/* -------------------------------- C6 -------------------------------- */

test("deleting an account can stop the member's Stripe subscriptions first", async () => {
  const asked = [];
  h.setStripe(
    stripeFake({
      subscriptions: {
        cancel: async (id) => {
          asked.push(id);
          if (id === 'sub_vanished') throw Object.assign(new Error(`No such subscription: '${id}'`), { code: 'resource_missing' });
          if (id === 'sub_outage') throw new Error('Stripe is having a moment');
          return { id, status: 'canceled' };
        }
      }
    })
  );
  try {
    await h.inGym(gym, async () => {
      const leaving = await member('leaving@example.test');
      const live = await insert({ userId: leaving._id, subscriptionId: 'sub_live' });
      const expiredButCharging = await insert({ userId: leaving._id, status: 'expired', endDate: new Date(Date.now() - 10 * DAY), subscriptionId: 'sub_zombie' });
      const vanished = await insert({ userId: leaving._id, subscriptionId: 'sub_vanished' });
      const alreadyStopped = await insert({ userId: leaving._id, status: 'cancelled', subscriptionId: 'sub_done', stripeStatus: 'canceled' });
      const oneOff = await insert({ userId: leaving._id });

      const result = await payments.cancelMemberSubscriptions(leaving._id, { source: 'member', by: leaving._id });
      assert.deepEqual(asked.sort(), ['sub_live', 'sub_vanished', 'sub_zombie']);
      assert.deepEqual(result.cancelled.sort(), [live.orderNumber, expiredButCharging.orderNumber, vanished.orderNumber].sort());

      const liveAfter = await PackageOrder.findById(live._id).lean();
      assert.equal(liveAfter.status, 'cancelled');
      assert.equal(liveAfter.subscription.isActive, false);
      assert.equal(liveAfter.subscription.stripeStatus, 'canceled');
      assert.ok(new Date(liveAfter.subscription.endDate) <= new Date(), 'access ends now');
      assert.equal(liveAfter.cancellation.source, 'member');
      assert.equal(liveAfter.cancellation.immediate, true);

      const zombieAfter = await PackageOrder.findById(expiredButCharging._id).lean();
      assert.equal(zombieAfter.status, 'expired', 'history is not rewritten');
      assert.equal(zombieAfter.subscription.stripeStatus, 'canceled');

      assert.equal((await PackageOrder.findById(alreadyStopped._id).lean()).status, 'cancelled');
      assert.equal((await PackageOrder.findById(oneOff._id).lean()).status, 'active', 'a one-off term is not a subscription');
    });

    // Nothing to stop: Stripe is not asked at all.
    await h.inGym(gym, async () => {
      const nobody = await member('no-subs@example.test');
      await insert({ userId: nobody._id });
      const before = h.calls.stripe.length;
      assert.deepEqual(await payments.cancelMemberSubscriptions(nobody._id), { cancelled: [] });
      assert.equal(h.calls.stripe.length, before);
    });

    // Stripe fails on one: the rest still stop, and the caller is told.
    await h.inGym(gym, async () => {
      const unlucky = await member('unlucky@example.test');
      const fine = await insert({ userId: unlucky._id, subscriptionId: 'sub_fine' });
      const stuck = await insert({ userId: unlucky._id, subscriptionId: 'sub_outage' });
      await assert.rejects(payments.cancelMemberSubscriptions(unlucky._id), (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.code, 'STRIPE_CANCEL_FAILED');
        assert.match(error.message, new RegExp(stuck.orderNumber));
        return true;
      });
      assert.equal((await PackageOrder.findById(fine._id).lean()).status, 'cancelled');
      assert.equal((await PackageOrder.findById(stuck._id).lean()).status, 'active');
    });
  } finally {
    h.setStripe(null);
  }
});
