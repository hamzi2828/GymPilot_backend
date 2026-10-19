// Linking a front-desk PC with a one-time code from the admin panel
// (platform/controllers/deskLinkController.js), over HTTP through index.js
// as it runs: a code is made on a gym's site, redeemed with no gym named,
// and the desk session it hands back works at that gym and nowhere else.
// A code works once, not after it expires, not for an account without the
// front-desk grant, and not for a suspended gym.
//
// index.js is loaded the way serverBasics.test.js loads it: dotenv replaced
// first, the app captured at listen() and served on a port of this test's.

const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

const INDEX = path.resolve(__dirname, '..', '..', 'index.js');

let server;
let base;
let gymA;
let gymB;
let gymC;
let Gym;
let User;
let DeskLinkCode;
let DesktopToken;
let PlatformAuditLog;
let link;

// People, by gym.
let ownerA; // administrator, front-desk grant off
let rita; // receptionist with the grant
let tom; // trainer without it
let ownerB;
let ownerC;

const test = h.suite(async () => {
  gymA = await h.createGym('link-gym-a', { name: 'Iron Works' });
  gymB = await h.createGym('link-gym-b', { name: 'Other Gym' });
  gymC = await h.createGym('link-gym-c', { name: 'Paused Gym' });

  Gym = h.src('platform/models/gymModel');
  User = h.src('models/user');
  DeskLinkCode = h.src('platform/models/deskLinkCodeModel');
  DesktopToken = h.src('attendance/models/desktopTokenModel');
  PlatformAuditLog = h.src('platform/models/platformAuditLogModel');
  link = h.src('platform/controllers/deskLinkController');
  const { ensureDefaultRoles } = h.src('services/roleService');

  await h.inGym(gymA, async () => {
    await ensureDefaultRoles();
    ownerA = await User.create({ firstName: 'Omar', lastName: 'Owner', email: 'omar@a.test', role: 'admin' });
    rita = await User.create({
      firstName: 'Rita',
      lastName: 'Desk',
      email: 'rita@a.test',
      role: 'receptionist',
      employment: { isStaff: true },
      allowAttendanceApp: true,
      allowFingerprintEnrollment: true
    });
    tom = await User.create({ firstName: 'Tom', lastName: 'Trainer', email: 'tom@a.test', role: 'trainer', employment: { isStaff: true } });
  });
  await h.inGym(gymB, async () => {
    await ensureDefaultRoles();
    ownerB = await User.create({ firstName: 'Bina', lastName: 'Owner', email: 'bina@b.test', role: 'admin' });
  });
  await h.inGym(gymC, async () => {
    await ensureDefaultRoles();
    ownerC = await User.create({ firstName: 'Cyrus', lastName: 'Owner', email: 'cyrus@c.test', role: 'admin', allowAttendanceApp: true });
  });

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

const hostOf = (gym) => `${gym.slug}.test`;

function staffToken(user, gym) {
  return jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, {
    expiresIn: '5m'
  });
}

async function send(method, url, { headers = {}, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
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

// The admin panel: a staff session on the gym's own site.
const asStaff = (user, gym, sentTo = gym) => ({
  'X-Tenant-Host': hostOf(sentTo),
  Authorization: `Bearer ${staffToken(user, gym)}`
});

const makeCode = (user, gym, body) => send('POST', '/api/desk-link/codes', { headers: asStaff(user, gym), body });

// The Windows app: no gym named, no session.
const redeem = (code, extra = {}) =>
  send('POST', '/api/desk-link/redeem', { body: { code, device_name: 'FRONT-PC', client_app: 'GymPilotAttendanceDesktop/1.2.0', ...extra } });

const deskSession = (token, gym) =>
  send('POST', '/api/desktop/session', { headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Host': hostOf(gym) } });

test('codes: 8 characters with no look-alikes, typed any way, stored only as a keyed hash', () => {
  for (let i = 0; i < 200; i += 1) {
    const raw = link.generateCode();
    assert.match(raw, /^[2-9A-HJ-NP-Z]{8}$/);
    assert.match(link.formatCode(raw), /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  }
  assert.equal(link.normalizeCode(' k7qp-3m9x '), 'K7QP3M9X');
  assert.equal(link.normalizeCode('K7QP 3M9X'), 'K7QP3M9X');
  for (const bad of ['', 'K7QP-3M9', 'K7QP-3M9XX', 'O7QP-3M9X', 'I7QP-3M9X', '17QP-3M9X', '07QP-3M9X', null]) {
    assert.equal(link.normalizeCode(bad), null, String(bad));
  }
  assert.notEqual(link.hashCode('K7QP3M9X'), require('crypto').createHash('sha256').update('K7QP3M9X').digest('hex'));
});

test('a code made in the panel links the desk: gym, address and a desk session that works at that gym only', async () => {
  const made = await makeCode(rita, gymA);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { code, expires_at: expiresAt, minutes, granted_app_access: granted } = made.body.data;
  assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(minutes, 15);
  assert.equal(granted, false);
  const left = new Date(expiresAt).getTime() - Date.now();
  assert.ok(left > 14 * 60000 && left <= 15 * 60000, `${left}ms left`);

  // Only the hash is kept, in the platform database.
  const stored = await DeskLinkCode.findOne({ userId: rita._id }).lean();
  assert.ok(stored);
  assert.equal(String(stored.gymId), String(gymA._id));
  assert.equal(stored.usedAt, null);
  assert.ok(!JSON.stringify(stored).includes(code.replace('-', '')));
  assert.ok(!JSON.stringify(stored).includes(code));

  // Typed the way people type it: lower case, no dash.
  const linked = await redeem(code.replace('-', '').toLowerCase());
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.deepEqual(linked.body.gym, { name: 'Iron Works', slug: 'link-gym-a', domain: 'link-gym-a.test' });
  assert.equal(linked.body.api_base_url, `${base}/`);

  // The session is what /api/desktop/login answers.
  const session = linked.body.session;
  assert.equal(session.success, true);
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.ok(new Date(session.expires_at).getTime() > Date.now() + 29 * 86400000);
  assert.equal(session.user.id, String(rita._id));
  assert.equal(session.user.name, 'Rita Desk');
  assert.equal(session.user.can_enroll, true);
  assert.ok(session.theme && typeof session.theme === 'object');

  // A desk token in the gym's own database, named after the PC.
  const tokens = await h.inGym(gymA, () => DesktopToken.find({ userId: rita._id }).lean());
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].deviceLabel, 'FRONT-PC');
  assert.equal(await h.inGym(gymB, () => DesktopToken.countDocuments({})), 0);

  // Works at its gym...
  const here = await deskSession(session.token, gymA);
  assert.equal(here.status, 200, JSON.stringify(here.body));
  assert.equal(here.body.user.id, String(rita._id));
  // ...and is nobody at another.
  const there = await deskSession(session.token, gymB);
  assert.equal(there.status, 401);

  // Spent, atomically, and only once.
  const again = await redeem(code);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'CODE_USED');
  assert.match(again.body.message, /already used/);
  const spent = await DeskLinkCode.findById(stored._id).lean();
  assert.ok(spent.usedAt);
  assert.equal(spent.usedDevice, 'FRONT-PC');

  // In the platform's trail -- written after the response, so given a moment.
  let trail = [];
  for (let i = 0; i < 50 && trail.length < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    trail = await PlatformAuditLog.find({ gymId: gymA._id, action: /^desk_link\./ }).lean();
  }
  assert.ok(trail.some((row) => row.action === 'desk_link.code_created'));
  assert.ok(trail.some((row) => row.action === 'desk_link.redeemed'));
  assert.ok(trail.some((row) => row.action === 'desk_link.refused' && row.meta.reason === 'CODE_USED'));
});

test('two desks racing for one code: exactly one is linked', async () => {
  const { code } = (await makeCode(rita, gymA)).body.data;
  const results = await Promise.all([redeem(code, { device_name: 'PC-1' }), redeem(code, { device_name: 'PC-2' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test('an expired code is refused in plain words', async () => {
  const { code } = (await makeCode(rita, gymA)).body.data;
  await DeskLinkCode.updateOne({ userId: rita._id, usedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const res = await redeem(code);
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'CODE_EXPIRED');
  assert.match(res.body.message, /expired — get a new one in your admin panel/);
});

test('an account without the front-desk grant cannot make a code; an administrator has it switched on only once they confirm', async () => {
  const before = await DeskLinkCode.countDocuments({});
  const refused = await makeCode(tom, gymA);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'DESK_APP_NOT_ALLOWED');
  assert.match(refused.body.message, /Staff page/);
  // Asking for the grant is no way round it for anyone but an administrator.
  const selfGrant = await makeCode(tom, gymA, { grant_desk_access: true });
  assert.equal(selfGrant.status, 403);
  assert.equal(selfGrant.body.code, 'DESK_APP_NOT_ALLOWED');
  assert.ok(!(await h.inGym(gymA, () => User.findById(tom._id).lean())).allowAttendanceApp);
  assert.equal(await DeskLinkCode.countDocuments({}), before);

  // The page knows before the button is pressed.
  const page = await send('GET', '/api/desk-link', { headers: asStaff(tom, gymA) });
  assert.equal(page.status, 200);
  assert.equal(page.body.data.can_link, false);
  assert.match(page.body.data.not_allowed_reason, /Staff page/);

  const ownerPage = await send('GET', '/api/desk-link', { headers: asStaff(ownerA, gymA) });
  assert.equal(ownerPage.body.data.can_link, true);
  assert.equal(ownerPage.body.data.grants_access_on_link, true);

  // An administrator without the grant is asked first: no code, no grant.
  for (const body of [undefined, {}, { grant_desk_access: 'true' }, { grant_desk_access: 1 }]) {
    const asked = await makeCode(ownerA, gymA, body);
    assert.equal(asked.status, 409, JSON.stringify(asked.body));
    assert.deepEqual(asked.body, {
      success: false,
      code: 'DESK_PERMISSION_REQUIRED',
      message: 'Your account is not allowed to run the desk app yet.'
    });
  }
  assert.ok(!(await h.inGym(gymA, () => User.findById(ownerA._id).lean())).allowAttendanceApp);
  assert.equal(await DeskLinkCode.countDocuments({}), before);

  // Confirmed: switched on, recorded, and the code made.
  const first = await makeCode(ownerA, gymA, { grant_desk_access: true });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.granted_app_access, true);
  assert.equal((await h.inGym(gymA, () => User.findById(ownerA._id).lean())).allowAttendanceApp, true);
  const second = await makeCode(ownerA, gymA);
  assert.equal(second.status, 201, 'once on, nothing to confirm');
  assert.equal(second.body.data.granted_app_access, false);

  let granted = [];
  for (let i = 0; i < 50 && !granted.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    granted = await PlatformAuditLog.find({ gymId: gymA._id, action: 'desk_link.desk_access_granted' }).lean();
  }
  assert.equal(granted.length, 1);
  assert.equal(granted[0].meta.userId, String(ownerA._id));

  const linked = await redeem(second.body.data.code);
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.session.user.id, String(ownerA._id));
});

test('a grant switched off after the code was made stops the link', async () => {
  const { code } = (await makeCode(rita, gymA)).body.data;
  await h.inGym(gymA, () => User.updateOne({ _id: rita._id }, { $set: { allowAttendanceApp: false } }));
  try {
    const res = await redeem(code);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'DESK_APP_NOT_ALLOWED');
  } finally {
    await h.inGym(gymA, () => User.updateOne({ _id: rita._id }, { $set: { allowAttendanceApp: true } }));
  }
});

test('gyms are kept apart: a session from one gym cannot make codes at another, and each code links its own gym', async () => {
  // Rita's panel session presented on gym B's site.
  const crossed = await send('POST', '/api/desk-link/codes', { headers: asStaff(rita, gymA, gymB) });
  assert.equal(crossed.status, 401);
  assert.equal(crossed.body.code, 'TOKEN_WRONG_GYM');

  const { code } = (await makeCode(ownerB, gymB, { grant_desk_access: true })).body.data;
  const linked = await redeem(code);
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.gym.slug, 'link-gym-b');
  assert.equal(linked.body.gym.domain, 'link-gym-b.test');
  assert.equal((await deskSession(linked.body.session.token, gymB)).status, 200);
  assert.equal((await deskSession(linked.body.session.token, gymA)).status, 401);
  assert.equal(await h.inGym(gymB, () => DesktopToken.countDocuments({ userId: ownerB._id })), 1);
});

test('a suspended gym is not linked', async () => {
  const { code } = (await makeCode(ownerC, gymC)).body.data;
  await Gym.updateOne({ _id: gymC._id }, { $set: { status: 'suspended' } });
  try {
    const res = await redeem(code);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'TENANT_SUSPENDED');
    assert.equal(await h.inGym(gymC, () => DesktopToken.countDocuments({})), 0);
  } finally {
    await Gym.updateOne({ _id: gymC._id }, { $set: { status: 'active' } });
  }
});

test('a fourth waiting code replaces the oldest', async () => {
  await DeskLinkCode.updateMany({ userId: ownerC._id }, { $set: { usedAt: new Date() } });
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push((await makeCode(ownerC, gymC)).body.data.code);
  const waiting = await DeskLinkCode.countDocuments({ userId: ownerC._id, usedAt: null, revokedAt: null });
  assert.equal(waiting, link.MAX_ACTIVE_CODES);

  const oldest = await redeem(codes[0]);
  assert.equal(oldest.status, 410);
  assert.match(oldest.body.message, /replaced by a newer one/);
  assert.equal((await redeem(codes[3])).status, 200);
});

test('the desks page lists signed-in desks, and Unlink signs one out on its next request', async () => {
  const { code } = (await makeCode(rita, gymA)).body.data;
  const { token } = (await redeem(code, { device_name: 'COUNTER-2' })).body.session;

  // A receptionist (attendance at manage) sees the gym's desks.
  const page = await send('GET', '/api/desk-link', { headers: asStaff(rita, gymA) });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.data.scope, 'all');
  const row = page.body.data.desks.find((d) => d.device === 'COUNTER-2');
  assert.ok(row, JSON.stringify(page.body.data.desks));
  assert.equal(row.account, 'Rita Desk');
  assert.equal(row.kind, 'desk');
  assert.equal(row.mine, true);

  // A trainer (attendance at view) sees only their own: none.
  const own = await send('GET', '/api/desk-link', { headers: asStaff(tom, gymA) });
  assert.equal(own.body.data.scope, 'own');
  assert.deepEqual(own.body.data.desks, []);
  const notTheirs = await send('POST', `/api/desk-link/desks/${row.id}/unlink`, { headers: asStaff(tom, gymA) });
  assert.equal(notTheirs.status, 404);
  // Nor from another gym.
  const elsewhere = await send('POST', `/api/desk-link/desks/${row.id}/unlink`, { headers: asStaff(ownerB, gymB) });
  assert.equal(elsewhere.status, 404);
  assert.equal((await deskSession(token, gymA)).status, 200);

  const unlinked = await send('POST', `/api/desk-link/desks/${row.id}/unlink`, { headers: asStaff(ownerA, gymA) });
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
  assert.equal((await deskSession(token, gymA)).status, 401);
  const after = await send('GET', '/api/desk-link', { headers: asStaff(ownerA, gymA) });
  assert.ok(!after.body.data.desks.some((d) => d.id === row.id));
});

test('guessing is cut off: wrong codes from one address are refused after ten', async () => {
  // Ends the file: the limiter's count is per process, and this spends it.
  const wrong = () => redeem('ZZZZ-ZZZZ');
  let res;
  for (let i = 0; i < 12; i += 1) {
    res = await wrong();
    if (res.status === 429) break;
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'CODE_NOT_FOUND');
  }
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'TOO_MANY_ATTEMPTS');
});
