// Tenant resolution and context: pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const { candidateHosts } = require('../../src/platform/middleware/resolveTenant');
const { runWithTenant, currentTenant, frontendOrigin, tenantTimezone, originForHost } = require('../../src/platform/tenantContext');
const { tenantModel, registeredModelNames } = require('../../src/platform/modelRegistry');

test('hosts are normalised the same way everywhere', () => {
  assert.equal(Gym.normalizeHost('https://WWW.Example.com/path?x=1'), 'example.com');
  assert.equal(Gym.normalizeHost('localhost:3000'), 'localhost:3000');
  assert.equal(Gym.normalizeHost('example.com.'), 'example.com');
  assert.equal(Gym.normalizeHost(''), '');
});

test('candidate hosts come in precedence order without duplicates', () => {
  const req = {
    headers: { 'x-tenant-host': 'a.com', origin: 'https://www.a.com', host: 'api.platform.com' },
    query: { tenantHost: 'b.com' }
  };
  assert.deepEqual(candidateHosts(req), ['a.com', 'b.com', 'api.platform.com']);
});

test('access is blocked for suspended and lapsed gyms only', () => {
  assert.equal(Gym.accessBlock({ status: 'active', subscription: { status: 'active' } }), null);
  assert.equal(Gym.accessBlock({ status: 'active', subscription: { status: 'past_due' } }), null);
  assert.equal(Gym.accessBlock({ status: 'suspended' }).code, 'TENANT_SUSPENDED');
  assert.equal(Gym.accessBlock({ status: 'active', subscription: { status: 'expired' } }).code, 'SUBSCRIPTION_INACTIVE');
  assert.equal(Gym.accessBlock(null).code, 'TENANT_NOT_FOUND');
});

test('origins are https except for local development hosts', () => {
  assert.equal(originForHost('gym.com'), 'https://gym.com');
  assert.equal(originForHost('localhost:3000'), 'http://localhost:3000');
  assert.equal(originForHost(''), null);
});

test('a tenant model refuses to work outside a context', () => {
  const User = require('../../src/models/user');
  assert.throws(() => User.find(), /outside a tenant context/);
  assert.ok(registeredModelNames().includes('User'));
});

test('runWithTenant binds the gym for the duration of the call', async () => {
  const gym = { _id: '000000000000000000000001', slug: 'unit-gym', database: { name: 'gympilot_unit_gym' }, domains: [{ host: 'unit.gym', isPrimary: true }], locale: { timezone: 'Europe/London' } };
  await runWithTenant(gym, async () => {
    assert.equal(currentTenant().slug, 'unit-gym');
    assert.equal(frontendOrigin(), 'https://unit.gym');
    assert.equal(tenantTimezone(), 'Europe/London');
    const Fake = tenantModel('UnitFake', new (require('mongoose').Schema)({ a: String }));
    assert.equal(Fake.modelName, 'UnitFake');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(currentTenant().slug, 'unit-gym', 'context survives an await');
  });
  assert.equal(currentTenant(), null);
});
