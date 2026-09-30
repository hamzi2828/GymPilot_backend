// Staff setting somebody else's password: who may, what a chosen password
// must be, what a generated one looks like, and how a new account's first
// password is picked. Pure rules, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { generatePassword, passwordProblem, resetProblem, initialPassword } = require('../../src/services/adminPasswords');
const { allowAll, fullPermissionMap } = require('../../src/config/permissions');

const NONE = fullPermissionMap();
const RECEPTION = fullPermissionMap({ users: 'manage', attendance: 'manage', 'package-orders': 'manage' });
const MANAGER = fullPermissionMap({ users: 'manage', attendance: 'manage', 'package-orders': 'manage', staff: 'manage', reports: 'view' });

const member = { _id: 'u1', role: 'user' };
const receptionist = { _id: 'r1', role: 'receptionist' };
const manager = { _id: 'm1', role: 'manager' };
const admin = { _id: 'a1', role: 'admin' };

test('a generated password is long, has every character class and no look-alike glyphs', () => {
  for (let i = 0; i < 50; i += 1) {
    const password = generatePassword();
    assert.equal(password.length, 14);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[2-9]/);
    assert.match(password, /[!@#$%^&*]/);
    assert.doesNotMatch(password, /[0O1lI]/);
    assert.equal(passwordProblem(password), null);
  }
  assert.notEqual(generatePassword(), generatePassword());
});

test('a chosen password needs eight characters and nothing else', () => {
  assert.match(passwordProblem(''), /required/);
  assert.match(passwordProblem(undefined), /required/);
  assert.match(passwordProblem('short'), /at least 8/);
  assert.match(passwordProblem('x'.repeat(201)), /too long/);
  assert.equal(passwordProblem('longenough'), null);
});

test('nobody sets their own password from the admin screens', () => {
  assert.match(
    resetProblem({ actorId: 'a1', actorRole: 'admin', actorPermissions: allowAll(), target: admin, targetPermissions: allowAll() }),
    /account page/
  );
});

test("only an administrator sets an administrator's password", () => {
  assert.match(
    resetProblem({ actorId: 'm1', actorRole: 'manager', actorPermissions: MANAGER, target: admin, targetPermissions: allowAll() }),
    /Only an administrator/
  );
  assert.equal(
    resetProblem({ actorId: 'a2', actorRole: 'admin', actorPermissions: allowAll(), target: admin, targetPermissions: allowAll() }),
    null
  );
});

test('nobody sets the password of an account that reaches further than their own', () => {
  // A receptionist may help a member and a fellow receptionist...
  assert.equal(resetProblem({ actorId: 'r1', actorRole: 'receptionist', actorPermissions: RECEPTION, target: member, targetPermissions: NONE }), null);
  assert.equal(
    resetProblem({ actorId: 'r1', actorRole: 'receptionist', actorPermissions: RECEPTION, target: { _id: 'r2', role: 'receptionist' }, targetPermissions: RECEPTION }),
    null
  );
  // ...but not the manager, whose role opens the Staff tab and more.
  assert.match(
    resetProblem({ actorId: 'r1', actorRole: 'receptionist', actorPermissions: RECEPTION, target: manager, targetPermissions: MANAGER }),
    /more access than yours \(Reports\)/
  );
  // The manager may reach down.
  assert.equal(resetProblem({ actorId: 'm1', actorRole: 'manager', actorPermissions: MANAGER, target: receptionist, targetPermissions: RECEPTION }), null);
});

test('a front-desk grant the actor lacks counts as more access', () => {
  const desk = { _id: 'r2', role: 'receptionist', allowAttendanceApp: true };
  assert.match(
    resetProblem({ actorId: 'r1', actorRole: 'receptionist', actorPermissions: RECEPTION, actorGrants: {}, target: desk, targetPermissions: RECEPTION }),
    /front-desk app/
  );
  assert.equal(
    resetProblem({ actorId: 'r1', actorRole: 'receptionist', actorPermissions: RECEPTION, actorGrants: { allowAttendanceApp: true }, target: desk, targetPermissions: RECEPTION }),
    null
  );
  // An administrator is never short of a grant.
  assert.equal(resetProblem({ actorId: 'a1', actorRole: 'admin', actorPermissions: allowAll(), target: desk, targetPermissions: RECEPTION }), null);
});

test("a new account's first password: emailed by default, shown or typed on request", () => {
  const emailed = initialPassword({}, { canEmail: true });
  assert.equal(emailed.mode, 'email');
  assert.equal(passwordProblem(emailed.password), null);

  assert.equal(initialPassword({ credentials: 'show' }).mode, 'show');
  assert.deepEqual(initialPassword({ credentials: 'set', password: 'chosen-one' }), { mode: 'set', password: 'chosen-one' });
  // A typed password with no mode is a typed password.
  assert.deepEqual(initialPassword({ password: 'chosen-one' }), { mode: 'set', password: 'chosen-one' });
  assert.match(initialPassword({ credentials: 'set', password: 'short' }).problem, /at least 8/);
  assert.match(initialPassword({ credentials: 'set' }).problem, /required/);
  // Nowhere to send it: it is shown instead.
  assert.equal(initialPassword({ credentials: 'email' }, { canEmail: false }).mode, 'show');
  // Anything else is the default.
  assert.equal(initialPassword({ credentials: 'carrier-pigeon' }).mode, 'email');
});
