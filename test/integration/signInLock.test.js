// Guessing a password or a sign-in code, against a real MongoDB.
//
// The request limits in middleware/rateLimit.js are kept in memory and per
// address; what is tested here is kept on the account, so it holds across
// servers and addresses and against requests sent all at once:
//
//   * ten password tries, then the password is not checked for fifteen
//     minutes -- answered exactly as a wrong password or an unknown name is,
//     clearing itself, and opened at once by a new password;
//   * five tries at an emailed sign-in code, however many arrive together,
//     and the code is never in the subject of its email.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let users;
let security;
let mobile;
let signInLock;
let twoFactor;
let adminPasswords;

const PASSWORD = 'correct-horse-1';
const WRONG = 'wrong-horse-1';

const test = h.suite(async () => {
  User = h.src('models/user');
  users = h.src('controller/userController');
  security = h.src('controller/securityController');
  mobile = h.src('controller/mobileAuthController');
  signInLock = h.src('services/signInLock');
  twoFactor = h.src('services/twoFactorService');
  adminPasswords = h.src('services/adminPasswords');
  // The harness silences every export of gymNotifications, the brand lookup
  // the sign-in code email reads the gym's name from among them.
  h.src('services/gymNotifications').brand = async () => ({ siteName: 'Lock Gym' });

  gym = await h.createGym('lock-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, h.src('platform/models/memberDirectoryModel'));
    await h.src('services/roleService').ensureDefaultRoles();
  });
});

const inGym = (fn) => h.inGym(gym, fn);
const login = (name, password) => inGym(() => h.call(users.loginUser, { body: { email: name, password } }));
const appLogin = (username, password) => h.call(mobile.login, { protocol: 'https', headers: { host: 'api.gympilot.test' }, body: { username, password } });
const stored = (account) => h.rawDb(gym.database.name).collection('users').findOne({ _id: account._id });
const bearer = (account) => `Bearer ${jwt.sign({ id: String(account._id), email: account.email, role: 'user' }, process.env.JWT_SECRET)}`;

let seq = 0;
async function account(fields = {}) {
  seq += 1;
  return inGym(async () =>
    User.create({ firstName: 'Lena', lastName: `Lock${seq}`, email: `lena${seq}@lock.test`, password: await bcrypt.hash(PASSWORD, 4), ...fields })
  );
}

async function wrongTries(name, count) {
  const answers = [];
  for (let i = 0; i < count; i++) answers.push(await login(name, WRONG));
  return answers;
}

test('ten wrong passwords pause the account, and the answer never says so', async () => {
  const lena = await account();
  const unknown = await login('nobody@lock.test', PASSWORD);
  assert.equal(unknown.statusCode, 401);

  const tries = await wrongTries(lena.email, signInLock.MAX_ATTEMPTS);
  for (const res of tries) {
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, unknown.body, 'a wrong password reads as an unknown name does');
  }
  assert.match(unknown.body.message, /After 10 wrong tries, sign-in for an account pauses for 15 minutes/);

  // Paused: even the right password is refused, in the very same words, by
  // email or by username, on the website and in the phone app.
  for (const res of [await login(lena.email, PASSWORD), await login(lena.username, PASSWORD)]) {
    assert.equal(res.statusCode, 401, JSON.stringify(res.body));
    assert.deepEqual(res.body, unknown.body);
    assert.equal(res.body.token, undefined);
  }
  const app = await appLogin(lena.username, PASSWORD);
  assert.equal(app.statusCode, 401, JSON.stringify(app.body));
  assert.deepEqual(app.body, (await appLogin('nobodyatall999', PASSWORD)).body);

  // Tries made while it is paused do not make the pause longer.
  const row = await stored(lena);
  assert.equal(row.signInAttempts, signInLock.MAX_ATTEMPTS);
  const until = row.signInWindowEndsAt.getTime();
  assert.ok(until > Date.now() + 14 * 60000 && until <= Date.now() + 15 * 60000 + 1000, 'fifteen minutes from the tenth wrong try');
  await wrongTries(lena.email, 3);
  assert.equal((await stored(lena)).signInWindowEndsAt.getTime(), until);

  // It clears itself: once the time is up the right password signs in, and
  // the count starts again.
  await inGym(() => User.updateOne({ _id: lena._id }, { $set: { signInWindowEndsAt: new Date(Date.now() - 1000) } }));
  const back = await login(lena.email, PASSWORD);
  assert.equal(back.statusCode, 200, JSON.stringify(back.body));
  assert.ok(back.body.token);
  const after = await stored(lena);
  assert.equal(after.signInAttempts, 0);
  assert.equal(after.signInWindowEndsAt, null);
  // None of it rides along in what a sign-in returns.
  for (const key of ['signInAttempts', 'signInWindowEndsAt']) assert.equal(key in back.body.data, false, key);
});

test('a right password in time clears the count, so ordinary fumbling never adds up', async () => {
  const lena = await account();
  for (let round = 0; round < 3; round++) {
    await wrongTries(lena.email, signInLock.MAX_ATTEMPTS - 1);
    const ok = await login(lena.email, PASSWORD);
    assert.equal(ok.statusCode, 200, `round ${round}: ${JSON.stringify(ok.body)}`);
  }
  // The phone app's sign-in counts against the same ten.
  await wrongTries(lena.email, 5);
  for (let i = 0; i < 5; i++) assert.equal((await appLogin(lena.username, WRONG)).statusCode, 401);
  assert.equal((await login(lena.email, PASSWORD)).statusCode, 401, 'five on the website and five in the app are ten');
});

test('guesses sent all at once still share ten tries', async () => {
  const lena = await account();
  // The right password is among them, after more than ten wrong ones: read
  // first and counted after, every one of these would have been checked.
  const guesses = Array.from({ length: 40 }, (_, i) => (i === 39 ? PASSWORD : `guess-number-${i}`));
  const burst = await Promise.all(guesses.map((guess) => login(lena.email, guess)));
  const row = await stored(lena);
  if (burst.some((res) => res.statusCode === 200)) {
    // The right one happened to win one of the ten tries: the count was
    // cleared by it, and no more than ten were ever checked before it.
    assert.equal(burst.filter((res) => res.statusCode === 200).length, 1);
    assert.ok(row.signInAttempts <= signInLock.MAX_ATTEMPTS);
  } else {
    assert.equal(row.signInAttempts, signInLock.MAX_ATTEMPTS, 'the count stopped at ten');
    assert.equal((await login(lena.email, PASSWORD)).statusCode, 401, 'and the account is paused');
  }

  // With no right answer among them, exactly ten are taken.
  const other = await account();
  const wrong = await Promise.all(Array.from({ length: 40 }, (_, i) => login(other.email, `guess-number-${i}`)));
  assert.ok(wrong.every((res) => res.statusCode === 401));
  assert.equal((await stored(other)).signInAttempts, signInLock.MAX_ATTEMPTS);
  assert.equal((await login(other.email, PASSWORD)).statusCode, 401);
});

test('a new password opens a paused account at once, however it was set', async () => {
  // Staff set one at the desk for the member who has just locked themselves out.
  const desk = await account();
  await wrongTries(desk.email, signInLock.MAX_ATTEMPTS);
  assert.equal((await login(desk.email, PASSWORD)).statusCode, 401);
  await inGym(async () => adminPasswords.applyPassword(await User.findById(desk._id), 'set-at-the-desk-1'));
  const withNew = await login(desk.email, 'set-at-the-desk-1');
  assert.equal(withNew.statusCode, 200, JSON.stringify(withNew.body));

  // The emailed reset link.
  const reset = await account();
  await wrongTries(reset.email, signInLock.MAX_ATTEMPTS);
  const before = h.calls.emails.length;
  await inGym(() => h.call(users.forgotPassword, { body: { email: reset.email } }));
  let mail;
  for (let i = 0; i < 60 && !mail; i++) {
    mail = h.calls.emails.slice(before).find((m) => m.to === reset.email && /Reset your/.test(m.subject));
    if (!mail) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const token = new URL(mail.html.match(/href="([^"]*mode=reset[^"]*)"/)[1].replace(/&amp;/g, '&')).searchParams.get('token');
  assert.equal((await inGym(() => h.call(users.resetPassword, { body: { token, password: 'reset-by-email-1' } }))).statusCode, 200);
  assert.equal((await login(reset.email, 'reset-by-email-1')).statusCode, 200);
});

test('the current-password checks count against the same ten', async () => {
  const lena = await account();
  const change = (currentPassword) =>
    inGym(() => h.call(users.updateUser, { protocol: 'https', headers: { authorization: bearer(lena), host: 'api.gympilot.test' }, body: { email: 'moved@lock.test', currentPassword } }));
  for (let i = 0; i < signInLock.MAX_ATTEMPTS; i++) {
    const res = await change(WRONG);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'PASSWORD_INCORRECT');
  }
  // A stolen session has had its ten guesses: the right one is refused too.
  const paused = await change(PASSWORD);
  assert.equal(paused.statusCode, 400, JSON.stringify(paused.body));
  assert.equal(paused.body.code, 'PASSWORD_INCORRECT');
  assert.match(paused.body.message, /pauses for 15 minutes/);
  assert.equal((await stored(lena)).email, lena.email);

  const changePassword = await inGym(() => h.call(users.changePassword, { user: { id: String(lena._id) }, body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-one-1' } }));
  assert.equal(changePassword.statusCode, 401, JSON.stringify(changePassword.body));

  await inGym(() => User.updateOne({ _id: lena._id }, { $set: { signInWindowEndsAt: new Date(Date.now() - 1000) } }));
  assert.equal((await change(PASSWORD)).statusCode, 200);
});

// ---- the emailed sign-in code ---------------------------------------------

async function challengeFor(lena) {
  const since = h.calls.emails.length;
  const res = await login(lena.email, PASSWORD);
  assert.equal(res.body.requires2fa, true, JSON.stringify(res.body));
  const mail = h.calls.emails.slice(since).find((m) => m.to === lena.email);
  return { challengeId: res.body.challengeId, mail, code: mail.html.match(/>(\d{6})</)[1] };
}
const submit = (challengeId, code) => inGym(() => h.call(security.verifyTwoFactor, { body: { challengeId, code } }));
const otherCode = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');

test('the sign-in code is in the body of its email and never in the subject', async () => {
  const lena = await account({ twoFactor: { enabled: true } });
  const { mail, code } = await challengeFor(lena);
  assert.equal(mail.subject, 'Your Lock Gym sign-in code');
  assert.equal(/\d{6}/.test(mail.subject), false);
  assert.ok(mail.html.includes(code));
});

test('a code gets five tries, counted one at a time', async () => {
  const lena = await account({ twoFactor: { enabled: true } });
  const { challengeId, code } = await challengeFor(lena);
  const wrong = otherCode(code);

  for (const left of [4, 3, 2, 1]) {
    const res = await submit(challengeId, wrong);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, `That code is not right. ${left} attempt(s) left.`);
  }
  const last = await submit(challengeId, wrong);
  assert.equal(last.statusCode, 401);
  assert.match(last.body.message, /Too many wrong codes/);
  // The challenge is gone: the right code is no use now.
  const late = await submit(challengeId, code);
  assert.equal(late.statusCode, 401);
  assert.match(late.body.message, /expired/);
  assert.equal((await stored(lena)).twoFactor.pending.challengeId, null);

  // The fifth try may still be the right one.
  const second = await challengeFor(lena);
  for (let i = 0; i < 4; i++) await submit(second.challengeId, otherCode(second.code));
  const ok = await submit(second.challengeId, second.code);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
});

test('wrong codes sent all at once still get five tries between them', async () => {
  const lena = await account({ twoFactor: { enabled: true } });
  const { challengeId, code } = await challengeFor(lena);

  // Every guess is checked against the stored hash only if it won a try.
  const crypto = require('crypto');
  const original = crypto.timingSafeEqual;
  let compared = 0;
  crypto.timingSafeEqual = (...args) => {
    compared += 1;
    return original(...args);
  };
  let burst;
  try {
    const guesses = Array.from({ length: 40 }, (_, i) => String((Number(code) + 1 + i) % 1000000).padStart(6, '0'));
    burst = await Promise.all(guesses.map((guess) => submit(challengeId, guess)));
  } finally {
    crypto.timingSafeEqual = original;
  }
  assert.ok(burst.every((res) => res.statusCode === 401));
  assert.equal(compared, twoFactor.MAX_ATTEMPTS, 'five guesses were compared, not forty');
  assert.equal((await submit(challengeId, code)).statusCode, 401, 'and the challenge is spent');
});

test('a code signs in once, even sent twice together, and an expired one not at all', async () => {
  const lena = await account({ twoFactor: { enabled: true } });
  const first = await challengeFor(lena);
  const both = await Promise.all([submit(first.challengeId, first.code), submit(first.challengeId, first.code)]);
  assert.deepEqual(both.map((res) => res.statusCode).sort(), [200, 401]);

  const second = await challengeFor(lena);
  await inGym(() => User.updateOne({ _id: lena._id }, { $set: { 'twoFactor.pending.expiresAt': new Date(Date.now() - 1000) } }));
  const expired = await submit(second.challengeId, second.code);
  assert.equal(expired.statusCode, 401);
  assert.match(expired.body.message, /That code has expired/);

  assert.equal((await submit('no-such-challenge', '123456')).statusCode, 401);
  assert.equal((await submit({ $ne: null }, '123456')).statusCode, 401, 'a query in place of an id finds nothing');
  assert.equal((await submit(second.challengeId, '12')).statusCode, 400);
});

// ---- what a refused sign-in gives away -------------------------------------

test('an account that only ever used Google is answered like any wrong password', async () => {
  const gus = await inGym(() => User.create({ firstName: 'Gus', lastName: 'Google', email: 'gus@lock.test', provider: 'google', googleId: 'google-gus', password: null }));
  const unknown = await login('nobody@lock.test', PASSWORD);
  for (const name of [gus.email, gus.username]) {
    const res = await login(name, PASSWORD);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, unknown.body, 'nothing says the address is a member who uses Google');
  }
});

test('a Google sign-in finished in a browser that did not start it is refused before Google is asked anything', async () => {
  const oauthState = h.src('services/oauthState');
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'client.test', GOOGLE_CLIENT_SECRET: 'secret.test', GOOGLE_REDIRECT_URI: 'https://api.gympilot.test/auth/google/callback' });
  const callback = async ({ state, cookie }) => {
    const res = h.fakeRes();
    res.type = () => res;
    res.cleared = [];
    res.clearCookie = (name, options) => res.cleared.push({ name, options });
    await inGym(() => users.googleOAuthCallback({ query: { code: 'attackers-code', state }, headers: cookie ? { cookie: `${oauthState.COOKIE_NAME}=${cookie}` } : {}, protocol: 'https' }, res));
    return res;
  };
  try {
    // The attacker's own, genuine state -- but the victim's browser has no cookie for it.
    const theirs = oauthState.issue({ returnUrl: '/', tenant: gym.slug });
    for (const attempt of [
      { state: theirs.state },
      { state: theirs.state, cookie: oauthState.issue({ tenant: gym.slug }).nonce },
      { state: encodeURIComponent(JSON.stringify({ returnUrl: '/', tenant: gym.slug })), cookie: 'anything' },
      { state: oauthState.issue({ returnUrl: '/', tenant: 'another-gym' }).state, cookie: theirs.nonce }
    ]) {
      const res = await callback(attempt);
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.match(res.body, /did not start in this browser/);
      assert.equal(res.cleared.length, 1, 'the cookie is spent either way');
    }
  } finally {
    for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete process.env[key];
  }
});
