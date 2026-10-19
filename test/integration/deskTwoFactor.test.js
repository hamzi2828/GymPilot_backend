// The desk app's and the web kiosk's sign-in, against a real MongoDB and over
// HTTP through index.js as it runs: an account the website puts through
// two-step sign-in is put through it at the desk too. The password answers
// `requires2fa` with a challenge and no token; POST /api/desktop/login/2fa
// with the emailed code answers exactly what a plain desk sign-in answers. A
// wrong code may be tried again, a spent or stale one means signing in again,
// and an email that cannot be sent is a refusal, never a way round.
//
// index.js is loaded the way deskLink.test.js loads it: dotenv replaced first,
// the app captured at listen() and served on a port of this test's.

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

const INDEX = path.resolve(__dirname, '..', '..', 'index.js');
const PASSWORD = 'desk-two-step-1';

let server;
let base;
let gym;
let strictGym;
let User;
let DesktopToken;
let AttendanceLog;

const test = h.suite(async () => {
  gym = await h.createGym('desk-2fa-gym', { name: 'Two Step Gym' });
  // Requires the second step of every staff account (Settings).
  strictGym = await h.createGym('desk-2fa-strict', { name: 'Strict Gym', settings: { twoFactorAuth: true } });

  User = h.src('models/user');
  DesktopToken = h.src('attendance/models/desktopTokenModel');
  AttendanceLog = h.src('attendance/models/attendanceLogModel');
  for (const g of [gym, strictGym]) await h.inGym(g, () => h.ensureIndexes(User, DesktopToken));
  // The harness silences every export of gymNotifications, the brand lookup
  // the code email is worded with included.
  h.src('services/gymNotifications').brand = async () => ({ siteName: 'Two Step Gym' });

  const dotenvPath = require.resolve('dotenv');
  require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config: () => ({ parsed: {} }) } };

  const express = require('express');
  const listen = express.application.listen;
  let app;
  express.application.listen = function captured() {
    app = this;
    return { close() {} };
  };
  try {
    require(INDEX);
  } finally {
    express.application.listen = listen;
  }

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

require('node:test').after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function send(url, body, target = gym) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Host': `${target.slug}.test` },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

let seq = 0;
async function deskAccount(fields = {}, target = gym) {
  seq += 1;
  const hash = await bcrypt.hash(PASSWORD, 4);
  return h.inGym(target, () =>
    User.create({
      firstName: 'Desk',
      lastName: `Person${seq}`,
      email: `desk${seq}@two-step.test`,
      password: hash,
      role: 'receptionist',
      employment: { isStaff: true },
      allowAttendanceApp: true,
      ...fields
    })
  );
}

const DEVICE = { client_app: 'GymPilotAttendanceDesktop/1.5.0', device_label: 'FRONT-PC', client_os_user: 'frontdesk' };
const login = (user, extra = {}, target = gym) =>
  send('/api/desktop/login', { email: user.email, password: PASSWORD, ...DEVICE, ...extra }, target);
const submit = (challengeId, code, extra = {}, target = gym) =>
  send('/api/desktop/login/2fa', { challenge_id: challengeId, code, ...DEVICE, ...extra }, target);
const tokensOf = (user, target = gym) => h.inGym(target, () => DesktopToken.countDocuments({ userId: user._id }));
const otherCode = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');

// The password step, and the code it emailed.
async function challengeFor(user, extra = {}, target = gym) {
  const since = h.calls.emails.length;
  const res = await login(user, extra, target);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.requires2fa, true, JSON.stringify(res.body));
  const mail = h.calls.emails.slice(since).find((m) => m.to === user.email);
  assert.ok(mail, 'the code was emailed to the account');
  return { body: res.body, challengeId: res.body.challenge_id, code: mail.html.match(/>(\d{6})</)[1] };
}

function assertSession(body, user) {
  assert.equal(body.success, true, JSON.stringify(body));
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.ok(new Date(body.expires_at).getTime() > Date.now() + 29 * 86400000);
  assert.ok(body.theme && typeof body.theme === 'object');
  assert.deepEqual(body.user, {
    id: String(user._id),
    name: `${user.firstName} ${user.lastName}`,
    username: user.email,
    location: '',
    can_enroll: false
  });
}

test('an account without two-step sign-in is signed straight in, as before', async () => {
  const plain = await deskAccount();
  const res = await login(plain);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertSession(res.body, plain);
  assert.equal(res.body.requires2fa, undefined);
  assert.equal(await tokensOf(plain), 1);
});

test('two-step sign-in switched on: the password gets a challenge and no token; the emailed code signs the desk in', async () => {
  const tess = await deskAccount({ twoFactor: { enabled: true } });
  const { body, challengeId, code } = await challengeFor(tess);

  assert.deepEqual(Object.keys(body).sort(), ['challenge_id', 'message', 'method', 'requires2fa', 'success']);
  assert.equal(body.success, false);
  assert.equal(body.method, 'email');
  assert.match(body.challenge_id, /^[a-f0-9]{32}$/);
  assert.match(body.message, /^Enter the 6-digit code we emailed to de\*+@two-step\.test\.$/);
  assert.equal(await tokensOf(tess), 0, 'no token before the code');

  // A wrong code: tried again.
  const wrong = await submit(challengeId, otherCode(code));
  assert.equal(wrong.status, 401, JSON.stringify(wrong.body));
  assert.deepEqual(wrong.body, { success: false, code: 'TWO_FACTOR_INVALID', message: 'That code is not right. 4 attempt(s) left.' });
  // Not even six digits: the same, and no try used.
  const short = await submit(challengeId, '12');
  assert.equal(short.status, 401);
  assert.equal(short.body.code, 'TWO_FACTOR_INVALID');
  assert.equal(await tokensOf(tess), 0);

  // The right one: exactly a desk sign-in, on the PC the code step names.
  const done = await submit(challengeId, code, { device_label: 'COUNTER-2' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assertSession(done.body, tess);
  const plainKeys = Object.keys((await login(await deskAccount())).body).sort();
  assert.deepEqual(Object.keys(done.body).sort(), plainKeys, 'the same body as a plain sign-in');

  const tokens = await h.inGym(gym, () => DesktopToken.find({ userId: tess._id }).lean());
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].deviceLabel, 'COUNTER-2');
  const session = await fetch(base + '/api/desktop/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tenant-Host': `${gym.slug}.test`, Authorization: `Bearer ${done.body.token}` },
    body: '{}'
  });
  assert.equal(session.status, 200);

  // Single use: the same code again is over.
  const again = await submit(challengeId, code);
  assert.equal(again.status, 401);
  assert.equal(again.body.code, 'TWO_FACTOR_EXPIRED');
  assert.equal(await tokensOf(tess), 1);

  // The trail has the wrong code and the sign-in, after the response.
  let rows = [];
  for (let i = 0; i < 50 && rows.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    rows = await h.inGym(gym, () => AttendanceLog.find({ userId: tess._id }).lean());
  }
  assert.ok(rows.some((r) => r.event === 'login_denied' && r.message === 'Wrong sign-in code'));
  assert.ok(rows.some((r) => r.event === 'login' && r.meta && r.meta.twoFactor === true));
});

test('a gym that requires two-step sign-in of staff gets it at the desk and the kiosk', async () => {
  const rita = await deskAccount({}, strictGym);
  const { challengeId, code } = await challengeFor(rita, { client_app: 'GymPilotKiosk/1.0', device_label: 'Kiosk' }, strictGym);
  assert.equal(await tokensOf(rita, strictGym), 0);

  const done = await submit(challengeId, code, { client_app: 'GymPilotKiosk/1.0', device_label: 'Kiosk' }, strictGym);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assertSession(done.body, rita);
  const [token] = await h.inGym(strictGym, () => DesktopToken.find({ userId: rita._id }).lean());
  assert.equal(token.clientApp, 'GymPilotKiosk/1.0', 'a kiosk token, from what signed in');
});

test('five wrong codes end the challenge, and so does its ten minutes', async () => {
  const tess = await deskAccount({ twoFactor: { enabled: true } });
  const { challengeId, code } = await challengeFor(tess);
  for (let i = 0; i < 4; i += 1) {
    const res = await submit(challengeId, otherCode(code));
    assert.equal(res.body.code, 'TWO_FACTOR_INVALID', JSON.stringify(res.body));
  }
  const fifth = await submit(challengeId, otherCode(code));
  assert.equal(fifth.status, 401);
  assert.equal(fifth.body.code, 'TWO_FACTOR_EXPIRED', 'the fifth wrong code is the last');
  assert.match(fifth.body.message, /Too many wrong codes/);
  const late = await submit(challengeId, code);
  assert.equal(late.body.code, 'TWO_FACTOR_EXPIRED', 'even the right code, now');
  assert.equal(await tokensOf(tess), 0);

  const stale = await challengeFor(tess);
  await h.inGym(gym, () => User.updateOne({ _id: tess._id }, { $set: { 'twoFactor.pending.expiresAt': new Date(Date.now() - 1000) } }));
  const expired = await submit(stale.challengeId, stale.code);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, 'TWO_FACTOR_EXPIRED');
  assert.match(expired.body.message, /expired/);

  const nobody = await submit('0123456789abcdef0123456789abcdef', '123456');
  assert.equal(nobody.status, 401);
  assert.equal(nobody.body.code, 'TWO_FACTOR_EXPIRED');
  const none = await submit('', '123456');
  assert.equal(none.status, 400);
  assert.equal(await tokensOf(tess), 0);
});

test('a code that cannot be emailed is a refusal, never a sign-in without it', async () => {
  const tess = await deskAccount({ twoFactor: { enabled: true } });
  h.setEmailFailure('535 Authentication failed');
  try {
    const res = await login(tess);
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.deepEqual(res.body, { success: false, message: 'We could not email your sign-in code. Please contact the gym.' });
  } finally {
    h.setEmailFailure(null);
  }
  assert.equal(await tokensOf(tess), 0);

  // No address to send it to: said as the website says it.
  seq += 1;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const noMail = await h.inGym(strictGym, () =>
    User.create({ firstName: 'No', lastName: 'Mail', username: `nomail${seq}`, password: hash, role: 'receptionist', employment: { isStaff: true }, allowAttendanceApp: true })
  );
  const refused = await send('/api/desktop/login', { email: noMail.username, password: PASSWORD, ...DEVICE }, strictGym);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.success, false);
  assert.match(refused.body.message, /no email address/);
  assert.equal(await tokensOf(noMail, strictGym), 0);
});

test('the grant and the account are read again at the code step', async () => {
  const tess = await deskAccount({ twoFactor: { enabled: true } });

  const first = await challengeFor(tess);
  await h.inGym(gym, () => User.updateOne({ _id: tess._id }, { $set: { allowAttendanceApp: false } }));
  const noGrant = await submit(first.challengeId, first.code);
  assert.equal(noGrant.status, 403, JSON.stringify(noGrant.body));
  assert.match(noGrant.body.message, /not allowed to use the attendance app/);
  await h.inGym(gym, () => User.updateOne({ _id: tess._id }, { $set: { allowAttendanceApp: true } }));

  const second = await challengeFor(tess);
  await h.inGym(gym, () => User.updateOne({ _id: tess._id }, { $set: { isActive: false } }));
  const off = await submit(second.challengeId, second.code);
  assert.equal(off.status, 403, JSON.stringify(off.body));
  assert.equal(await tokensOf(tess), 0);

  // Without the grant the password step says so and emails nothing.
  await h.inGym(gym, () => User.updateOne({ _id: tess._id }, { $set: { isActive: true, allowAttendanceApp: false } }));
  const since = h.calls.emails.length;
  const denied = await login(tess);
  assert.equal(denied.status, 403);
  assert.equal(h.calls.emails.length, since, 'no code for a sign-in that could not finish');
});

test('a challenge from one gym is nobody at another', async () => {
  const tess = await deskAccount({ twoFactor: { enabled: true } });
  const { challengeId, code } = await challengeFor(tess);
  const elsewhere = await submit(challengeId, code, {}, strictGym);
  assert.equal(elsewhere.status, 401);
  assert.equal(elsewhere.body.code, 'TWO_FACTOR_EXPIRED');
  // ...and still good at its own.
  const home = await submit(challengeId, code);
  assert.equal(home.status, 200, JSON.stringify(home.body));
});

test('guessing codes is cut off by the limiters', async () => {
  // Ends the file: the limiters' counts are per process, and this spends them.
  const guess = () => submit('feedfacefeedfacefeedfacefeedface', '000000');
  let res;
  for (let i = 0; i < 21; i += 1) {
    res = await guess();
    if (res.status === 429) break;
    assert.equal(res.status, 401, JSON.stringify(res.body));
  }
  assert.equal(res.status, 429);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Too many sign-in attempts/);
});
