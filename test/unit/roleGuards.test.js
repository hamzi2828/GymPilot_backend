// Who may change whose role, status or existence: pure rules, no database.
const test = require('node:test');
const assert = require('node:assert/strict');

const guards = require('../../src/services/roleGuards');
const { allowAll, fullPermissionMap } = require('../../src/config/permissions');

const admin = { _id: 'a1', role: 'admin', isActive: true };
const otherAdmin = { _id: 'a2', role: 'admin', isActive: true };
const manager = { _id: 'm1', role: 'manager', isActive: true };
const member = { _id: 'u1', role: 'user', isActive: true };

const NONE = fullPermissionMap();
const RECEPTION = fullPermissionMap({ users: 'manage', attendance: 'manage', 'package-orders': 'manage' });
const MANAGER = fullPermissionMap({ users: 'manage', attendance: 'manage', 'package-orders': 'manage', staff: 'manage', reports: 'view' });

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

// Below an administrator, an account whose role reaches further than yours
// is out of bounds whatever the action. Otherwise the set-password rule has
// a way round it: demote the manager to member, set the member's password,
// restore the role -- or create a manager and have the password emailed to
// an address you typed.
test('nobody moves an account out of or into a role that reaches further than their own', () => {
  const receptionist = { _id: 'r1', role: 'receptionist', isActive: true };
  const asReception = { actorId: 'r1', actorRole: 'receptionist', actorPermissions: RECEPTION, activeAdmins: 2 };

  assert.match(
    guards.roleChangeProblem({ ...asReception, target: manager, currentPermissions: MANAGER, nextRole: 'user', nextPermissions: NONE }),
    /This account has more access than yours \(Reports\)/
  );
  assert.match(
    guards.roleChangeProblem({ ...asReception, target: member, currentPermissions: NONE, nextRole: 'manager', nextPermissions: MANAGER }),
    /That role has more access than yours \(Reports\)/
  );
  // Sideways and downwards are fine...
  assert.equal(guards.roleChangeProblem({ ...asReception, target: member, currentPermissions: NONE, nextRole: 'receptionist', nextPermissions: RECEPTION }), null);
  assert.equal(guards.roleChangeProblem({ ...asReception, target: { _id: 'r2', role: 'receptionist' }, currentPermissions: RECEPTION, nextRole: 'user', nextPermissions: NONE }), null);
  // ...as is anything a manager does below themselves, and anything an administrator does.
  assert.equal(guards.roleChangeProblem({ actorId: 'm1', actorRole: 'manager', actorPermissions: MANAGER, target: receptionist, currentPermissions: RECEPTION, nextRole: 'user', nextPermissions: NONE, activeAdmins: 2 }), null);
  assert.equal(guards.roleChangeProblem({ actorId: 'a1', actorRole: 'admin', actorPermissions: allowAll(), target: manager, currentPermissions: MANAGER, nextRole: 'user', nextPermissions: NONE, activeAdmins: 2 }), null);
});

test('nobody deactivates or deletes an account that reaches further than their own', () => {
  const asReception = { actorId: 'r1', actorRole: 'receptionist', actorPermissions: RECEPTION, activeAdmins: 2 };
  assert.match(guards.statusChangeProblem({ ...asReception, target: manager, targetPermissions: MANAGER, isActive: false }), /more access than yours/);
  assert.match(guards.deleteProblem({ ...asReception, target: manager, targetPermissions: MANAGER }), /more access than yours/);
  assert.equal(guards.statusChangeProblem({ ...asReception, target: member, targetPermissions: NONE, isActive: false }), null);
  assert.equal(guards.deleteProblem({ ...asReception, target: member, targetPermissions: NONE }), null);
  // Switching someone back on stays allowed.
  assert.equal(guards.statusChangeProblem({ ...asReception, target: manager, targetPermissions: MANAGER, isActive: true }), null);
  assert.equal(guards.deleteProblem({ actorId: 'a1', actorRole: 'admin', actorPermissions: allowAll(), target: manager, targetPermissions: MANAGER, activeAdmins: 2 }), null);
});

test('nobody creates an account above their own, or gives a front-desk grant they lack', () => {
  const asReception = { actorRole: 'receptionist', actorPermissions: RECEPTION, actorGrants: {} };
  assert.match(guards.createRoleProblem({ ...asReception, role: 'manager', rolePermissions: MANAGER }), /That role has more access than yours \(Reports\)/);
  assert.equal(guards.createRoleProblem({ ...asReception, role: 'receptionist', rolePermissions: RECEPTION }), null);
  assert.match(guards.createRoleProblem({ ...asReception, role: 'receptionist', rolePermissions: RECEPTION, grants: { allowAttendanceApp: true } }), /front-desk app/);
  assert.equal(guards.createRoleProblem({ ...asReception, actorGrants: { allowAttendanceApp: true }, role: 'receptionist', rolePermissions: RECEPTION, grants: { allowAttendanceApp: true } }), null);
  assert.match(guards.grantProblem({ ...asReception, grants: { allowFingerprintEnrollment: true } }), /front-desk app/);
  assert.equal(guards.grantProblem({ ...asReception, grants: {} }), null);
  // An administrator creates and grants anything.
  assert.equal(guards.createRoleProblem({ actorRole: 'admin', actorPermissions: allowAll(), role: 'manager', rolePermissions: MANAGER, grants: { allowAttendanceApp: true } }), null);
});

test('reaching into another account holds the same line: admins by admins, nothing above your own', () => {
  const reach = (args) => guards.reachProblem({ doing: 'sign out', ...args });
  assert.match(reach({ actorRole: 'receptionist', actorPermissions: RECEPTION, target: otherAdmin, targetPermissions: allowAll() }), /Only an administrator can sign out an administrator/);
  assert.match(reach({ actorRole: 'receptionist', actorPermissions: RECEPTION, target: manager, targetPermissions: MANAGER }), /more access than yours \(.+\), so ask an administrator to sign out this account/);
  assert.equal(reach({ actorRole: 'receptionist', actorPermissions: RECEPTION, target: member, targetPermissions: NONE }), null);
  assert.equal(reach({ actorRole: 'manager', actorPermissions: MANAGER, target: { _id: 'r1', role: 'receptionist' }, targetPermissions: RECEPTION }), null);
  assert.equal(reach({ actorRole: 'admin', target: otherAdmin, targetPermissions: allowAll() }), null);
  // A front-desk grant the actor lacks is reach too.
  assert.match(
    reach({ actorRole: 'receptionist', actorPermissions: RECEPTION, actorGrants: {}, target: { _id: 'u9', role: 'user', allowAttendanceApp: true }, targetPermissions: NONE }),
    /front-desk app/
  );
  assert.equal(
    reach({ actorRole: 'receptionist', actorPermissions: RECEPTION, actorGrants: { allowAttendanceApp: true }, target: { _id: 'u9', role: 'user', allowAttendanceApp: true }, targetPermissions: NONE }),
    null
  );
  assert.equal(reach({ actorRole: 'receptionist', actorPermissions: RECEPTION, target: null }), null);
});
