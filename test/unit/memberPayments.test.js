// Member card payments, without a database or Stripe: when card is offered
// (keys AND webhook secret, the env counting for the default gym only), how
// the gym's webhook middleware treats a lapsed or suspended gym, what
// checkout.session.expired writes, and that a free package is a 400.
// Model statics and the Stripe client are stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
for (const key of ['DEFAULT_TENANT_SLUG', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY']) delete process.env[key];

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../../src/models/settings');
const { storage, runWithTenant } = require('../../src/platform/tenantContext');
const stripeClient = require('../../src/services/stripeClient');

// The real availability rules, kept before the payment service below is
// given stand-ins for them.
const { cardPaymentsStatus, assertCardPaymentsAvailable } = stripeClient;

// Stand-ins the modules under test pick up when they are first required.
const fakes = { gym: null, stripe: null, cardAvailable: true };
const resolveTenant = require('../../src/platform/middleware/resolveTenant');
resolveTenant.findGymBySlug = async (slug) => (fakes.gym && fakes.gym.slug === slug ? fakes.gym : null);
stripeClient.getStripe = async () => fakes.stripe;
stripeClient.assertCardPaymentsAvailable = async () => {
  if (!fakes.cardAvailable) throw new stripeClient.StripeNotConfiguredError();
};

const { tenantFromSlugParam, tenantFromStripeWebhook } = require('../../src/platform/middleware/tenantFromPayload');
const PackageOrder = require('../../src/gymfolio/models/packageOrderModel');
const Package = require('../../src/gymfolio/models/packageModel');
const payments = require('../../src/services/gymfolioPaymentService');
const { MembershipError } = require('../../src/gymfolio/services/membershipService');

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

// A gym context with an unconnected per-gym database (bufferCommands is
// off, so nothing waits on a server): model statics are stubbed per gym.
function inGym(slug, fn) {
  return runWithTenant({ _id: `unit-${slug}`, slug, database: { name: `gympilot_unit_${slug.replace(/-/g, '_')}` }, domains: [] }, fn);
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  return res;
}

/* ------------------------ card availability (B1) ------------------------ */

test('card needs the keys, the switch AND the webhook secret', async () => {
  const cases = [
    [{}, false, 'STRIPE_NOT_CONFIGURED'],
    [{ enabled: false, secretKey: 'sk', webhookSecret: 'whsec' }, false, 'STRIPE_NOT_CONFIGURED'],
    [{ enabled: true, secretKey: 'sk', webhookSecret: '' }, false, 'STRIPE_WEBHOOK_NOT_CONFIGURED'],
    [{ enabled: true, secretKey: 'sk', webhookSecret: 'whsec' }, true, null]
  ];
  await inGym('some-gym', async () => {
    for (const [stripe, available, code] of cases) {
      const restore = stub(Settings, { getSettings: async () => ({ stripe }) });
      try {
        const status = await cardPaymentsStatus();
        assert.equal(status.available, available, JSON.stringify(stripe));
        assert.equal(status.code, code);
        assert.equal(!!status.reason, !available, 'a reason whenever card is off');
        if (available) await assertCardPaymentsAvailable();
        else {
          await assert.rejects(assertCardPaymentsAvailable(), (error) => {
            assert.ok(error instanceof stripeClient.StripeNotConfiguredError);
            assert.equal(error.code, code);
            assert.equal(error.status, 409);
            return true;
          });
        }
      } finally {
        restore();
      }
    }
  });
});

test("the environment's webhook secret counts for the default gym, and for no other", async () => {
  // Neither gym has anything saved; only the environment could help.
  const noSettings = (fn) => async () => {
    const restore = stub(Settings, { getSettings: async () => ({ stripe: {} }) });
    try {
      return await fn();
    } finally {
      restore();
    }
  };
  process.env.DEFAULT_TENANT_SLUG = 'main';
  process.env.STRIPE_SECRET_KEY = 'sk_env';
  try {
    assert.equal((await inGym('main', noSettings(() => cardPaymentsStatus()))).code, 'STRIPE_WEBHOOK_NOT_CONFIGURED');
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_env';
    assert.equal((await inGym('main', noSettings(() => cardPaymentsStatus()))).available, true);
    assert.equal((await inGym('other-gym', noSettings(() => cardPaymentsStatus()))).available, false);
  } finally {
    delete process.env.DEFAULT_TENANT_SLUG;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

/* ------------------------- webhook middleware (C3) ----------------------- */

async function throughSlugMiddleware(gym) {
  fakes.gym = gym;
  const res = fakeRes();
  let reached = null;
  await tenantFromSlugParam({ params: { slug: gym.slug } }, res, () => {
    reached = storage.getStore();
  });
  return { res, reached };
}

test("a lapsed gym's webhook is still applied, in that gym's context", async () => {
  const { res, reached } = await throughSlugMiddleware({ slug: 'lapsed-gym', status: 'active', subscription: { status: 'expired' } });
  assert.ok(reached, 'the controller runs');
  assert.equal(reached.gym.slug, 'lapsed-gym');
  assert.equal(res.body, undefined);
});

test("a suspended gym's webhook is refused with a 503 so Stripe retries it", async () => {
  const { res, reached } = await throughSlugMiddleware({ slug: 'suspended-gym', status: 'suspended', subscription: { status: 'active' } });
  assert.equal(reached, null);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.received, false);
  assert.equal(res.body.code, 'TENANT_SUSPENDED');
});

test('the legacy webhook URL follows the same rule', async () => {
  fakes.gym = { slug: 'lapsed-legacy', status: 'active', subscription: { status: 'cancelled' } };
  const body = Buffer.from(JSON.stringify({ data: { object: { metadata: { tenantSlug: 'lapsed-legacy' } } } }));
  let reached = null;
  const res = fakeRes();
  await tenantFromStripeWebhook({ body }, res, () => {
    reached = storage.getStore();
  });
  assert.equal(reached && reached.gym.slug, 'lapsed-legacy');

  fakes.gym = { slug: 'suspended-legacy', status: 'suspended' };
  const refused = fakeRes();
  await tenantFromStripeWebhook({ body: Buffer.from(JSON.stringify({ data: { object: { metadata: { tenantSlug: 'suspended-legacy' } } } })) }, refused, () => {
    throw new Error('must not run');
  });
  assert.equal(refused.statusCode, 503);
});

test('an unknown gym is still a 404 on the per-gym URL', async () => {
  fakes.gym = null;
  const res = fakeRes();
  await tenantFromSlugParam({ params: { slug: 'nobody' } }, res, () => {
    throw new Error('must not run');
  });
  assert.equal(res.statusCode, 404);
});

/* --------------------- checkout.session.expired (C4) --------------------- */

test('checkout.session.expired closes the pending order, conditionally, and ignores other sessions', async () => {
  await inGym('expiry-gym', async () => {
    const order = { _id: 'order-1', orderNumber: 'PKG1', payment: { status: 'pending' } };
    const lookups = [];
    const writes = [];
    const restore = stub(PackageOrder, {
      findOne: async (filter) => {
        lookups.push(filter);
        return order;
      },
      findOneAndUpdate: async (filter, update) => {
        writes.push({ filter, update });
        return { ...order, status: 'cancelled' };
      }
    });
    try {
      const session = { id: 'cs_1', client_reference_id: 'PKG1', metadata: { type: 'gymfolio_package_subscription', orderNumber: 'PKG1' } };
      await payments.handleWebhook({ type: 'checkout.session.expired', data: { object: session } });
      assert.deepEqual(lookups[0], { $or: [{ 'payment.stripeSessionId': 'cs_1' }, { orderNumber: 'PKG1', 'payment.method': 'stripe' }] });
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].filter, { _id: 'order-1', 'payment.status': 'pending' });
      assert.equal(writes[0].update.$set.status, 'cancelled');
      assert.equal(writes[0].update.$set['payment.status'], 'failed');

      // Someone else's checkout (the platform's own signup, say): untouched.
      await payments.handleWebhook({ type: 'checkout.session.expired', data: { object: { id: 'cs_2', metadata: { type: 'platform_signup' } } } });
      assert.equal(lookups.length, 1);

      // Already paid by the time the expiry lands: untouched.
      order.payment.status = 'paid';
      await payments.handleWebhook({ type: 'checkout.session.expired', data: { object: session } });
      assert.equal(writes.length, 1);
    } finally {
      restore();
    }
  });
});

/* ------------------------------ free (C9) ------------------------------- */

test('a free package, or one with no readable price, is a 400 with a clear message', async () => {
  fakes.stripe = {};
  await inGym('free-gym', async () => {
    for (const [price, pattern] of [['0', /free/i], ['Free', /cannot be bought online/i]]) {
      const restore = stub(Package, { findById: async () => ({ _id: 'p1', name: 'Open day', price, isActive: true }) });
      try {
        await assert.rejects(payments.createPackageCheckoutSession(null, 'p1', { email: 'a@example.test' }), (error) => {
          assert.ok(error instanceof MembershipError);
          assert.equal(error.status, 400);
          assert.equal(error.code, 'PACKAGE_NOT_PURCHASABLE');
          assert.match(error.message, pattern);
          assert.match(error.message, /front desk/);
          return true;
        });
      } finally {
        restore();
      }
    }
  });
});

test('a missing or inactive package is a 404, and card being off is refused before anything else', async () => {
  await inGym('free-gym', async () => {
    const restore = stub(Package, { findById: async () => null });
    try {
      await assert.rejects(payments.createPackageCheckoutSession(null, 'p1', { email: 'a@example.test' }), (error) => error.status === 404);
      fakes.cardAvailable = false;
      await assert.rejects(payments.createPackageCheckoutSession(null, 'p1', { email: 'a@example.test' }), (error) => error.code === 'STRIPE_NOT_CONFIGURED');
    } finally {
      fakes.cardAvailable = true;
      restore();
    }
  });
});
