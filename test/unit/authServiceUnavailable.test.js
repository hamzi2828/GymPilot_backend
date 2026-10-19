// middleware/auth: only a problem with the token is a 401. When the session
// cannot be checked because the database is down, the answer is 503
// SERVICE_UNAVAILABLE -- the phone app signs its member out on a 401, and a
// database hiccup must not cost everyone their sign-in. No database: the
// account lookup is stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const auth = require('../../src/middleware/auth');
const User = require('../../src/models/user');
const { runWithTenant } = require('../../src/platform/tenantContext');

const gym = { _id: '00000000000000000000a501', slug: 'unit-auth-503', database: { name: 'gympilot_unit_auth_503' } };

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

/** Runs auth for a token naming `id` at the gym, with the account lookup answering `lookup`. */
function run(id, lookup) {
  return runWithTenant(gym, async () => {
    const saved = User.findById;
    User.findById = () => ({ select: () => ({ lean: lookup }) });
    try {
      const token = jwt.sign({ id, tid: gym._id, tv: 0 }, process.env.JWT_SECRET, { jwtid: auth.newSessionId() });
      const res = fakeRes();
      let passed = false;
      await auth({ headers: { authorization: `Bearer ${token}` }, tenant: gym }, res, () => {
        passed = true;
      });
      return { res, passed };
    } finally {
      User.findById = saved;
    }
  });
}

const freshId = () => String(new mongoose.Types.ObjectId());

test('a database that cannot be reached is a 503, never a sign-out', async () => {
  const errorLog = console.error;
  console.error = () => {};
  try {
    for (const failure of [
      Object.assign(new Error('connection 3 to 10.0.0.1:27017 timed out'), { name: 'MongoNetworkTimeoutError' }),
      Object.assign(new Error('Server selection timed out after 30000 ms'), { name: 'MongooseServerSelectionError' }),
      new Error('Cannot call `users.findOne()` before initial connection is complete')
    ]) {
      const { res, passed } = await run(freshId(), async () => {
        throw failure;
      });
      assert.equal(passed, false);
      assert.equal(res.statusCode, 503, failure.name);
      assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'success']);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, 'SERVICE_UNAVAILABLE');
      assert.doesNotMatch(res.body.message, /timed out|10\.0\.0\.1|users/, 'the driver message stays in the log');
    }
  } finally {
    console.error = errorLog;
  }
});

test('token problems are still 401s with their own codes', async () => {
  // A token whose account id is not an id at all: the token, not the server.
  const castError = Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' });
  const badId = await run('not-an-object-id', async () => {
    throw castError;
  });
  assert.equal(badId.res.statusCode, 401);
  assert.equal(badId.res.body.code, 'TOKEN_INVALID');

  const gone = await run(freshId(), async () => null);
  assert.equal(gone.res.statusCode, 401);
  assert.equal(gone.res.body.code, 'SESSION_ENDED');

  const signedOutEverywhere = await run(freshId(), async () => ({ tokenVersion: 4, isActive: true }));
  assert.equal(signedOutEverywhere.res.statusCode, 401);
  assert.equal(signedOutEverywhere.res.body.code, 'SESSION_ENDED');

  const forged = fakeRes();
  await auth({ headers: { authorization: `Bearer ${jwt.sign({ id: freshId(), tid: gym._id }, 'some other secret')}` }, tenant: gym }, forged, () => {});
  assert.equal(forged.statusCode, 401);
  assert.equal(forged.body.code, 'TOKEN_INVALID');
});

test('a live session passes once the database answers', async () => {
  const { res, passed } = await run(freshId(), async () => ({ tokenVersion: 0, isActive: true, revokedSessions: [] }));
  assert.equal(passed, true, JSON.stringify(res.body));
});
