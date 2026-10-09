// Provisioning a gym end to end, minus the database: database names that
// fit every cluster, slugs that survive being cut, a gym refused when the
// website could not be reached on it, domains put on the website host with
// what is left to do, the owner's invite on a host that answers, the owner
// kept out of the plan's staff seats, and a Stripe-billed gym's price moved
// on Stripe before it is moved here.
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.PLATFORM_DB_NAME;
delete process.env.TENANT_DB_PREFIX;
delete process.env.PLATFORM_ROOT_DOMAIN;
delete process.env.DEFAULT_TENANT_SLUG;
delete process.env.FRONTEND_ORIGIN;
delete process.env.VERCEL_TOKEN;
delete process.env.VERCEL_PROJECT_ID;

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { tenantDatabaseNameFor, MAX_DATABASE_NAME_LENGTH } = require('../../src/platform/dbNames');
const {
  uniqueDatabaseNameFor,
  validateDatabaseInput,
  freeSlugFrom,
  provisionGym,
  connectDomainsToWebsite,
  ProvisioningError
} = require('../../src/platform/provisioning');
const { inviteSiteUrlFor } = require('../../src/platform/tenantContext');
const vercel = require('../../src/platform/vercelDomains');
const { staffCountFilter } = require('../../src/platform/planLimits');
const { syncStripeSubscription, changesPrice, stripeLinesFor, SubscriptionSyncError } = require('../../src/platform/services/subscriptionSync');
const Gym = require('../../src/platform/models/gymModel');

// The slug lookups provisioning makes before it writes anything, answered
// with "nothing taken".
Gym.find = () => ({ select: () => ({ lean: async () => [] }) });
Gym.findOne = () => ({ select: () => ({ lean: async () => null }) });

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

test('a long gym name still makes a database name every cluster accepts', () => {
  const slug = 'the-very-long-named-iron-works-fitness-and-boxing-club'.slice(0, 44);
  const name = uniqueDatabaseNameFor(slug);
  assert.ok(name.length <= MAX_DATABASE_NAME_LENGTH, `${name} is ${name.length}`);
  assert.ok(name.startsWith('gympilot_unit_tests_'), name);
  assert.match(name, /_[0-9a-f]{6}$/);
  // Cut, never left ending on a separator before the id.
  assert.doesNotMatch(tenantDatabaseNameFor('abcdefghijklmnopq-rstuvwxyz', 'abc123'), /[-_]_abc123$/);
  // A short one is left alone.
  assert.equal(tenantDatabaseNameFor('iron', 'abc123'), 'gympilot_unit_tests_iron_abc123');
});

test('the API refuses a database name that is too long or not a name at all, with a reason', () => {
  const long = `gympilot_unit_tests_${'x'.repeat(40)}`;
  assert.throws(() => validateDatabaseInput({ name: long }), (e) => e instanceof ProvisioningError && e.status === 400 && /at most 38 characters/.test(e.message));
  assert.throws(() => validateDatabaseInput({ name: 'gympilot_unit_tests_iron.works' }), (e) => e.status === 400 && /not a valid database name/.test(e.message));
  assert.deepEqual(validateDatabaseInput({ name: 'gympilot_unit_tests_iron_abc123' }), { name: 'gympilot_unit_tests_iron_abc123', uri: '' });
});

test('a slug cut to length never ends on a hyphen', async () => {
  // 43 letters, a space, then more: the 44-character cut lands on the hyphen.
  const slug = await freeSlugFrom(`${'a'.repeat(43)} bcd`);
  assert.equal(slug, 'a'.repeat(43));
  assert.ok(Gym.SLUG_PATTERN.test(slug));
});

test('a gym the website could not be reached on is refused before anything is written', async () => {
  const input = { name: 'Iron Works', owner: { email: 'owner@ironworks.com', password: 'a strong password' } };
  await withEnv({ PLATFORM_ROOT_DOMAIN: undefined, DEFAULT_TENANT_SLUG: undefined }, () =>
    assert.rejects(provisionGym(input, { enforceDatabasePolicy: true, requireSite: true }), (e) => e instanceof ProvisioningError && e.status === 400 && /no web address/.test(e.message))
  );
});

test("the owner's invite opens on the platform subdomain, which answers before the owner's DNS does", () => {
  const gym = {
    slug: 'ironworks',
    domains: [
      { host: 'ironworks.com', isPrimary: true },
      { host: 'ironworks.gympilot.app', isPrimary: false }
    ]
  };
  withEnv({ PLATFORM_ROOT_DOMAIN: 'gympilot.app', DEFAULT_TENANT_SLUG: undefined, FRONTEND_ORIGIN: undefined }, () => {
    assert.equal(inviteSiteUrlFor(gym), 'https://ironworks.gympilot.app');
    // Not registered on this gym (another holds it): its own domain instead.
    assert.equal(inviteSiteUrlFor({ ...gym, domains: [gym.domains[0]] }), 'https://ironworks.com');
  });
  withEnv({ PLATFORM_ROOT_DOMAIN: undefined, DEFAULT_TENANT_SLUG: undefined }, () => {
    assert.equal(inviteSiteUrlFor(gym), 'https://ironworks.com');
  });
  // The default gym keeps the address the single-gym deployment always used.
  withEnv({ PLATFORM_ROOT_DOMAIN: 'gympilot.app', DEFAULT_TENANT_SLUG: 'ironworks', FRONTEND_ORIGIN: 'http://localhost:3000' }, () => {
    assert.equal(inviteSiteUrlFor(gym), 'http://localhost:3000');
  });
  // A *.localhost host with a port is served over plain http.
  withEnv({ PLATFORM_ROOT_DOMAIN: undefined, DEFAULT_TENANT_SLUG: undefined }, () => {
    assert.equal(inviteSiteUrlFor({ slug: 'iron', domains: [{ host: 'iron.localhost:3000', isPrimary: true }] }), 'http://iron.localhost:3000');
  });
});

test('a root domain goes on the website host with its www twin; a subdomain alone', () => {
  assert.equal(vercel.isApex('ironworks.com'), true);
  assert.equal(vercel.isApex('ironworks.com.pk'), true);
  assert.equal(vercel.isApex('app.ironworks.com'), false);
  assert.equal(vercel.isApex('localhost:3000'), false);
  assert.equal(vercel.wwwTwinOf('ironworks.co.uk'), 'www.ironworks.co.uk');
  assert.equal(vercel.wwwTwinOf('ironworks.gympilot.app'), null);
  assert.deepEqual(
    [vercel.dnsAdvice('ironworks.com.pk').type, vercel.dnsAdvice('www.ironworks.com.pk').name, vercel.dnsAdvice('a.b.ironworks.com').name],
    ['A', 'www', 'a.b']
  );
});

test('domains typed in at creation reach the website host, and what is left to do is said', async () => {
  const added = [];
  const fake = {
    configured: () => true,
    addDomain: async (host) => {
      added.push(host);
      if (host === 'ironworks.com') {
        return {
          host,
          added: true,
          verified: true,
          dns: vercel.dnsAdvice(host),
          www: { host: 'www.ironworks.com', added: true, verified: false, verification: [{ type: 'TXT', domain: '_vercel.ironworks.com', value: 'vc-domain-verify=abc' }] }
        };
      }
      if (host === 'broken.example') return { host, added: false, error: 'Invalid domain' };
      return { host, added: true, verified: true, dns: vercel.dnsAdvice(host) };
    }
  };
  const warnings = await connectDomainsToWebsite(['ironworks.com', 'ironworks.gympilot.app', 'broken.example', 'iron.localhost:3000'], {
    platformHost: 'ironworks.gympilot.app',
    vercel: fake
  });
  assert.deepEqual(added, ['ironworks.com', 'ironworks.gympilot.app', 'broken.example']);
  assert.ok(warnings.some((w) => /www\.ironworks\.com .*verified.*TXT record _vercel\.ironworks\.com = vc-domain-verify=abc/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /^Point ironworks\.com at the website: create a DNS A record for @ pointing to 76\.76\.21\.21 \(and a CNAME record for www/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /broken\.example could not be added to the website host: Invalid domain/.test(w)));
  // The platform subdomain's DNS is ours: no instruction for the owner.
  assert.ok(!warnings.some((w) => w.startsWith('Point ironworks.gympilot.app')));

  const offline = await connectDomainsToWebsite(['ironworks.com', 'ironworks.gympilot.app'], {
    platformHost: 'ironworks.gympilot.app',
    vercel: { configured: () => false, addDomain: async () => assert.fail('not connected: nothing is added') }
  });
  assert.equal(offline.length, 2);
  assert.match(offline[0], /not connected .* ironworks\.com was not added/);
  assert.match(offline[1], /wildcard domain for \*\.gympilot\.app/);
  assert.deepEqual(await connectDomainsToWebsite(['localhost:3000'], { vercel: fake }), []);
});

test("the owner does not take one of the plan's staff seats", () => {
  assert.deepEqual(staffCountFilter({ owner: { email: ' Owner@IronWorks.com ' } }), { 'employment.isStaff': true, email: { $ne: 'owner@ironworks.com' } });
  assert.deepEqual(staffCountFilter({ owner: { email: '' } }), { 'employment.isStaff': true });
  assert.deepEqual(staffCountFilter(null), { 'employment.isStaff': true });
});

const plan = { _id: 'p2', name: 'Growth', slug: 'growth', price: { currency: 'PKR' } };
const before = { billingCycle: 'monthly', currency: 'PKR', planAmount: 5000, addons: [{ slug: 'member-app', name: 'Member app', amount: 1500 }] };

test('only a change to what the gym is charged counts as a price change', () => {
  assert.equal(changesPrice(before, { ...before, notes: 'x', status: 'active' }, 'p1', 'p1'), false);
  assert.equal(changesPrice(before, before, 'p1', 'p2'), true);
  assert.equal(changesPrice(before, { ...before, billingCycle: 'yearly' }, 'p1', 'p1'), true);
  assert.equal(changesPrice(before, { ...before, planAmount: 6000 }, 'p1', 'p1'), true);
  assert.equal(changesPrice(before, { ...before, addons: [] }, 'p1', 'p1'), true);
  assert.deepEqual(stripeLinesFor(plan, { ...before, addons: [...before.addons, { slug: 'kiosk', name: 'Kiosk', amount: 0 }] }), [
    { name: 'Growth (GymPilot)', amount: 5000 },
    { name: 'Member app (GymPilot)', amount: 1500 }
  ]);
});

function fakeStripe({ status = 'active', currency = 'pkr' } = {}) {
  const calls = { updates: [], products: [] };
  return {
    calls,
    subscriptions: {
      retrieve: async () => ({
        id: 'sub_1',
        status,
        currency,
        metadata: { gymId: 'g1' },
        items: { data: [{ id: 'si_plan', price: { product: { id: 'prod_growth', name: 'Growth (GymPilot)', active: true } } }] }
      }),
      update: async (id, params) => {
        calls.updates.push({ id, params });
        return { id };
      }
    },
    products: {
      create: async (params) => {
        calls.products.push(params);
        return { id: `prod_${calls.products.length}` };
      }
    }
  };
}

test("a Stripe-billed gym's new price is put on its Stripe subscription, prorated", async () => {
  const stripe = fakeStripe();
  const gym = { _id: 'g1', slug: 'ironworks', subscription: { stripeSubscriptionId: 'sub_1' } };
  const next = { ...before, billingCycle: 'yearly', planAmount: 50000, addons: [{ slug: 'member-app', name: 'Member app', amount: 15000 }] };
  const result = await syncStripeSubscription({ gym, plan, next, stripe });

  assert.equal(result.synced, true);
  assert.match(result.summary, /^Growth \+ Member app · PKR 65,000 \/ year$/);
  const [{ id, params }] = stripe.calls.updates;
  assert.equal(id, 'sub_1');
  assert.equal(params.proration_behavior, 'create_prorations');
  assert.equal(params.payment_behavior, 'error_if_incomplete');
  assert.deepEqual(params.items[0], { id: 'si_plan', deleted: true });
  // The plan keeps its product; the add-on it never had gets one.
  assert.deepEqual(params.items[1].price_data, { currency: 'pkr', product: 'prod_growth', unit_amount: 5000000, recurring: { interval: 'year' } });
  assert.equal(params.items[2].price_data.product, 'prod_1');
  assert.equal(stripe.calls.products[0].name, 'Member app (GymPilot)');
  assert.equal(params.metadata.planSlug, 'growth');
  assert.equal(params.metadata.billingCycle, 'yearly');
});

test('a price change Stripe cannot make is refused, and nothing is sent', async () => {
  const gym = { _id: 'g1', slug: 'ironworks', subscription: { stripeSubscriptionId: 'sub_1' } };
  const usd = fakeStripe({ currency: 'usd' });
  await assert.rejects(syncStripeSubscription({ gym, plan, next: before, stripe: usd }), (e) => e instanceof SubscriptionSyncError && /cannot change currency/.test(e.message));
  assert.equal(usd.calls.updates.length, 0);

  await assert.rejects(syncStripeSubscription({ gym, plan: null, next: before, stripe: fakeStripe() }), /Cancel its Stripe subscription/);
  await assert.rejects(syncStripeSubscription({ gym, plan, next: { ...before, planAmount: 0, addons: [] }, stripe: fakeStripe() }), /comes to nothing/);

  const failing = fakeStripe();
  failing.subscriptions.update = async () => {
    const error = new Error('Your card was declined.');
    error.type = 'StripeCardError';
    throw error;
  };
  await assert.rejects(syncStripeSubscription({ gym, plan, next: { ...before, planAmount: 6000 }, stripe: failing }), (e) => e.status === 409 && /declined/.test(e.message));

  // A subscription that has ended charges nothing: only the record changes.
  const ended = fakeStripe({ status: 'canceled' });
  assert.equal((await syncStripeSubscription({ gym, plan, next: before, stripe: ended })).synced, false);
  assert.equal(ended.calls.updates.length, 0);
  // Not billed through Stripe at all: nothing to do.
  assert.equal((await syncStripeSubscription({ gym: { subscription: {} }, plan, next: before })).synced, false);
});

test('a timezone the server cannot keep time in is refused before the gym is made', async () => {
  const { validTimezone } = require('../../src/platform/provisioning');
  assert.equal(validTimezone('Asia/Karachi'), 'Asia/Karachi');
  assert.equal(validTimezone(' Europe/London '), 'Europe/London');
  // Nothing given: UTC, as before.
  assert.equal(validTimezone(''), 'UTC');
  assert.equal(validTimezone(undefined), 'UTC');
  for (const bad of ['PKT', 'Karachi', 'Asia/Lahore', 'GMT+5:00:00']) {
    assert.throws(() => validTimezone(bad), (e) => e instanceof ProvisioningError && e.status === 400 && /not a timezone this server knows/.test(e.message), bad);
  }

  // Saved on a gym, "PKT" would make every attendance call it serves throw.
  let created = 0;
  const create = Gym.create;
  Gym.create = async () => {
    created += 1;
    throw new Error('must not be reached');
  };
  try {
    await assert.rejects(
      provisionGym({ name: 'Iron Works', owner: { email: 'owner@ironworks.com', password: 'a strong password' }, locale: { timezone: 'PKT', currency: 'PKR' } }),
      (e) => e instanceof ProvisioningError && e.status === 400 && /"PKT" is not a timezone/.test(e.message)
    );
    assert.equal(created, 0);
  } finally {
    Gym.create = create;
  }
});
