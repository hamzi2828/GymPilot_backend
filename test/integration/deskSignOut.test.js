// Ending an account's sessions ends its front-desk sign-ins too, against a
// real MongoDB. A desk token is not a JWT: bumping the account's tokenVersion
// never reached it, so a front-desk PC stayed signed in for its 30 days
// after the password it signed in with had been changed or reset, after
// "sign out everywhere", after an administrator's forced sign-out, and after
// a Google sign-in took the address over. Each of those now revokes the
// account's desk tokens, and nobody else's; signing out of one website
// session leaves the desks alone.

const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let DesktopToken;
let users;
let security;
let admin;
let bystander;
let bystanderDesk;

const PASSWORD = 'desk-sessions-1';

const test = h.suite(async () => {
  User = h.src('models/user');
  DesktopToken = h.src('attendance/models/desktopTokenModel');
  users = h.src('controller/userController');
  security = h.src('controller/securityController');

  gym = await h.createGym('desk-signout-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, DesktopToken);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@desk-signout.test', role: 'admin' });
    bystander = await account();
    bystanderDesk = await deskFor(bystander);
  });
});

const inGym = (fn) => h.inGym(gym, fn);

let seq = 0;
async function account(fields = {}) {
  seq += 1;
  const hash = await bcrypt.hash(PASSWORD, 4);
  return inGym(() =>
    User.create({
      firstName: 'Desk',
      lastName: `Owner${seq}`,
      email: `owner${seq}@desk-signout.test`,
      password: hash,
      role: 'receptionist',
      employment: { isStaff: true },
      allowAttendanceApp: true,
      ...fields
    })
  );
}

const deskFor = (user, label = 'FRONT-PC') =>
  inGym(async () => (await DesktopToken.issue(user._id, { deviceLabel: label, clientApp: 'GymPilotAttendanceDesktop/1.5.0' })).token);
const usable = (token) => inGym(async () => Boolean(await DesktopToken.findUsable(token)));

// Two desks for the account, and the bystander's still signed in afterwards.
async function withDesks(user) {
  return [await deskFor(user, 'FRONT-PC'), await deskFor(user, 'KIOSK')];
}
async function assertDesksEnded(desks) {
  for (const token of desks) assert.equal(await usable(token), false, 'the desk is signed out');
  assert.equal(await usable(bystanderDesk), true, "another account's desk is untouched");
}

test('changing your password signs your desks out', async () => {
  const sam = await account();
  const desks = await withDesks(sam);
  assert.equal(await usable(desks[0]), true);

  const res = await inGym(() =>
    h.call(users.changePassword, { user: { id: String(sam._id) }, body: { currentPassword: PASSWORD, newPassword: 'a-brand-new-one-2' } })
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await assertDesksEnded(desks);
});

test('a wrong current password changes nothing, desks included', async () => {
  const sam = await account();
  const desks = await withDesks(sam);
  const res = await inGym(() =>
    h.call(users.changePassword, { user: { id: String(sam._id) }, body: { currentPassword: 'not-it-at-all', newPassword: 'a-brand-new-one-2' } })
  );
  assert.equal(res.statusCode, 401);
  for (const token of desks) assert.equal(await usable(token), true);
});

test('resetting a forgotten password signs the desks out', async () => {
  const sam = await account();
  const desks = await withDesks(sam);
  const link = crypto.randomBytes(32).toString('hex');
  await inGym(() =>
    User.updateOne(
      { _id: sam._id },
      { $set: { passwordResetTokenHash: crypto.createHash('sha256').update(link).digest('hex'), passwordResetExpiresAt: new Date(Date.now() + 3600000) } }
    )
  );

  const res = await inGym(() => h.call(users.resetPassword, { body: { token: link, password: 'reset-and-new-3' } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await assertDesksEnded(desks);
});

test('"sign out everywhere" includes the desks; signing out of one session does not', async () => {
  const sam = await account();
  const desks = await withDesks(sam);

  // One website session, by its id: the desks carry on.
  const one = await inGym(() =>
    h.call(security.logout, { user: { id: String(sam._id), jti: 'one-session-id', exp: Math.floor(Date.now() / 1000) + 3600 } })
  );
  assert.equal(one.statusCode, 200, JSON.stringify(one.body));
  for (const token of desks) assert.equal(await usable(token), true, 'one sign-out is not every sign-out');

  const all = await inGym(() => h.call(security.logoutAll, { user: { id: String(sam._id) } }));
  assert.equal(all.statusCode, 200, JSON.stringify(all.body));
  await assertDesksEnded(desks);
});

test('signing out a token from before session ids ends every session, the desks too', async () => {
  const sam = await account();
  const desks = await withDesks(sam);
  const res = await inGym(() => h.call(security.logout, { user: { id: String(sam._id) } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await assertDesksEnded(desks);
});

test("an administrator's forced sign-out reaches the person's desks", async () => {
  const sam = await account();
  const desks = await withDesks(sam);
  const res = await inGym(() =>
    h.call(security.forceLogout, { params: { id: String(sam._id) }, user: { id: String(admin._id), role: 'admin' }, roleSlug: 'admin' })
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.message, /signed out of every device/);
  await assertDesksEnded(desks);
});

test('a Google sign-in that takes the address over ends the desks the old password opened', async () => {
  const { OAuth2Client } = require('google-auth-library');
  const verify = OAuth2Client.prototype.verifyIdToken;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const sam = await account();
  const desks = await withDesks(sam);

  process.env.GOOGLE_CLIENT_ID = 'desk-signout.apps.googleusercontent.com';
  OAuth2Client.prototype.verifyIdToken = async () => ({
    getPayload: () => ({ sub: 'google-sam', email: sam.email, given_name: 'Desk', family_name: 'Owner', email_verified: true })
  });
  try {
    const res = await inGym(() => h.call(users.googleLoginUser, { body: { idToken: 'stub-id-token' } }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(jwt.decode(res.body.token), 'signed in with Google');
  } finally {
    OAuth2Client.prototype.verifyIdToken = verify;
    if (clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = clientId;
  }
  assert.equal((await inGym(() => User.findById(sam._id).select('+password').lean())).password, null, 'the password was thrown away');
  await assertDesksEnded(desks);
});
