// Signing out ends the session on the server, against a real MongoDB.
//
// Every token a sign-in issues carries a session id (`jti`). POST
// /user/logout records it on the account until the token would have expired,
// and middleware/auth refuses it from then on -- the website's, the
// phone's, whichever was signed out -- while the account's other sessions
// carry on. Tokens issued before the `jti` existed keep working until they
// expire: a deploy signs nobody out.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let users;
let security;
let mobile;
let auth;
let optionalAuth;

const PASSWORD = 'correct-horse-1';

const test = h.suite(async () => {
  User = h.src('models/user');
  users = h.src('controller/userController');
  security = h.src('controller/securityController');
  mobile = h.src('controller/mobileAuthController');
  auth = h.src('middleware/auth');
  optionalAuth = h.src('middleware/optionalAuth');

  gym = await h.createGym('signout-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
  });
});

const inGym = (fn) => h.inGym(gym, fn);
const stored = (account) => h.rawDb(gym.database.name).collection('users').findOne({ _id: account._id });

let seq = 0;
async function account() {
  seq += 1;
  return inGym(async () =>
    User.create({ firstName: 'Sam', lastName: `Out${seq}`, email: `sam${seq}@signout.test`, password: await bcrypt.hash(PASSWORD, 4) })
  );
}

async function signIn(who) {
  const res = await inGym(() => h.call(users.loginUser, { body: { email: who.email, password: PASSWORD } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.token;
}

/** Runs `middleware` for a request carrying `token`: 200 with req.user when it lets the request through. */
function through(middleware, token) {
  const handler = (req, res) =>
    middleware(req, res, () => res.status(200).json({ user: req.user }));
  return inGym(() => h.call(handler, { tenant: gym, headers: { authorization: `Bearer ${token}` } }));
}

const asked = (token) => through(auth, token);

/** POST /user/logout as the route runs it: auth, then the handler. */
async function signOut(token) {
  const gate = await asked(token);
  if (gate.statusCode !== 200) return gate;
  return inGym(() => h.call(security.logout, { user: gate.body.user }));
}

test('signing out ends that token on the server, and only that one', async () => {
  const sam = await account();
  const laptop = await signIn(sam);
  const phone = await signIn(sam);
  assert.ok(jwt.decode(laptop).jti, 'a sign-in token carries a session id');
  assert.notEqual(jwt.decode(laptop).jti, jwt.decode(phone).jti, 'and each sign-in its own');

  assert.equal((await asked(laptop)).statusCode, 200);

  const out = await signOut(laptop);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));

  const after = await asked(laptop);
  assert.equal(after.statusCode, 401, 'the signed-out token is refused at once');
  assert.equal(after.body.code, 'SESSION_ENDED');

  // Optional sign-in pages treat it as a visitor, not as Sam.
  const optional = await through(optionalAuth, laptop);
  assert.equal(optional.statusCode, 200);
  assert.equal(optional.body.user, null);

  // The other device is still signed in, and nothing else about the account moved.
  assert.equal((await asked(phone)).statusCode, 200, 'other sessions are unaffected');
  const row = await stored(sam);
  assert.equal(row.tokenVersion || 0, 0);
  assert.equal(row.revokedSessions.length, 1);
  assert.equal(row.revokedSessions[0].jti, jwt.decode(laptop).jti);
  assert.equal(row.revokedSessions[0].exp.getTime(), jwt.decode(laptop).exp * 1000, 'kept only as long as the token would have lived');

  // Signing out twice is refused the second time, as any ended session is.
  assert.equal((await signOut(laptop)).statusCode, 401);
});

test('the phone app token signs out the same way', async () => {
  const sam = await account();
  const user = await inGym(() => User.findById(sam._id));
  const appToken = mobile.issueToken(user, gym);
  const website = await signIn(sam);
  const decoded = jwt.verify(appToken, process.env.JWT_SECRET);
  assert.ok(decoded.jti);

  await inGym(() => h.call(security.logout, { user: decoded }));
  assert.match(await inGym(() => auth.sessionProblem(decoded)), /session has ended/);
  assert.equal((await asked(website)).statusCode, 200);
});

test('a token from before session ids keeps working until it expires, and signing it out ends the account\'s sessions', async () => {
  const sam = await account();
  const legacy = jwt.sign(
    { id: String(sam._id), email: sam.email, role: 'user', tid: String(gym._id), tv: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  assert.equal(jwt.decode(legacy).jti, undefined);
  assert.equal((await asked(legacy)).statusCode, 200, 'no mass sign-out on deploy');

  // Another account's sign-out does not touch it.
  const other = await account();
  await signOut(await signIn(other));
  assert.equal((await asked(legacy)).statusCode, 200);

  // It has no id of its own to revoke, so signing it out ends them all.
  const fresh = await signIn(sam);
  assert.equal((await signOut(legacy)).statusCode, 200);
  assert.equal((await asked(legacy)).statusCode, 401);
  assert.equal((await asked(fresh)).statusCode, 401);
  assert.equal((await stored(sam)).tokenVersion, 1);
});

test('expired entries are pruned on the next sign-out, and the list never shows in a profile', async () => {
  const sam = await account();
  await h.rawDb(gym.database.name).collection('users').updateOne(
    { _id: sam._id },
    { $set: { revokedSessions: [{ jti: 'long-gone', exp: new Date(Date.now() - 1000) }, { jti: 'still-live', exp: new Date(Date.now() + 3600000) }] } }
  );
  inGym(() => auth.forgetSession(sam._id));

  await signOut(await signIn(sam));
  const jtis = (await stored(sam)).revokedSessions.map((s) => s.jti);
  assert.equal(jtis.length, 2);
  assert.ok(!jtis.includes('long-gone'));
  assert.ok(jtis.includes('still-live'));

  const plain = await inGym(() => User.findById(sam._id).lean());
  assert.equal(plain.revokedSessions, undefined, 'not read unless asked for');
});
