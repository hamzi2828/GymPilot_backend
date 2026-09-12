// Who may change whose role, status or existence: pure rules, no database.
const test = require('node:test');
const assert = require('node:assert/strict');

const guards = require('../../src/services/roleGuards');

const admin = { _id: 'a1', role: 'admin', isActive: true };
const otherAdmin = { _id: 'a2', role: 'admin', isActive: true };
const manager = { _id: 'm1', role: 'manager', isActive: true };
const member = { _id: 'u1', role: 'user', isActive: true };

test('nobody may change their own role', () => {
  assert.match(guards.roleChangeProblem({ actorId: 'a1', actorRole: 'admin', target: admin, nextRole: 'manager', activeAdmins: 5 }), /own role/);
  assert.match(guards.roleChangeProblem({ actorId: 'm1', actorRole: 'manager', target: manager, nextRole: 'receptionist', activeAdmins: 5 }), /own role/);
  // ...but asking for the role they already hold is not a change.
  assert.equal(guards.roleChangeProblem({ actorId: 'm1', actorRole: 'manager', target: manager, nextRole: 'manager', activeAdmins: 5 }), null);
});

test('only an administrator grants or revokes the administrator role', () => {
  assert.match(guards.roleChangeProblem({ actorId: 'm1', actorRole: 'manager', target: member, nextRole: 'admin', activeAdmins: 2 }), /Only an administrator/);
  assert.match(guards.roleChangeProblem({ actorId: 'm1', actorRole: 'manager', target: otherAdmin, nextRole: 'user', activeAdmins: 2 }), /Only an administrator/);
  assert.equal(guards.roleChangeProblem({ actorId: 'a1', actorRole: 'admin', target: member, nextRole: 'admin', activeAdmins: 2 }), null);
  assert.equal(guards.roleChangeProblem({ actorId: 'a1', actorRole: 'admin', target: otherAdmin, nextRole: 'manager', activeAdmins: 2 }), null);
  // A manager moving a member between non-admin roles is fine.
  assert.equal(guards.roleChangeProblem({ actorId: 'm1', actorRole: 'manager', target: member, nextRole: 'trainer', activeAdmins: 1 }), null);
});

test('the last active administrator can never be demoted, deactivated or deleted', () => {
  assert.match(guards.roleChangeProblem({ actorId: 'a1', actorRole: 'admin', target: otherAdmin, nextRole: 'user', activeAdmins: 1 }), /last active administrator/);
  assert.match(guards.statusChangeProblem({ actorId: 'a1', actorRole: 'admin', target: otherAdmin, isActive: false, activeAdmins: 1 }), /last active administrator/);
  assert.match(guards.deleteProblem({ actorId: 'a1', actorRole: 'admin', target: otherAdmin, activeAdmins: 1 }), /last active administrator/);

  // An admin who is already inactive does not count towards the floor, so
  // deleting them cannot lock anybody out.
  const dormant = { _id: 'a3', role: 'admin', isActive: false };
  assert.equal(guards.deleteProblem({ actorId: 'a1', actorRole: 'admin', target: dormant, activeAdmins: 1 }), null);
  assert.equal(guards.roleChangeProblem({ actorId: 'a1', actorRole: 'admin', target: dormant, nextRole: 'user', activeAdmins: 1 }), null);
});

test('nobody deactivates or deletes themselves; reactivating is always allowed', () => {
  assert.match(guards.statusChangeProblem({ actorId: 'm1', actorRole: 'manager', target: manager, isActive: false, activeAdmins: 3 }), /own account/);
  assert.equal(guards.statusChangeProblem({ actorId: 'm1', actorRole: 'manager', target: manager, isActive: true, activeAdmins: 3 }), null);
  assert.match(guards.deleteProblem({ actorId: 'a1', actorRole: 'admin', target: admin, activeAdmins: 3 }), /own account/);
  // Ids are compared as strings, so an ObjectId and its text form match.
  assert.match(guards.deleteProblem({ actorId: { toString: () => 'u1' }, actorRole: 'user', target: member, activeAdmins: 3 }), /own account/);
});

test('only an administrator deactivates or deletes an administrator', () => {
  assert.match(guards.statusChangeProblem({ actorId: 'm1', actorRole: 'manager', target: otherAdmin, isActive: false, activeAdmins: 3 }), /Only an administrator/);
  assert.match(guards.deleteProblem({ actorId: 'm1', actorRole: 'manager', target: otherAdmin, activeAdmins: 3 }), /Only an administrator/);
  assert.equal(guards.statusChangeProblem({ actorId: 'm1', actorRole: 'manager', target: member, isActive: false, activeAdmins: 3 }), null);
  assert.equal(guards.deleteProblem({ actorId: 'a1', actorRole: 'admin', target: otherAdmin, activeAdmins: 3 }), null);
});

test('creating an account straight into admin needs an admin', () => {
  assert.match(guards.createRoleProblem({ actorRole: 'manager', role: 'admin' }), /Only an administrator/);
  assert.equal(guards.createRoleProblem({ actorRole: 'admin', role: 'admin' }), null);
  assert.equal(guards.createRoleProblem({ actorRole: 'receptionist', role: 'user' }), null);
});
