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

// The set-password rule has two ways round it unless every role action holds
// the same line: (a) demote the manager to member, set the member's password,
// restore the role; (b) create a manager with the password emailed to an
// address you typed yourself.
const jwt = require('jsonwebtoken');
const token = (user) => `Bearer ${jwt.sign({ id: String(user._id), email: user.email, role: user.role }, process.env.JWT_SECRET)}`;
const withToken = (actor) => ({ ...as(actor), headers: { authorization: token(actor) } });
const setRole = (actor, target, role) =>
  h.inGym(gym, () => h.call(users.updateUserRoleById, { ...withToken(actor), params: { id: String(target._id) }, body: { role } }));

// A custom role with the Users and Staff screens but less than a manager:
// what a gym that splits the front desk from the office would make.
let supervisor;
async function makeSupervisor() {
  if (supervisor) return supervisor;
  const Role = h.src('models/roleModel');
  const { fullPermissionMap } = h.src('config/permissions');
  await h.inGym(gym, async () => {
    await Role.create({ name: 'Supervisor', slug: 'supervisor', isStaff: true, permissions: fullPermissionMap({ users: 'manage', staff: 'manage', attendance: 'manage' }) });
    h.src('services/roleService').invalidate();
    supervisor = await User.create({ firstName: 'Sue', lastName: 'Supervisor', email: 'sue@passwords.test', role: 'supervisor', password: await bcrypt.hash(OLD, 4), employment: { isStaff: true } });
  });
  return supervisor;
}

test('nobody demotes, deactivates or deletes an account above their own, so it cannot be taken over', async () => {
  const sup = await makeSupervisor();

  const demote = await setRole(receptionist, manager, 'user');
  assert.equal(demote.statusCode, 403, JSON.stringify(demote.body));
  assert.match(demote.body.message, /more access than yours/);

  // The Staff screen's role picker and "remove from staff" hold the same line.
  const staffDemote = await h.inGym(gym, () => h.call(staff.update, { ...as(sup), params: { id: String(manager._id) }, body: { role: 'supervisor' } }));
  assert.equal(staffDemote.statusCode, 403, JSON.stringify(staffDemote.body));
  const removed = await h.inGym(gym, () => h.call(staff.remove, { ...as(sup), params: { id: String(manager._id) } }));
  assert.equal(removed.statusCode, 403, JSON.stringify(removed.body));

  const off = await h.inGym(gym, () => h.call(users.updateUserStatusById, { ...withToken(receptionist), params: { id: String(manager._id) }, body: { isActive: false } }));
  assert.equal(off.statusCode, 403, JSON.stringify(off.body));
  const staffOff = await h.inGym(gym, () => h.call(staff.setStatus, { ...as(sup), params: { id: String(manager._id) }, body: { isActive: false } }));
  assert.equal(staffOff.statusCode, 403, JSON.stringify(staffOff.body));
  const deleted = await h.inGym(gym, () => h.call(users.deleteUserById, { ...withToken(receptionist), params: { id: String(manager._id) } }));
  assert.equal(deleted.statusCode, 403, JSON.stringify(deleted.body));

  const still = await h.inGym(gym, () => User.findById(manager._id).select('role isActive employment.isStaff').lean());
  assert.equal(still.role, 'manager');
  assert.equal(still.isActive, true);
  assert.equal(still.employment.isStaff, true);
  // And so its password stays out of reach.
  const reset = await h.inGym(gym, () => h.call(users.setUserPassword, { ...as(receptionist), params: { id: String(manager._id) }, body: {} }));
  assert.equal(reset.statusCode, 403);
});

test('nobody promotes an account, or gives a front-desk grant, beyond their own', async () => {
  const sup = await makeSupervisor();

  const promote = await setRole(receptionist, member, 'manager');
  assert.equal(promote.statusCode, 403, JSON.stringify(promote.body));
  assert.match(promote.body.message, /That role has more access than yours/);
  const staffPromote = await h.inGym(gym, () => h.call(staff.update, { ...as(sup), params: { id: String(member._id) }, body: { role: 'manager' } }));
  assert.equal(staffPromote.statusCode, 403, JSON.stringify(staffPromote.body));
  assert.match(staffPromote.body.message, /That role has more access than yours/);
  const grant = await h.inGym(gym, () => h.call(staff.update, { ...as(sup), params: { id: String(receptionist._id) }, body: { allowAttendanceApp: true } }));
  assert.equal(grant.statusCode, 403, JSON.stringify(grant.body));
  assert.match(grant.body.message, /front-desk app/);

  assert.equal((await h.inGym(gym, () => User.findById(member._id).lean())).role, 'user');
  const desk = await h.inGym(gym, () => User.findById(receptionist._id).lean());
  assert.equal(desk.role, 'receptionist');
  assert.equal(!!desk.allowAttendanceApp, false);

  // Within their own reach it all still works...
  assert.equal((await setRole(receptionist, member, 'receptionist')).statusCode, 200);
  assert.equal((await setRole(receptionist, member, 'user')).statusCode, 200);
  // ...and an administrator's reach is everything.
  assert.equal((await setRole(admin, manager, 'receptionist')).statusCode, 200);
  assert.equal((await setRole(admin, manager, 'manager')).statusCode, 200);
});

test('an account above your own is not created, not even with the password emailed to an address you typed', async () => {
  const sup = await makeSupervisor();
  const emailsBefore = h.calls.emails.length;

  for (const credentials of ['email', undefined, 'show']) {
    const res = await h.inGym(gym, () =>
      h.call(users.adminCreateUser, { ...as(receptionist), body: { firstName: 'Esc', lastName: 'Alate', email: 'attacker@elsewhere.test', role: 'manager', ...(credentials ? { credentials } : {}) } })
    );
    assert.equal(res.statusCode, 403, `${credentials}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, /more access than yours/);
  }
  const staffManager = await h.inGym(gym, () =>
    h.call(staff.create, { ...as(sup), body: { firstName: 'Esc', lastName: 'Alate', email: 'attacker@elsewhere.test', role: 'manager', credentials: 'email' } })
  );
  assert.equal(staffManager.statusCode, 403, JSON.stringify(staffManager.body));
  const staffDesk = await h.inGym(gym, () =>
    h.call(staff.create, { ...as(sup), body: { firstName: 'Esc', lastName: 'Alate', email: 'attacker@elsewhere.test', role: 'cleaner', allowAttendanceApp: true } })
  );
  assert.equal(staffDesk.statusCode, 403, JSON.stringify(staffDesk.body));
  assert.match(staffDesk.body.message, /front-desk app/);

  assert.equal(await h.inGym(gym, () => User.exists({ email: 'attacker@elsewhere.test' })), null);
  assert.equal(h.calls.emails.length, emailsBefore, 'nothing was emailed');

  // Emailing an account within your own reach is unchanged, and an
  // administrator still creates anything.
  const peer = await h.inGym(gym, () =>
    h.call(users.adminCreateUser, { ...as(receptionist), body: { firstName: 'Pat', lastName: 'Peer', email: 'pat@passwords.test', role: 'receptionist' } })
  );
  assert.equal(peer.statusCode, 201, JSON.stringify(peer.body));
  assert.equal(peer.body.emailed, true);
  const boss = await h.inGym(gym, () =>
    h.call(staff.create, { ...as(admin), body: { firstName: 'New', lastName: 'Boss', email: 'newboss@passwords.test', role: 'manager', allowAttendanceApp: true } })
  );
  assert.equal(boss.statusCode, 201, JSON.stringify(boss.body));
});
