// An account's list of signed-out sessions is capped (securityController's
// MAX_REVOKED_SESSIONS). A sign-out that would go past the cap used to drop
// the oldest entry -- and that signed-out token worked again. Now it ends
// every session of the account instead, so nothing signed out ever comes
// back. Against a real MongoDB.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let users;
let security;
let auth;

const PASSWORD = 'correct-horse-1';
const CAP = 200;

const test = h.suite(async () => {
  User = h.src('models/user');
  users = h.src('controller/userController');
  security = h.src('controller/securityController');
  auth = h.src('middleware/auth');

  gym = await h.createGym('overflow-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
  });
});

const inGym = (fn) => h.inGym(gym, fn);
const accounts = () => h.rawDb(gym.database.name).collection('users');

async function signIn(who) {
  const res = await inGym(() => h.call(users.loginUser, { body: { email: who.email, password: PASSWORD } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.token;
}

function asked(token) {
  const handler = (req, res) => auth(req, res, () => res.status(200).json({ user: req.user }));
  return inGym(() => h.call(handler, { tenant: gym, headers: { authorization: `Bearer ${token}` } }));
}

async function signOut(token) {
  const gate = await asked(token);
  assert.equal(gate.statusCode, 200, JSON.stringify(gate.body));
  const res = await inGym(() => h.call(security.logout, { user: gate.body.user }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
}

test('a sign-out that would overflow the list ends every session, and the oldest signed-out token stays out', async () => {
  const sam = await inGym(async () =>
    User.create({ firstName: 'Sam', lastName: 'Many', email: 'sam@overflow.test', password: await bcrypt.hash(PASSWORD, 4) })
  );
  const oldest = await signIn(sam);
  const second = await signIn(sam);
  const third = await signIn(sam);
  const stillIn = await signIn(sam);

  await signOut(oldest);

  // Fill the list to one short of the cap behind `oldest`, with expired
  // entries mixed in: those do not count and are dropped on the next sign-out.
  const later = new Date(Date.now() + 24 * 3600 * 1000);
  const fillers = Array.from({ length: CAP - 2 }, (_, i) => ({ jti: `filler-${i}`, exp: later }));
  const expired = Array.from({ length: 5 }, (_, i) => ({ jti: `expired-${i}`, exp: new Date(Date.now() - 60000) }));
  await accounts().updateOne({ _id: sam._id }, { $push: { revokedSessions: { $each: [...expired, ...fillers] } } });

  // The cap is reached, not passed: an ordinary sign-out.
  await signOut(second);
  let row = await accounts().findOne({ _id: sam._id });
  assert.equal(row.revokedSessions.length, CAP);
  assert.equal(row.revokedSessions[0].jti, jwt.decode(oldest).jti, 'the oldest is still listed');
  assert.equal(row.tokenVersion || 0, 0);
  assert.equal((await asked(oldest)).statusCode, 401);
  assert.equal((await asked(stillIn)).statusCode, 200, 'the others carry on');

  // One more would push the oldest out: every session ends instead.
  await signOut(third);
  row = await accounts().findOne({ _id: sam._id });
  assert.equal(row.tokenVersion, 1);
  assert.deepEqual(row.revokedSessions, []);
  for (const [name, token] of Object.entries({ oldest, second, third, stillIn })) {
    const res = await asked(token);
    assert.equal(res.statusCode, 401, `${name} is signed out`);
    assert.equal(res.body.code, 'SESSION_ENDED');
  }

  // And a fresh sign-in works, with a list that starts over.
  const fresh = await signIn(sam);
  assert.equal((await asked(fresh)).statusCode, 200);
  await signOut(fresh);
  row = await accounts().findOne({ _id: sam._id });
  assert.equal(row.revokedSessions.length, 1);
  assert.equal(row.tokenVersion, 1);
});
