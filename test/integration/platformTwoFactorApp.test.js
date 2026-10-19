// Super admin two-factor sign-in with an authenticator app, against a real
// MongoDB: the current password wanted to switch the emailed codes off and
// to set up or turn on the app, setting it up (the secret sealed at rest, a code needed before it
// counts), signing in with an app code and with a backup code (each good
// once), the account-wide lock after too many wrong codes, and turning it
// off (password AND a code). Failed sign-ins land in the audit log. No email
// is sent at any point -- that is the reason the app option exists.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let SuperAdmin;
let PlatformAuditLog;
let auth;
let app;
let totp;
let owner;
let secret;
let backupCodes;

const PASSWORD = 'correct horse battery';

const test = h.suite(async () => {
  SuperAdmin = h.src('platform/models/superAdminModel');
  PlatformAuditLog = h.src('platform/models/platformAuditLogModel');
  auth = h.src('platform/controllers/platformAuthController');
  app = h.src('platform/controllers/platformTwoFactorController');
  totp = h.src('platform/totp');
  owner = await SuperAdmin.create({ name: 'Owner', email: 'owner@platform.test', password: await bcrypt.hash(PASSWORD, 4) });
});

// What platformAuth puts on the request: the account, re-read, lean.
async function signedIn(admin = owner) {
  return { superAdmin: await SuperAdmin.findById(admin._id).lean() };
}

async function audit(action, where = {}) {
  // record() does not wait for the write, so poll for the row the step should
  // have left rather than guess how long a busy machine takes (an older row
  // for the same action may already be there).
  const until = Date.now() + 5000;
  for (;;) {
    const rows = await PlatformAuditLog.find({ action, ...where }).sort({ createdAt: -1 }).lean();
    if (rows.length || Date.now() > until) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function login(email = owner.email, password = PASSWORD) {
  return h.call(auth.login, { body: { email, password } });
}

test('a wrong password is refused and written to the audit log', async () => {
  const res = await login(owner.email, 'not the password');
  assert.equal(res.statusCode, 401);
  const rows = await audit('login_failed');
  assert.equal(rows[0].actorEmail, owner.email);
  assert.equal(rows[0].meta.reason, 'wrong_password');
});

test('a signed-in session alone cannot switch the emailed codes off: that wants the current password', async () => {
  const stored = async () => (await SuperAdmin.findById(owner._id).lean()).twoFactor || {};
  // On needs none: it only adds a step whose codes go to the account's own address.
  const on = await h.call(auth.setTwoFactor, { ...(await signedIn()), body: { enabled: true } });
  assert.equal(on.statusCode, 200, JSON.stringify(on.body));
  assert.equal((await stored()).enabled, true);

  const none = await h.call(auth.setTwoFactor, { ...(await signedIn()), body: { enabled: false } });
  assert.equal(none.statusCode, 400);
  assert.equal(none.body.code, 'PASSWORD_REQUIRED');
  const wrong = await h.call(auth.setTwoFactor, { ...(await signedIn()), body: { enabled: false, currentPassword: 'not the password' } });
  // 400, never 401: the panel signs out on a 401.
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.body.code, 'PASSWORD_INCORRECT');
  assert.equal((await stored()).enabled, true, 'still on');

  const off = await h.call(auth.setTwoFactor, { ...(await signedIn()), body: { enabled: false, currentPassword: PASSWORD } });
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  assert.equal((await stored()).enabled, false);
  const row = (await audit('two_factor_change_failed', { 'meta.step': 'email' }))[0];
  assert.equal(row.meta.reason, 'wrong_password');
});

test('setting up an app wants the current password before any secret is handed out', async () => {
  for (const [body, code] of [[{}, 'PASSWORD_REQUIRED'], [{ currentPassword: 'not the password' }, 'PASSWORD_INCORRECT']]) {
    const res = await h.call(app.setup, { ...(await signedIn()), body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, code);
    assert.equal(res.body.data, undefined);
  }
  const raw = await SuperAdmin.collection.findOne({ _id: owner._id });
  assert.ok(!(raw.twoFactor && raw.twoFactor.totp && raw.twoFactor.totp.pendingSecret), 'no secret was made');
  assert.equal((await audit('two_factor_change_failed', { 'meta.step': 'app_setup' }))[0].meta.reason, 'wrong_password');
});

test('setup hands out a secret and a QR URL, sealed at rest, and changes nothing yet', async () => {
  const res = await h.call(app.setup, { ...(await signedIn()), body: { currentPassword: PASSWORD } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  secret = res.body.data.secret;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.ok(res.body.data.otpauth_url.startsWith('otpauth://totp/'));
  assert.ok(res.body.data.otpauth_url.includes(`secret=${secret}`));

  const raw = await SuperAdmin.collection.findOne({ _id: owner._id });
  assert.ok(raw.twoFactor.totp.pendingSecret.startsWith('enc:v1:'), 'sealed, not plaintext');
  assert.ok(!JSON.stringify(raw).includes(secret));
  assert.equal(raw.twoFactor.enabled, false);
});

test('a session that knows the secret still cannot put the app in without the password', async () => {
  for (const [extra, code] of [[{}, 'PASSWORD_REQUIRED'], [{ currentPassword: 'not the password' }, 'PASSWORD_INCORRECT']]) {
    const res = await h.call(app.enable, { ...(await signedIn()), body: { code: totp.totp(secret), ...extra } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, code);
  }
  assert.equal((await SuperAdmin.findById(owner._id).lean()).twoFactor.enabled, false);
  assert.equal((await audit('two_factor_change_failed', { 'meta.step': 'app_enable' }))[0].meta.reason, 'wrong_password');
});

test('enabling needs a right code; then backup codes are shown once and kept hashed', async () => {
  const wrong = await h.call(app.enable, { ...(await signedIn()), body: { code: totp.totp(secret, Date.now() - 5 * 60000), currentPassword: PASSWORD } });
  assert.equal(wrong.statusCode, 400);
  assert.equal((await SuperAdmin.findById(owner._id).lean()).twoFactor.enabled, false);

  const res = await h.call(app.enable, { ...(await signedIn()), body: { code: totp.totp(secret), currentPassword: PASSWORD } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  backupCodes = res.body.backup_codes;
  assert.equal(backupCodes.length, 10);
  assert.equal(res.body.admin.two_factor, true);
  assert.equal(res.body.admin.two_factor_method, 'app');
  assert.equal(res.body.admin.backup_codes_left, 10);

  const raw = await SuperAdmin.collection.findOne({ _id: owner._id });
  assert.equal(raw.twoFactor.method, 'totp');
  assert.ok(raw.twoFactor.totp.secret.startsWith('enc:v1:'));
  assert.equal(raw.twoFactor.totp.pendingSecret, null);
  assert.ok(!JSON.stringify(raw).includes(secret));
  assert.ok(!backupCodes.some((code) => JSON.stringify(raw).includes(code)));

  const rows = await audit('two_factor_enabled');
  assert.equal(rows[0].meta.method, 'totp');
});

test('the email switch cannot turn the app off', async () => {
  const res = await h.call(auth.setTwoFactor, { ...(await signedIn()), body: { enabled: false, currentPassword: PASSWORD } });
  assert.equal(res.statusCode, 409);
  assert.equal((await SuperAdmin.findById(owner._id).lean()).twoFactor.enabled, true);
});

test('sign-in asks for the app code, sends no email, and takes a code once', async () => {
  const emailsBefore = h.calls.emails.length;
  const first = await login();
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.requires2fa, true);
  assert.equal(first.body.method, 'app');
  assert.equal(first.body.token, undefined);
  assert.equal(h.calls.emails.length, emailsBefore, 'nothing emailed');

  const wrong = await h.call(auth.verifyTwoFactor, { body: { challengeId: first.body.challengeId, code: '000000' === totp.totp(secret) ? '111111' : '000000' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal((await audit('login_failed', { 'meta.reason': 'wrong_code' })).length, 1);

  // The step after the one enable used: still inside the ±1 window.
  const code = totp.totp(secret, Date.now() + 30000);
  const ok = await h.call(auth.verifyTwoFactor, { body: { challengeId: first.body.challengeId, code } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
  assert.equal((await audit('login'))[0].meta.method, 'app');

  // The same code again, on a fresh sign-in: spent.
  const again = await login();
  const replay = await h.call(auth.verifyTwoFactor, { body: { challengeId: again.body.challengeId, code } });
  assert.equal(replay.statusCode, 401);
});

test('a backup code signs in once, and then is gone', async () => {
  const first = await login();
  const ok = await h.call(auth.verifyTwoFactor, { body: { challengeId: first.body.challengeId, code: backupCodes[0].toUpperCase() } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.admin.backup_codes_left, 9);
  const row = (await audit('login', { 'meta.backupCode': true }))[0];
  assert.equal(row.meta.backupCode, true);
  assert.equal(row.meta.backupCodesLeft, 9);

  const second = await login();
  const reused = await h.call(auth.verifyTwoFactor, { body: { challengeId: second.body.challengeId, code: backupCodes[0] } });
  assert.equal(reused.statusCode, 401);
  const raw = await SuperAdmin.collection.findOne({ _id: owner._id });
  assert.equal(raw.twoFactor.totp.backupCodes.length, 9);
});

test('turning it off needs the password and a code', async () => {
  const noPassword = await h.call(app.disable, { ...(await signedIn()), body: { password: 'wrong password!', code: backupCodes[1] } });
  assert.equal(noPassword.statusCode, 400);
  assert.equal(noPassword.body.code, 'WRONG_PASSWORD');
  assert.equal((await audit('two_factor_disable_failed'))[0].meta.reason, 'wrong_password');

  const noCode = await h.call(app.disable, { ...(await signedIn()), body: { password: PASSWORD, code: 'aaaaa-aaaaa' } });
  assert.equal(noCode.statusCode, 400);
  assert.equal((await SuperAdmin.findById(owner._id).lean()).twoFactor.enabled, true);

  const ok = await h.call(app.disable, { ...(await signedIn()), body: { password: PASSWORD, code: backupCodes[1] } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.admin.two_factor, false);
  const raw = await SuperAdmin.collection.findOne({ _id: owner._id });
  assert.equal(raw.twoFactor.enabled, false);
  assert.equal(raw.twoFactor.totp.secret, null);
  assert.deepEqual(raw.twoFactor.totp.backupCodes, []);
  assert.equal((await audit('two_factor_disabled'))[0].meta.method, 'totp');

  // And sign-in is one step again.
  const res = await login();
  assert.ok(res.body.token);
});

test('too many wrong codes lock the account for a while, whatever challenge they came in on', async () => {
  const other = await SuperAdmin.create({ email: 'second@platform.test', password: await bcrypt.hash(PASSWORD, 4) });
  const setup = await h.call(app.setup, { ...(await signedIn(other)), body: { currentPassword: PASSWORD } });
  const otherSecret = setup.body.data.secret;
  await h.call(app.enable, { ...(await signedIn(other)), body: { code: totp.totp(otherSecret), currentPassword: PASSWORD } });

  const wrongCode = totp.totp(otherSecret) === '000000' ? '111111' : '000000';
  let last;
  for (let i = 0; i < app.MAX_FAILURES; i += 1) {
    // A fresh sign-in every few tries: the count is the account's, not the challenge's.
    const start = await login(other.email);
    last = await h.call(auth.verifyTwoFactor, { body: { challengeId: start.body.challengeId, code: wrongCode } });
  }
  assert.equal(last.statusCode, 429, JSON.stringify(last.body));

  // Locked: even the right code waits.
  const start = await login(other.email);
  const right = await h.call(auth.verifyTwoFactor, { body: { challengeId: start.body.challengeId, code: totp.totp(otherSecret, Date.now() + 30000) } });
  assert.equal(right.statusCode, 429);
});
