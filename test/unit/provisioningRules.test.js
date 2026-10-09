// Provisioning rules: reserved web addresses, the platform subdomain, where a
// gym's website is, what a caller may say about its database, what of its
// locale reaches Settings, and the owner's set-password link. No database.
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.PLATFORM_DB_NAME;
delete process.env.TENANT_DB_PREFIX;
delete process.env.PLATFORM_ROOT_DOMAIN;
delete process.env.ALLOW_DEDICATED_DB_URI;

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { RESERVED_SLUGS, isReservedSlug, validateDatabaseInput, localeSettingsFor, ProvisioningError } = require('../../src/platform/provisioning');
const { subdomainHostFor, siteUrlFor, runWithTenant, frontendOrigin } = require('../../src/platform/tenantContext');
const { setPasswordLink } = require('../../src/platform/ownerInvite');
const { validateDemoRequest } = require('../../src/platform/controllers/demoRequestsController');

// Runs fn with these env values, restoring the old ones afterwards -- after
// the promise settles when fn is async.
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

test('labels that already mean something under the root domain are reserved', () => {
  for (const slug of ['api', 'www', 'app', 'admin', 'mail', 'platform', 'static', 'assets', 'cdn', 'help', 'support', 'docs', 'blog', 'status', 'login', 'checkout', 'panel']) {
    assert.ok(RESERVED_SLUGS.has(slug), slug);
    assert.equal(isReservedSlug(slug), true);
  }
  assert.equal(isReservedSlug('Admin '), true);
  assert.equal(isReservedSlug('admin-gym'), false);
  assert.equal(isReservedSlug('ironworks'), false);
  assert.equal(isReservedSlug(''), false);
});

test('the platform subdomain is <slug>.<root>, and nothing without a root', () => {
  assert.equal(subdomainHostFor('ironworks', 'gympilot.app'), 'ironworks.gympilot.app');
  assert.equal(subdomainHostFor('IronWorks', 'https://GymPilot.app/'), 'ironworks.gympilot.app');
  assert.equal(subdomainHostFor('ironworks', ''), null);
  assert.equal(subdomainHostFor('', 'gympilot.app'), null);
  withEnv({ PLATFORM_ROOT_DOMAIN: 'gympilot.app' }, () => assert.equal(subdomainHostFor('ironworks'), 'ironworks.gympilot.app'));
  withEnv({ PLATFORM_ROOT_DOMAIN: undefined }, () => assert.equal(subdomainHostFor('ironworks'), null));
});

test("a gym's website is its primary domain, else its subdomain, else the env fallback", () => {
  const withDomain = { slug: 'ironworks', domains: [{ host: 'www.other.com' }, { host: 'ironworks.com', isPrimary: true }] };
  const bare = { slug: 'ironworks', domains: [] };

  withEnv({ PLATFORM_ROOT_DOMAIN: 'gympilot.app', FRONTEND_ORIGIN: 'https://fallback.example/', DEFAULT_TENANT_SLUG: undefined }, () => {
    assert.equal(siteUrlFor(withDomain), 'https://ironworks.com');
    assert.equal(siteUrlFor(bare), 'https://ironworks.gympilot.app');
  });
  withEnv({ PLATFORM_ROOT_DOMAIN: undefined, FRONTEND_ORIGIN: 'https://fallback.example/', DEFAULT_TENANT_SLUG: undefined }, () => {
    assert.equal(siteUrlFor(bare), 'https://fallback.example');
  });
  withEnv({ PLATFORM_ROOT_DOMAIN: undefined, FRONTEND_ORIGIN: undefined, DEFAULT_TENANT_SLUG: undefined }, () => {
    assert.equal(siteUrlFor(bare), 'http://localhost:3000');
  });
  // The default gym keeps the env origin even with a registered domain.
  withEnv({ PLATFORM_ROOT_DOMAIN: 'gympilot.app', FRONTEND_ORIGIN: 'http://localhost:3000', DEFAULT_TENANT_SLUG: 'ironworks' }, () => {
    assert.equal(siteUrlFor(withDomain), 'http://localhost:3000');
  });
  // Local roots are served over plain http.
  withEnv({ PLATFORM_ROOT_DOMAIN: 'gyms.localhost', FRONTEND_ORIGIN: undefined, DEFAULT_TENANT_SLUG: undefined }, () => {
    assert.equal(siteUrlFor(bare), 'http://ironworks.gyms.localhost');
  });
});

test('frontendOrigin() inside a context prefers the subdomain to the env fallback', async () => {
  const gym = { _id: '000000000000000000000002', slug: 'unit-sub', database: { name: 'gympilot_unit_sub' }, domains: [] };
  await withEnv({ PLATFORM_ROOT_DOMAIN: 'gympilot.app', FRONTEND_ORIGIN: 'https://fallback.example', DEFAULT_TENANT_SLUG: undefined }, () =>
    runWithTenant(gym, async () => assert.equal(frontendOrigin(), 'https://unit-sub.gympilot.app'))
  );
});

test('the API only accepts fresh databases under the tenant prefix, and no dedicated URI unless allowed', () => {
  assert.deepEqual(validateDatabaseInput(undefined), { name: '', uri: '' });
  assert.deepEqual(validateDatabaseInput({ name: 'gympilot_unit_tests_iron_abc123' }), { name: 'gympilot_unit_tests_iron_abc123', uri: '' });
  assert.throws(() => validateDatabaseInput({ name: 'gympilot_unit_tests' }), (e) => e instanceof ProvisioningError && /platform's own database/.test(e.message));
  assert.throws(() => validateDatabaseInput({ name: 'admin' }), ProvisioningError);
  assert.throws(() => validateDatabaseInput({ name: 'somewhere_else' }), (e) => e.status === 400 && /must start with "gympilot_unit_tests_"/.test(e.message));
  assert.throws(() => validateDatabaseInput({ uri: 'mongodb://elsewhere/db' }), (e) => e.status === 400 && /ALLOW_DEDICATED_DB_URI/.test(e.message));
  assert.deepEqual(validateDatabaseInput({ name: 'anything', uri: 'mongodb://elsewhere/db' }, { allowDedicatedUri: true }), { name: 'anything', uri: 'mongodb://elsewhere/db' });
  withEnv({ ALLOW_DEDICATED_DB_URI: '1' }, () => assert.equal(validateDatabaseInput({ uri: 'mongodb://elsewhere/db' }).uri, 'mongodb://elsewhere/db'));
});

test('the currency reaches Settings whenever it is a real code; the country only as ISO-2', () => {
  assert.deepEqual(localeSettingsFor({ currency: 'gbp', country: 'gb' }), { currency: 'GBP', country: 'GB' });
  assert.deepEqual(localeSettingsFor({ currency: 'PKR', country: 'Karachi, Pakistan' }), { currency: 'PKR' });
  assert.deepEqual(localeSettingsFor({ currency: 'dollars', country: 'US' }), { country: 'US' });
  assert.deepEqual(localeSettingsFor({ currency: 'AED', country: 'AE' }, { hasCountry: false }), { currency: 'AED' });
  assert.deepEqual(localeSettingsFor(null), {});
});

test('the set-password link has the same shape as a forgot-password link', () => {
  const link = setPasswordLink('https://ironworks.gympilot.app/', 'abc/def', 'owner@yourgym.com');
  assert.equal(link, 'https://ironworks.gympilot.app/authentication?mode=reset&token=abc%2Fdef&email=owner%40yourgym.com');
});

test('checkout keeps first and last name apart and still fills in the single name', () => {
  const result = validateDemoRequest({ kind: 'trial', firstName: ' Aisha ', lastName: 'Khan', email: 'a@b.co', gymName: 'Iron Works' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.firstName, 'Aisha');
  assert.equal(result.data.lastName, 'Khan');
  assert.equal(result.data.name, 'Aisha Khan');

  const demo = validateDemoRequest({ name: 'Bilal Ahmed', email: 'a@b.co', gymName: 'Iron Works' });
  assert.equal(demo.data.name, 'Bilal Ahmed');
  assert.equal(demo.data.firstName, '');
});

test('in production nothing falls back to localhost: a gym with no address gets no address, and admin emails no panel link', () => {
  const { localFallback } = require('../../src/platform/tenantContext');
  const { panelUrl, panelLink } = require('../../src/platform/controllers/demoRequestsController');
  const bare = { slug: 'ironworks', domains: [] };
  const nothing = { PLATFORM_ROOT_DOMAIN: undefined, FRONTEND_ORIGIN: undefined, DEFAULT_TENANT_SLUG: undefined, PLATFORM_ADMIN_ORIGIN: undefined };

  assert.equal(localFallback('http://localhost:3000', { NODE_ENV: 'production' }), null);
  assert.equal(localFallback('http://localhost:3000', { NODE_ENV: 'development' }), 'http://localhost:3000');
  assert.equal(localFallback('http://localhost:3000', {}), 'http://localhost:3000');

  const error = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    withEnv({ ...nothing, NODE_ENV: 'production' }, () => {
      assert.equal(siteUrlFor(bare), '');
      assert.equal(siteUrlFor(bare), '');
      assert.equal(logged.filter((line) => /ironworks has no web address/.test(line)).length, 1, 'said once');
      assert.equal(panelUrl(), '');
      assert.equal(panelLink('See it in the panel: '), '');
      assert.ok(logged.some((line) => /PLATFORM_ADMIN_ORIGIN is not set/.test(line)));
    });
    // What is configured is still used, in production as anywhere.
    withEnv({ ...nothing, NODE_ENV: 'production', PLATFORM_ROOT_DOMAIN: 'gympilot.app', PLATFORM_ADMIN_ORIGIN: 'https://gympilot.app, https://www.gympilot.app' }, () => {
      assert.equal(siteUrlFor(bare), 'https://ironworks.gympilot.app');
      assert.equal(siteUrlFor({ slug: 'ironworks', domains: [{ host: 'ironworks.com', isPrimary: true }] }), 'https://ironworks.com');
      assert.equal(panelUrl(), 'https://gympilot.app/super-admin/demo-requests');
      assert.match(panelLink('See it in the panel: '), /See it in the panel: <a href="https:\/\/gympilot\.app\/super-admin\/demo-requests">/);
    });
    // On a developer's machine, localhost as before.
    withEnv({ ...nothing, NODE_ENV: undefined }, () => {
      assert.equal(siteUrlFor(bare), 'http://localhost:3000');
      assert.equal(panelUrl(), 'http://localhost:3001/super-admin/demo-requests');
    });
  } finally {
    console.error = error;
  }
});
