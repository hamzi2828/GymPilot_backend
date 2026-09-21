// The member app after sign-in: the `app` claim its tokens carry, the
// add-on check middleware/auth repeats for those tokens (and only those),
// and taking a phone off a gym's push list without a live session. Pure
// logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const auth = require('../../src/middleware/auth');
const mobileAuth = require('../../src/controller/mobileAuthController');

function fakeRes() {
  const res = { statusCode: 200, body: null };
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

// Plans arrive populated here, so entitlements decides without a query.
const withoutApp = { slug: 'starter', price: 10, includedAddons: [] };
const withApp = { slug: 'pro', price: 50, includedAddons: ['member-app'] };

test('a token the member app is issued says so, beside the gym it belongs to', () => {
  const token = mobileAuth.issueToken({ _id: '000000000000000000000009', email: 'a@b.c', tokenVersion: 3 }, { _id: '000000000000000000000001' });
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  assert.equal(decoded.app, auth.MEMBER_APP_CLAIM);
  assert.equal(decoded.app, 'member');
  assert.equal(decoded.tid, '000000000000000000000001');
  assert.equal(decoded.tv, 3);
});

test('website and desktop tokens are never checked for the add-on', async () => {
  const gym = { _id: 'gym-web-only', plan: withoutApp };
  assert.equal(await auth.memberAppRefusal({ id: 'u1', tid: 'gym-web-only' }, { tenant: gym }), null);
  assert.equal(await auth.memberAppRefusal({ id: 'u1', app: 'desktop' }, { tenant: gym }), null);
});

test('a member-app token at a gym without the add-on is refused with the code the app knows', async () => {
  const refusal = await auth.memberAppRefusal({ id: 'u1', app: 'member' }, { tenant: { _id: 'gym-no-addon', plan: withoutApp } });
  assert.equal(refusal.code, 'MEMBER_APP_NOT_INCLUDED');
  assert.equal(refusal.success, false);
  assert.match(refusal.message, /member app/);
});

test('a member-app token passes at a gym with the add-on, bought or included, or on no plan', async () => {
  const member = { id: 'u1', app: 'member' };
  assert.equal(await auth.memberAppRefusal(member, { tenant: { _id: 'gym-included', plan: withApp } }), null);
  assert.equal(
    await auth.memberAppRefusal(member, { tenant: { _id: 'gym-bought', plan: withoutApp, subscription: { addons: [{ slug: 'member-app' }] } } }),
    null
  );
  assert.equal(await auth.memberAppRefusal(member, { tenant: { _id: 'gym-no-plan' } }), null);
  // No gym resolved: nothing to check against, so nothing is refused.
  assert.equal(await auth.memberAppRefusal(member, {}), null);
});

test('the answer is kept for a minute per gym, not asked on every request', async () => {
  const member = { id: 'u1', app: 'member' };
  assert.ok(await auth.memberAppRefusal(member, { tenant: { _id: 'gym-cached', plan: withoutApp } }));
  // The same gym, now with the add-on: still refused until the minute is up.
  assert.ok(await auth.memberAppRefusal(member, { tenant: { _id: 'gym-cached', plan: withApp } }));
});

test('taking a phone off the push list needs no sign-in, but does need the token and the gym', async () => {
  // No token.
  let res = fakeRes();
  await mobileAuth.unregisterPush({ body: {}, headers: { 'x-tenant-slug': 'demo' } }, res);
  assert.equal(res.statusCode, 400);

  // A token, but no gym named -- or one that could not be a slug.
  for (const headers of [{}, { 'x-tenant-slug': 'Not A Slug!' }]) {
    res = fakeRes();
    await mobileAuth.unregisterPush({ body: { token: 'ExponentPushToken[abc]' }, headers }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(headers));
    assert.equal(res.body.success, false);
  }
});

test('the unregister route is not behind auth; the register route still is', () => {
  const router = require('../../src/routes/mobileRoutes');
  const handlersFor = (method) => {
    const layer = router.stack.find((l) => l.route && l.route.path === '/push/register' && l.route.methods[method]);
    assert.ok(layer, `${method} /push/register exists`);
    return layer.route.stack.map((s) => s.handle);
  };
  assert.ok(handlersFor('post').includes(auth));
  assert.ok(!handlersFor('delete').includes(auth));
});
