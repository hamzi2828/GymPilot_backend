// Staff setting passwords without email, against a real MongoDB: typed or
// generated (and returned once), every session the account had ended, the
// role-escalation rule held, and new accounts that can be handed a password
// at the desk -- including when the welcome email cannot be sent, where the
// generated password used to be thrown away.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let DesktopToken;
let users;
let staff;
let admin;
let receptionist;
let manager;
let member;

const OLD = 'old-password-1';

const test = h.suite(async () => {
  User = h.src('models/user');
  DesktopToken = h.src('attendance/models/desktopTokenModel');
  users = h.src('controller/userController');
  staff = h.src('controller/staffController');

  gym = await h.createGym('passwords-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, DesktopToken);
    await h.src('services/roleService').ensureDefaultRoles();
    const hashed = await bcrypt.hash(OLD, 4);
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@passwords.test', role: 'admin', password: hashed, employment: { isStaff: true } });
    receptionist = await User.create({ firstName: 'Rae', lastName: 'Desk', email: 'rae@passwords.test', role: 'receptionist', password: hashed, employment: { isStaff: true } });
    manager = await User.create({ firstName: 'Max', lastName: 'Manager', email: 'max@passwords.test', role: 'manager', password: hashed, employment: { isStaff: true } });
    member = await User.create({ firstName: 'Mo', lastName: 'Member', email: 'mo@passwords.test', password: hashed });
  });
});

// What requirePermission leaves on the request: the actor and their live role.
const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });

const login = (email, password) => h.inGym(gym, () => h.call(users.loginUser, { body: { email, password } }));

test('an admin types a new password: it works, the old one does not, and it is not echoed back', async () => {
  const before = await h.inGym(gym, () => User.findById(member._id).select('tokenVersion').lean());
  const res = await h.inGym(gym, () =>
    h.call(users.setUserPassword, { ...as(admin), params: { id: String(member._id) }, body: { password: 'typed-by-admin' } })
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.generated, false);
  assert.equal(res.body.data.password, undefined, 'a typed password is not sent back');

  assert.equal((await login('mo@passwords.test', 'typed-by-admin')).statusCode, 200);
  assert.equal((await login('mo@passwords.test', OLD)).statusCode, 401);

  const after = await h.inGym(gym, () => User.findById(member._id).select('tokenVersion +passwordChangedAt').lean());
  assert.equal(after.tokenVersion, (before.tokenVersion || 0) + 1, 'every session the account had is ended');
  assert.ok(after.passwordChangedAt);
});

test('with no password one is generated, returned once with no-store, and signs in', async () => {
  const res = await h.inGym(gym, () => h.call(users.setUserPassword, { ...as(receptionist), params: { id: String(member._id) }, body: {} }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.generated, true);
  assert.equal(typeof res.body.data.password, 'string');
  assert.equal(res.body.data.password.length, 14);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal((await login('mo@passwords.test', res.body.data.password)).statusCode, 200);
});

test('a chosen password still has to meet the rule', async () => {
  const res = await h.inGym(gym, () => h.call(users.setUserPassword, { ...as(admin), params: { id: String(member._id) }, body: { password: 'short' } }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /at least 8/);
});

test('nobody sets their own, a higher account\'s, or an administrator\'s password without being one', async () => {
  const self = await h.inGym(gym, () => h.call(users.setUserPassword, { ...as(receptionist), params: { id: String(receptionist._id) }, body: {} }));
  assert.equal(self.statusCode, 403);
  assert.match(self.body.message, /account page/);

  const upward = await h.inGym(gym, () => h.call(users.setUserPassword, { ...as(receptionist), params: { id: String(manager._id) }, body: {} }));
  assert.equal(upward.statusCode, 403);
  assert.match(upward.body.message, /more access than yours/);

  const toAdmin = await h.inGym(gym, () => h.call(users.setUserPassword, { ...as(manager), params: { id: String(admin._id) }, body: {} }));
  assert.equal(toAdmin.statusCode, 403);
  assert.match(toAdmin.body.message, /Only an administrator/);

  // The refused attempts changed nothing.
  assert.equal((await login('max@passwords.test', OLD)).statusCode, 200);
  assert.equal((await login('ada@passwords.test', OLD)).statusCode, 200);
});

test('the Staff screen sets staff passwords only, and a desk signed in as them is signed out', async () => {
  const onDesk = await h.inGym(gym, () => DesktopToken.issue(receptionist._id, { deviceLabel: 'DESK-1', ip: '127.0.0.1' }));
  assert.ok(await h.inGym(gym, () => DesktopToken.findUsable(onDesk.token)));

  const res = await h.inGym(gym, () => h.call(staff.setPassword, { ...as(manager), params: { id: String(receptionist._id) }, body: { password: 'new-desk-pass' } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await h.inGym(gym, () => DesktopToken.findUsable(onDesk.token)), null, 'the desk token is revoked');
  assert.equal((await login('rae@passwords.test', 'new-desk-pass')).statusCode, 200);

  const notStaff = await h.inGym(gym, () => h.call(staff.setPassword, { ...as(admin), params: { id: String(member._id) }, body: {} }));
  assert.equal(notStaff.statusCode, 404);
});

test('a new member can be handed a generated or a typed password instead of an email', async () => {
  const emailsBefore = h.calls.emails.length;
  const shown = await h.inGym(gym, () =>
    h.call(users.adminCreateUser, { ...as(receptionist), body: { firstName: 'Sam', lastName: 'Shown', email: 'sam@passwords.test', credentials: 'show' } })
  );
  assert.equal(shown.statusCode, 201, JSON.stringify(shown.body));
  assert.equal(shown.body.credentials, 'show');
  assert.equal(shown.body.emailed, false);
  assert.equal(shown.headers['cache-control'], 'no-store');
  assert.equal((await login('sam@passwords.test', shown.body.password)).statusCode, 200);

  const typed = await h.inGym(gym, () =>
    h.call(users.adminCreateUser, { ...as(receptionist), body: { firstName: 'Tia', lastName: 'Typed', email: 'tia@passwords.test', credentials: 'set', password: 'desk-chosen-1' } })
  );
  assert.equal(typed.statusCode, 201, JSON.stringify(typed.body));
  assert.equal(typed.body.password, undefined);
  assert.equal((await login('tia@passwords.test', 'desk-chosen-1')).statusCode, 200);

  assert.equal(h.calls.emails.length, emailsBefore, 'neither was emailed');
});

test('when the welcome email fails, the generated password comes back instead of being lost', async () => {
  h.setEmailFailure('SMTP is down');
  try {
    const res = await h.inGym(gym, () =>
      h.call(users.adminCreateUser, { ...as(admin), body: { firstName: 'Una', lastName: 'Unsent', email: 'una@passwords.test' } })
    );
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.emailed, false);
    assert.equal(res.body.emailError, 'SMTP is down');
    assert.equal(typeof res.body.password, 'string');
    assert.equal((await login('una@passwords.test', res.body.password)).statusCode, 200);

    const invited = await h.inGym(gym, () =>
      h.call(staff.create, { ...as(admin), body: { firstName: 'Vic', lastName: 'Invited', email: 'vic@passwords.test', role: 'receptionist' } })
    );
    assert.equal(invited.statusCode, 201, JSON.stringify(invited.body));
    assert.equal(invited.body.emailed, false);
    assert.equal((await login('vic@passwords.test', invited.body.password)).statusCode, 200);
  } finally {
    h.setEmailFailure(null);
  }
});

test('an emailed password stays out of the response when the email goes', async () => {
  const res = await h.inGym(gym, () =>
    h.call(users.adminCreateUser, { ...as(admin), body: { firstName: 'Wes', lastName: 'Welcomed', email: 'wes@passwords.test' } })
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.emailed, true);
  assert.equal(res.body.password, undefined);
  assert.ok(h.calls.emails.some((mail) => mail.to === 'wes@passwords.test'));
});

test('nobody chooses or sees the password of a new account above their own', async () => {
  const res = await h.inGym(gym, () =>
    h.call(staff.create, { ...as(receptionist), body: { firstName: 'Big', lastName: 'Boss', email: 'boss@passwords.test', role: 'manager', credentials: 'show' } })
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /more access than yours/);
  assert.equal(await h.inGym(gym, () => User.exists({ email: 'boss@passwords.test' })), null);
});
