// A stolen session must not become the account, against a real MongoDB.
//
// A session can be taken without the password being known: a shared
// computer left signed in, a copied token. The email address is where a
// password reset goes, and two-factor is the step that stands between a
// leaked password and a sign-in -- so changing or removing the address, and
// switching two-factor off, ask for the current password. The address it
// was is told. Everything else about a profile saves as before, and nobody
// without an email address is asked for anything they do not have.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let users;
let security;

const PASSWORD = 'correct-horse-1';

const test = h.suite(async () => {
  User = h.src('models/user');
  users = h.src('controller/userController');
  security = h.src('controller/securityController');

  gym = await h.createGym('takeover-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
  });
});

async function settle(check, { tries = 60, every = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  return false;
}

const inGym = (fn) => h.inGym(gym, fn);
const bearer = (account) => `Bearer ${jwt.sign({ id: String(account._id), email: account.email, role: account.role || 'user' }, process.env.JWT_SECRET)}`;
const updateMe = (account, body) =>
  inGym(() => h.call(users.updateUser, { protocol: 'https', headers: { authorization: bearer(account), host: 'api.gympilot.test' }, body }));
const setTwoFactor = (account, body) => inGym(() => h.call(security.setMyTwoFactor, { user: { id: String(account._id) }, body }));
const stored = (account) => h.rawDb(gym.database.name).collection('users').findOne({ _id: account._id });
const mailTo = (to, since = 0) => h.calls.emails.slice(since).filter((m) => m.to === to);

async function account(fields) {
  return inGym(async () => User.create({ password: await bcrypt.hash(PASSWORD, 4), ...fields }));
}

test('changing the email address needs the current password, and nothing is saved without it', async () => {
  const ann = await account({ firstName: 'Ann', lastName: 'Owner', email: 'ann@takeover.test' });
  const since = h.calls.emails.length;

  // Whoever holds only the session cannot move the address to their own.
  const missing = await updateMe(ann, { firstName: 'Changed', email: 'thief@takeover.test' });
  assert.equal(missing.statusCode, 400, JSON.stringify(missing.body));
  assert.equal(missing.body.code, 'PASSWORD_REQUIRED');
  assert.match(missing.body.message, /current password/);

  const wrong = await updateMe(ann, { firstName: 'Changed', email: 'thief@takeover.test', currentPassword: 'not-the-password' });
  assert.equal(wrong.statusCode, 400, JSON.stringify(wrong.body));
  assert.equal(wrong.body.code, 'PASSWORD_INCORRECT');

  for (const junk of [true, { $ne: '' }, 12345678]) {
    const res = await updateMe(ann, { email: 'thief@takeover.test', currentPassword: junk });
    assert.equal(res.statusCode, 400, JSON.stringify(junk));
  }

  const untouched = await stored(ann);
  assert.equal(untouched.email, 'ann@takeover.test');
  assert.equal(untouched.firstName, 'Ann', 'the rest of a refused request is not saved either');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.calls.emails.length, since, 'and nobody is emailed');

  // With it, the change goes through; the old address is told, masked, and
  // the new one is asked to confirm.
  const ok = await updateMe(ann, { email: 'ann.new@takeover.test', currentPassword: PASSWORD });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal((await stored(ann)).email, 'ann.new@takeover.test');
  assert.ok(await settle(() => mailTo('ann@takeover.test', since).length === 1 && mailTo('ann.new@takeover.test', since).length === 1));
  const notice = mailTo('ann@takeover.test', since)[0];
  assert.match(notice.subject, /email address was changed/);
  assert.ok(notice.html.includes('an*****@takeover.test'));
  assert.equal(notice.html.includes('ann.new@takeover.test'), false);
  assert.ok(notice.html.includes(ann.username), 'they are told the name they can still sign in with');
  assert.match(mailTo('ann.new@takeover.test', since)[0].subject, /Confirm your email/);
  // The password is never part of what is stored or answered.
  assert.equal('currentPassword' in (await stored(ann)), false);
  assert.equal('currentPassword' in ok.body.data, false);
});

test('a profile saved with the same address, or with none, asks for no password', async () => {
  const ben = await account({ firstName: 'Ben', lastName: 'Same', email: 'ben@takeover.test' });
  const since = h.calls.emails.length;
  // The profile form sends the email box every time.
  const same = await updateMe(ben, { firstName: 'Benjamin', email: 'Ben@Takeover.test', phone: '0300 2220001' });
  assert.equal(same.statusCode, 200, JSON.stringify(same.body));
  assert.equal((await stored(ben)).firstName, 'Benjamin');
  assert.equal((await stored(ben)).emailVerified, true, 'an unchanged address stays confirmed');

  // A member the desk made without an address: an empty box is not a change.
  const pat = await account({ firstName: 'Pat', lastName: 'Phone', phone: '0300 2220002' });
  const none = await updateMe(pat, { firstName: 'Patricia', email: '', phone: '0300 2220003' });
  assert.equal(none.statusCode, 200, JSON.stringify(none.body));
  assert.equal((await stored(pat)).firstName, 'Patricia');

  // Adding one is a change: it becomes where a reset would go.
  const added = await updateMe(pat, { email: 'pat@takeover.test' });
  assert.equal(added.statusCode, 400);
  assert.equal(added.body.code, 'PASSWORD_REQUIRED');
  const withPassword = await updateMe(pat, { email: 'pat@takeover.test', currentPassword: PASSWORD });
  assert.equal(withPassword.statusCode, 200, JSON.stringify(withPassword.body));
  assert.equal((await stored(pat)).emailVerified, false);
  assert.ok(await settle(() => mailTo('pat@takeover.test', since).length === 1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.calls.emails.length, since + 1, 'there was no old address to tell');
});

test('removing the address needs the password too, and the address is told', async () => {
  const cat = await account({ firstName: 'Cat', lastName: 'Clear', email: 'cat@takeover.test' });
  const since = h.calls.emails.length;
  const refused = await updateMe(cat, { email: '' });
  assert.equal(refused.statusCode, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'PASSWORD_REQUIRED');
  assert.match(refused.body.message, /remove your email address/);
  assert.equal((await stored(cat)).email, 'cat@takeover.test');

  const ok = await updateMe(cat, { email: '', currentPassword: PASSWORD });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal('email' in (await stored(cat)), false);
  assert.ok(await settle(() => mailTo('cat@takeover.test', since).length === 1));
  assert.match(mailTo('cat@takeover.test', since)[0].html, /was removed from your/);
});

test('an account that only ever used Google is told how to set a password first', async () => {
  const gus = await inGym(() => User.create({ firstName: 'Gus', lastName: 'Google', email: 'gus@takeover.test', provider: 'google', googleId: 'google-gus', password: null }));
  for (const body of [{ email: 'elsewhere@takeover.test' }, { email: 'elsewhere@takeover.test', currentPassword: 'anything-at-all' }]) {
    const res = await updateMe(gus, body);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'PASSWORD_NOT_SET');
    assert.match(res.body.message, /Forgot password/);
  }
  assert.equal((await stored(gus)).email, 'gus@takeover.test');
  // The rest of their profile saves as before.
  assert.equal((await updateMe(gus, { firstName: 'Gustav', email: 'gus@takeover.test' })).statusCode, 200);

  // Once they have set one (the reset link proves the mailbox), it works.
  await inGym(async () => User.updateOne({ _id: gus._id }, { $set: { password: await bcrypt.hash(PASSWORD, 4) } }));
  assert.equal((await updateMe(gus, { email: 'elsewhere@takeover.test', currentPassword: PASSWORD })).statusCode, 200);
});

test('two-factor sign-in is switched off only with the current password', async () => {
  const dee = await account({ firstName: 'Dee', lastName: 'Double', email: 'dee@takeover.test' });

  // On needs nothing more than being signed in.
  const on = await setTwoFactor(dee, { enabled: true });
  assert.equal(on.statusCode, 200, JSON.stringify(on.body));
  assert.equal((await stored(dee)).twoFactor.enabled, true);

  const missing = await setTwoFactor(dee, { enabled: false });
  assert.equal(missing.statusCode, 400, JSON.stringify(missing.body));
  assert.equal(missing.body.code, 'PASSWORD_REQUIRED');
  assert.match(missing.body.message, /turn off two-factor sign-in/);
  const wrong = await setTwoFactor(dee, { enabled: false, currentPassword: 'not-the-password' });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.body.code, 'PASSWORD_INCORRECT');
  assert.equal((await stored(dee)).twoFactor.enabled, true, 'still on');

  const off = await setTwoFactor(dee, { enabled: false, currentPassword: PASSWORD });
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  assert.equal((await stored(dee)).twoFactor.enabled, false);
  // Already off: nothing to protect, nothing asked.
  assert.equal((await setTwoFactor(dee, { enabled: false })).statusCode, 200);

  const gus = await inGym(() => User.create({ firstName: 'Gia', lastName: 'Google', email: 'gia@takeover.test', provider: 'google', googleId: 'google-gia', password: null, twoFactor: { enabled: true } }));
  const noPassword = await setTwoFactor(gus, { enabled: false });
  assert.equal(noPassword.statusCode, 400);
  assert.equal(noPassword.body.code, 'PASSWORD_NOT_SET');
});
