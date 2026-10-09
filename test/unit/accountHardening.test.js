// Sign-up, sign-in and account-change rules that are decided before any
// database is touched. Pure logic: a request that reached a model here would
// throw (no tenant context), so a clean answer proves where the refusal was.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const users = require('../../src/controller/userController');
const { MIN_PASSWORD_LENGTH, passwordProblem } = require('../../src/services/adminPasswords');

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

async function call(handler, req) {
  const res = fakeRes();
  await handler({ headers: {}, query: {}, params: {}, body: {}, ...req }, res);
  return res;
}

const signUp = (password, extra = {}) =>
  call(users.createUser, { body: { firstName: 'Sam', lastName: 'Short', email: 'sam@gym.test', password, ...extra } });

test('sign-up holds a password to the rule a reset and a change are held to', async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  for (const password of ['a', '1234567', 'x'.repeat(201)]) {
    const res = await signUp(password);
    assert.equal(res.statusCode, 400, password.slice(0, 12));
    assert.equal(res.body.message, passwordProblem(password));
  }
  assert.match((await signUp('1234567')).body.message, /at least 8 characters/);
  // Checked with the confirmation, before the address is looked up.
  assert.equal((await signUp('1234567', { confirmPassword: '1234567' })).statusCode, 400);
  // A length and nothing else: no rule about digits or symbols.
  assert.equal(passwordProblem('aaaaaaaa'), null);
});

test('the reset and welcome emails carry a name as text, never as markup', () => {
  const { welcomeEmailHtml, passwordResetEmailHtml } = users.emailTemplates;
  const hostile = '<a href="https://evil.test/login">Click here to keep your account</a>';

  const reset = passwordResetEmailHtml({
    firstName: hostile,
    siteName: 'Iron <b>Works</b>',
    resetUrl: 'https://gym.test/authentication?mode=reset&token=abc&email=a%40b.test',
    validMinutes: 60
  });
  assert.equal(reset.includes('evil.test/login">'), false, 'the attacker has no link in the email');
  assert.equal(reset.includes('<b>'), false);
  assert.ok(reset.includes('&lt;a href=&quot;https://evil.test/login&quot;&gt;'), 'the name is shown as it was typed');
  // The gym's own link is the only one, and still works as a link.
  assert.equal(reset.match(/<a /g).length, 1);
  assert.ok(reset.includes('href="https://gym.test/authentication?mode=reset&amp;token=abc&amp;email=a%40b.test"'));

  const welcome = welcomeEmailHtml({
    firstName: hostile,
    email: 'a@b.test',
    username: 'ann<i>123',
    password: 'p<w>&"\'',
    siteName: 'Iron <b>Works</b>',
    loginUrl: 'https://gym.test/authentication'
  });
  assert.equal(welcome.match(/<a /g).length, 1);
  for (const raw of ['evil.test/login">', '<b>', '<i>', '<w>']) assert.equal(welcome.includes(raw), false, raw);
  assert.ok(welcome.includes('p&lt;w&gt;&amp;&quot;&#39;'), 'a password with symbols reads back exactly');
});

// ---- "is this address really theirs?" (services/emailVerification.js) ------

const verification = require('../../src/services/emailVerification');
const { membershipsFromOrders } = require('../../src/attendance/services/peopleDirectory');

test('only an explicit false makes an address unproven; a list of addresses is not an address', () => {
  assert.equal(verification.emailIsVerified({ email: 'a@b.test', emailVerified: false }), false);
  assert.equal(verification.emailIsVerified({ email: 'a@b.test', emailVerified: true }), true);
  // An account from before the flag has no value, and nobody was cut off.
  assert.equal(verification.emailIsVerified({ email: 'a@b.test' }), true);
  assert.equal(verification.emailIsVerified(null), false);

  for (const good of ['a@b.test', 'first.last+tag@sub.gym.co.uk']) assert.equal(verification.looksLikeEmail(good), true, good);
  for (const bad of ['', 'a@b', 'a b@c.test', 'a@b.test, c@d.test', 'a@b.test,c@d.test', 'a@b.test;c@d.test', 'Ann <a@b.test>', '"a"@b.test', null, 12, { $ne: null }]) {
    assert.equal(verification.looksLikeEmail(bad), false, String(bad));
  }
});

test('a guest order is matched by address only for an account whose address is proven', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const guest = {
    _id: 'o1',
    userId: null,
    customerInfo: { email: 'gina@gym.test' },
    packageDetails: { name: 'Monthly' },
    payment: { status: 'paid' },
    subscription: { startDate: new Date('2026-06-01T00:00:00Z'), endDate: new Date('2026-07-01T00:00:00Z') },
    status: 'active',
    createdAt: new Date('2026-06-01T00:00:00Z')
  };
  const own = { ...guest, _id: 'o2', userId: 'u2', customerInfo: { email: 'someone@gym.test' } };
  const statusOf = (user, options) => membershipsFromOrders([user], [guest, own], [], now, options).get(String(user._id)).status;

  assert.equal(statusOf({ _id: 'u1', email: 'gina@gym.test', emailVerified: true }), 'active');
  assert.equal(statusOf({ _id: 'u1', email: 'gina@gym.test' }), 'active', 'an account from before the flag');
  assert.equal(statusOf({ _id: 'u1', email: 'gina@gym.test', emailVerified: false }), 'none');
  // A projection without the flag, which the database says is unproven.
  assert.equal(statusOf({ _id: 'u1', email: 'gina@gym.test' }, { unproven: new Set(['u1']) }), 'none');
  // Orders under the account's own id are theirs whatever the address says.
  assert.equal(statusOf({ _id: 'u2', email: 'gina@gym.test', emailVerified: false }), 'active');
});

test('the confirmation email and its page show what was typed as text, and the link changes nothing by itself', () => {
  const { subject, html } = verification.confirmationEmail({
    firstName: '<a href="https://evil.test">Click</a>',
    siteName: 'Iron <b>Works</b>',
    url: 'https://api.gym.test/user/verify-email?token=abc&tenant=iron'
  });
  assert.equal(subject, 'Confirm your email for Iron <b>Works</b>');
  assert.equal(html.match(/<a /g).length, 1, 'one link, the gym\'s own');
  assert.ok(html.includes('href="https://api.gym.test/user/verify-email?token=abc&amp;tenant=iron"'));
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /ignore this email/);

  const page = verification.confirmPage({ siteName: 'Iron <b>Works</b>', email: 'a"><script>x</script>@b.test', token: 'abc"><i>', slug: 'iron' });
  assert.equal(page.includes('<script>'), false);
  assert.equal(page.includes('<i>'), false);
  assert.equal(page.includes('<b>'), false);
  // A form that posts: opening the page is not confirming.
  assert.match(page, /<form method="post" action="\/user\/verify-email\?tenant=iron"/);
  assert.match(verification.invalidPage({ siteName: 'Gym' }), /invalid or has expired/);
});

test('the link points at the address the API was reached on, or the one it is pinned to', () => {
  const req = { protocol: 'https', get: (name) => (name === 'host' ? 'api.gym.test' : undefined) };
  assert.equal(verification.apiOrigin(req), 'https://api.gym.test');
  process.env.API_PUBLIC_URL = 'https://api.pinned.test/';
  try {
    assert.equal(verification.apiOrigin(req), 'https://api.pinned.test');
  } finally {
    delete process.env.API_PUBLIC_URL;
  }
  assert.equal(verification.apiOrigin(null), '');
});

// ---- "type your current password to do this" (services/passwordCheck.js) ---

const bcrypt = require('bcryptjs');
const { currentPasswordRefusal } = require('../../src/services/passwordCheck');

test('the current-password check answers with one of three codes, or lets the change through', async () => {
  const account = { password: await bcrypt.hash('correct-horse-1', 4) };
  const check = (acc, typed) => currentPasswordRefusal(acc, typed, { toDo: 'change your email address' });

  assert.equal(await check(account, 'correct-horse-1'), null);
  assert.equal((await check(account, 'wrong')).code, 'PASSWORD_INCORRECT');
  for (const missing of [undefined, null, '', 0, false, {}, ['correct-horse-1']]) {
    const refusal = await check(account, missing);
    assert.equal(refusal.code, 'PASSWORD_REQUIRED', JSON.stringify(missing));
    assert.match(refusal.message, /Enter your current password to change your email address/);
  }
  // Nothing to compare against: said so, whatever was typed.
  for (const none of [{ password: null }, { password: '' }, {}, null]) {
    const refusal = await check(none, 'anything');
    assert.equal(refusal.code, 'PASSWORD_NOT_SET');
    assert.match(refusal.message, /Forgot password/);
  }
});

test('the notice to the old address masks the new one and shows names as text', () => {
  const changed = verification.addressChangedEmail({ firstName: '<b>Ann</b>', siteName: 'Iron Works', newEmail: 'thief@evil.test', username: 'ann<i>123' });
  assert.equal(changed.subject, 'Your Iron Works email address was changed');
  assert.ok(changed.html.includes('th***@evil.test'));
  assert.equal(changed.html.includes('thief@evil.test'), false);
  assert.equal(changed.html.includes('<b>'), false);
  assert.equal(changed.html.includes('<i>'), false);
  assert.match(changed.html, /tell Iron Works straight away/);
  const removed = verification.addressChangedEmail({ firstName: 'Ann', siteName: 'Iron Works', newEmail: '', username: '' });
  assert.match(removed.html, /was removed from your Iron Works account/);
});

// ---- what a sent email leaves in the log (services/emailService.js) --------

test('a sent email is logged by recipient, never by subject', async () => {
  const nodemailer = require('nodemailer');
  const emailService = require('../../src/services/emailService');
  const realTransport = nodemailer.createTransport;
  const realLog = console.log;
  const env = { host: process.env.SMTP_HOST, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  const sent = [];
  const logged = [];
  nodemailer.createTransport = () => ({ sendMail: async (mail) => (sent.push(mail), { messageId: 'unit-1' }) });
  // A host no other test uses, so the transport made here is the stand-in.
  Object.assign(process.env, { SMTP_HOST: 'smtp.log-test.invalid', SMTP_USER: 'gym@log-test.invalid', SMTP_PASS: 'unit' });
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const result = await emailService.sendEmail('sam@gym.test', '482913 is your sign-in code', '<p>482913</p>');
    assert.equal(result.success, true);
  } finally {
    console.log = realLog;
    nodemailer.createTransport = realTransport;
    for (const [key, name] of [['host', 'SMTP_HOST'], ['user', 'SMTP_USER'], ['pass', 'SMTP_PASS']]) {
      if (env[key] === undefined) delete process.env[name];
      else process.env[name] = env[key];
    }
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, '482913 is your sign-in code', 'the email itself is untouched');
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes('sam@gym.test'));
  assert.equal(logged[0].includes('482913'), false, 'whatever a subject carries stays out of the log');
});

// ---- what a session token must carry (middleware/auth.js) ------------------

const jwt = require('jsonwebtoken');
const auth = require('../../src/middleware/auth');

test('a token that names no account or no gym is not a session', async () => {
  const run = async (claims, tenant) => {
    const res = fakeRes();
    let passed = false;
    const token = jwt.sign(claims, process.env.JWT_SECRET);
    await auth({ headers: { authorization: `Bearer ${token}` }, tenant }, res, () => {
      passed = true;
    });
    return { res, passed };
  };
  const gym = { _id: '000000000000000000000001' };

  for (const claims of [
    { email: 'a@b.test', role: 'admin', tid: '000000000000000000000001' }, // no account
    { id: '000000000000000000000009', role: 'admin' }, // no gym
    { role: 'admin' },
    { id: '', tid: '' }
  ]) {
    for (const tenant of [gym, undefined]) {
      const { res, passed } = await run(claims, tenant);
      assert.equal(passed, false, JSON.stringify(claims));
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 'TOKEN_INVALID');
    }
  }

  // The helpers optionalAuth shares hold the same line.
  assert.equal(auth.tenantMismatch({ id: 'u1' }, { tenant: gym }), true);
  assert.equal(auth.tenantMismatch({ id: 'u1', tid: '000000000000000000000001' }, { tenant: gym }), false);
  assert.equal(auth.tenantMismatch({ id: 'u1', tid: '000000000000000000000002' }, { tenant: gym }), true);
  assert.equal(typeof (await auth.sessionProblem({ tid: '000000000000000000000001' })), 'string');
  assert.equal(typeof (await auth.sessionProblem(null)), 'string');
});

// ---- the state of a Google sign-in (services/oauthState.js) ----------------

const oauthState = require('../../src/services/oauthState');

test('a Google sign-in can only be finished by the browser that started it, for the gym that started it', () => {
  const { state, nonce } = oauthState.issue({ returnUrl: '/packages?plan=gold%20plus&x=1', platformType: 'web', tenant: 'iron-works' });
  // As the callback and the tenant resolver receive it: the URL carried it
  // encoded once more, and Express took that layer off.
  assert.deepEqual(oauthState.verify(state, nonce, 'iron-works'), { returnUrl: '/packages?plan=gold%20plus&x=1', platformType: 'web', tenant: 'iron-works' });
  // The resolver still finds the gym in it.
  assert.equal(JSON.parse(decodeURIComponent(state)).tenant, 'iron-works');

  // Another browser: no cookie, or the cookie of a sign-in of its own.
  assert.equal(oauthState.verify(state, '', 'iron-works'), null);
  assert.equal(oauthState.verify(state, oauthState.issue({ tenant: 'iron-works' }).nonce, 'iron-works'), null);
  // The request resolved to another gym than the one that was signed.
  assert.equal(oauthState.verify(state, nonce, 'other-gym'), null);
  assert.equal(oauthState.verify(state, nonce, null), null);

  // Anything altered on the way: the gym, the return address, the nonce.
  const tamper = (change) => encodeURIComponent(JSON.stringify({ ...JSON.parse(decodeURIComponent(state)), ...change }));
  assert.equal(oauthState.verify(tamper({ tenant: 'other-gym' }), nonce, 'other-gym'), null);
  assert.equal(oauthState.verify(tamper({ returnUrl: '/admin' }), nonce, 'iron-works'), null);
  assert.equal(oauthState.verify(tamper({ nonce: 'mine' }), 'mine', 'iron-works'), null);
  // What the old, unsigned state looked like, and plain junk.
  assert.equal(oauthState.verify(encodeURIComponent(JSON.stringify({ returnUrl: '/', tenant: 'iron-works' })), nonce, 'iron-works'), null);
  for (const junk of ['', '/', '{}', 'not json', '%E0%A4%A', undefined, null]) assert.equal(oauthState.verify(junk, nonce, 'iron-works'), null);

  // The cookie: this browser only, the sign-in routes only, not for script.
  assert.equal(oauthState.readCookie({ headers: { cookie: `a=1; ${oauthState.COOKIE_NAME}=${nonce}; b=2` } }), nonce);
  assert.equal(oauthState.readCookie({ headers: {} }), '');
  const options = oauthState.cookieOptions({ protocol: 'https' });
  assert.deepEqual({ httpOnly: options.httpOnly, sameSite: options.sameSite, secure: options.secure, path: options.path }, { httpOnly: true, sameSite: 'lax', secure: true, path: '/auth/google' });
});

test('starting a Google sign-in leaves the cookie its state is tied to', async () => {
  const env = { id: process.env.GOOGLE_CLIENT_ID, uri: process.env.GOOGLE_REDIRECT_URI };
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.test';
  process.env.GOOGLE_REDIRECT_URI = 'https://api.gym.test/auth/google/callback';
  const res = fakeRes();
  const cookies = [];
  res.cookie = (name, value, options) => cookies.push({ name, value, options });
  res.redirect = (url) => {
    res.redirectedTo = url;
    return res;
  };
  res.send = res.json;
  try {
    await users.startGoogleOAuth({ headers: {}, protocol: 'https', query: { returnUrl: '/timetable' } }, res);
  } finally {
    for (const [key, name] of [['id', 'GOOGLE_CLIENT_ID'], ['uri', 'GOOGLE_REDIRECT_URI']]) {
      if (env[key] === undefined) delete process.env[name];
      else process.env[name] = env[key];
    }
  }
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, oauthState.COOKIE_NAME);
  const sent = new URL(res.redirectedTo).searchParams.get('state');
  // No gym in context in a unit test: the state is for "no gym", and only that.
  assert.deepEqual(oauthState.verify(sent, cookies[0].value, null), { returnUrl: '/timetable', platformType: '', tenant: null });
  assert.equal(oauthState.verify(sent, 'another-browser', null), null);
});
