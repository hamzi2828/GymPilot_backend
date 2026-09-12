// The phone app's sign-in surface: the codes middleware/auth answers with,
// what the mobile routes refuse before touching a database, and the push
// token model. Pure logic, no database.
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
const { registeredModelNames } = require('../../src/platform/modelRegistry');

/** A res that records what it was told. */
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

async function runAuth(headers, tenant) {
  const req = { headers, tenant };
  const res = fakeRes();
  let passed = false;
  await auth(req, res, () => {
    passed = true;
  });
  return { res, passed, req };
}

test('a request with no token is refused as TOKEN_MISSING', async () => {
  const { res, passed } = await runAuth({});
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'TOKEN_MISSING');
  assert.equal(res.body.message, 'Authorization token required');
});

test('an unreadable token is refused as TOKEN_INVALID', async () => {
  const { res, passed } = await runAuth({ authorization: 'Bearer not-a-token' });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'TOKEN_INVALID');
});

test('a platform (super admin) token is refused as TOKEN_INVALID', async () => {
  const token = jwt.sign({ id: '000000000000000000000009', scope: 'platform' }, process.env.JWT_SECRET);
  const { res, passed } = await runAuth({ authorization: `Bearer ${token}` });
  assert.equal(passed, false);
  assert.equal(res.body.code, 'TOKEN_INVALID');
});

test("a token issued by another gym is refused as TOKEN_WRONG_GYM, with the member's message kept", async () => {
  const token = jwt.sign({ id: '000000000000000000000009', tid: '000000000000000000000001' }, process.env.JWT_SECRET);
  const { res, passed } = await runAuth({ authorization: `Bearer ${token}` }, { _id: '000000000000000000000002' });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'TOKEN_WRONG_GYM');
  assert.match(res.body.message, /different gym/);
});

test('the second sign-in step refuses an incomplete request before looking anything up', async () => {
  for (const body of [{}, { challengeId: 'abc' }, { challengeId: 'abc', code: '123456' }, { code: '123456', gym: 'demo' }]) {
    const res = fakeRes();
    await mobileAuth.verifyTwoFactor({ body }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.success, false);
    // Never a sign-out code: a bad code must not end an app session.
    assert.equal(res.body.code, undefined);
  }
});

test('forgot-password refuses an empty username and never names a reason otherwise', async () => {
  const res = fakeRes();
  await mobileAuth.forgot({ body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('a push token that is not an Expo token is refused before the database is touched', async () => {
  for (const token of ['', 'abc', 'ExponentPushToken[', 'https://fcm.googleapis.com/x']) {
    const res = fakeRes();
    await mobileAuth.registerPush({ body: { token }, user: { id: '000000000000000000000009' } }, res);
    assert.equal(res.statusCode, 400, token);
  }
  const res = fakeRes();
  await mobileAuth.unregisterPush({ body: {}, user: { id: '000000000000000000000009' } }, res);
  assert.equal(res.statusCode, 400);
});

test('the push token model is a per-gym model', () => {
  const MobilePushToken = require('../../src/models/mobilePushTokenModel');
  assert.equal(MobilePushToken.modelName, 'MobilePushToken');
  assert.ok(registeredModelNames().includes('MobilePushToken'));
  assert.throws(() => MobilePushToken.find(), /outside a tenant context/);
});
