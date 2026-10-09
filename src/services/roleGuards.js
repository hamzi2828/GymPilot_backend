// src/services/roleGuards.js
//
// The rules about who may change whose role, status or existence. Kept out
// of the controllers (and away from the database) so the same sentence is
// returned from every screen that can touch an account -- the Users tab, the
// Staff tab, and the admin user-creation form -- and so the rules can be
// tested without a gym.
//
// Four rules, in order of how often they bite:
//
//   * nobody changes their own role, deactivates or deletes themselves --
//     an admin who demotes themselves by mistake has no way back in;
//   * only an administrator may grant or revoke the administrator role, or
//     switch off / delete an administrator -- a manager with `users: manage`
//     must not be able to make themselves (or a friend) an admin;
//   * below an administrator, nobody creates an account in, moves one into
//     or out of, deactivates or deletes one holding a role that reaches any
//     tab at a higher level than their own, nor gives a front-desk grant
//     they lack. It is the set-password rule (services/adminPasswords.js)
//     held everywhere: otherwise a receptionist demotes the manager to
//     member, sets that member's password, restores the role and is the
//     manager -- or creates a manager with the password emailed to an
//     address they typed themselves;
//   * the last active administrator can never be demoted, deactivated or
//     deleted -- somebody has to be able to hand the role back out.
//
// The same line is held on the roles themselves (roleEditProblem): holding
// `roles: manage` lets somebody shape the roles beneath them, not write
// themselves a wider one -- nobody below an administrator edits the role
// they hold, edits a role that reaches further than theirs, or gives any
// role a tab at a level they do not hold.
//
// Every function returns a sentence explaining the refusal, or null when the
// change may go ahead. The callers turn a sentence into a 403. Permissions
// are { tab: level } maps (roleService.permissionsFor); the callers look
// them up, so these stay free of the database.

const { TAB_KEYS, LEVEL_RANK, PERMISSION_TABS, normaliseLevel } = require('../config/permissions');

const ADMIN_SLUG = 'admin';

function same(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isAdmin(role) {
  return String(role || '').toLowerCase() === ADMIN_SLUG;
}

function rank(permissions, tab) {
  const held = permissions instanceof Map ? permissions.get(tab) : (permissions || {})[tab];
  return LEVEL_RANK[normaliseLevel(held)];
}

/**
 * The first tab `permissions` holds at a higher level than `own`, by its
 * sidebar label, or null when it reaches nothing `own` cannot.
 */
function widerTab(own, permissions) {
  const wider = TAB_KEYS.find((tab) => rank(permissions, tab) > rank(own, tab));
  if (!wider) return null;
  return (PERMISSION_TABS.find((entry) => entry.key === wider) || {}).label || wider;
}

/** Does `account` hold a front-desk grant that `own` (the actor's grants) lacks? */
function deskGrantBeyond(own = {}, account = {}) {
  return (!!account.allowAttendanceApp && !own.allowAttendanceApp)
    || (!!account.allowFingerprintEnrollment && !own.allowFingerprintEnrollment);
}

/**
 * Giving an account front-desk grants: `grants` is what is being switched
 * on ({ allowAttendanceApp, allowFingerprintEnrollment }).
 */
function grantProblem({ actorRole, actorGrants, grants }) {
  if (isAdmin(actorRole) || !deskGrantBeyond(actorGrants, grants)) return null;
  return 'Your account cannot use the front-desk app, so it cannot give that to another account.';
}

/**
 * Changing `target`'s role to `nextRole`.
 *
 * @param {{ actorId, actorRole, actorPermissions, target: { _id|id, role, isActive },
 *   currentPermissions, nextRole, nextPermissions, activeAdmins }} args
 *   currentPermissions / nextPermissions are those of the target's role now
 *   and of `nextRole`; activeAdmins is how many active administrators exist
 *   right now, including the target if they are one.
 */
function roleChangeProblem({ actorId, actorRole, actorPermissions, target, currentPermissions, nextRole, nextPermissions, activeAdmins }) {
  if (!target) return null;
  const targetId = target._id || target.id;
  const next = String(nextRole || '').toLowerCase();
  if (next === String(target.role || '').toLowerCase()) return null; // nothing changes

  if (same(actorId, targetId)) return 'You cannot change your own role. Ask another administrator to do it.';

  if ((isAdmin(target.role) || isAdmin(next)) && !isAdmin(actorRole)) {
    return 'Only an administrator can grant or revoke the administrator role.';
  }

  if (!isAdmin(actorRole)) {
    const above = widerTab(actorPermissions, currentPermissions);
    if (above) return `This account has more access than yours (${above}), so ask an administrator to change its role.`;
    const beyond = widerTab(actorPermissions, nextPermissions);
    if (beyond) return `That role has more access than yours (${beyond}), so ask an administrator to give it.`;
  }

  if (isAdmin(target.role) && !isAdmin(next) && target.isActive !== false && Number(activeAdmins) <= 1) {
    return 'This is the last active administrator. Promote someone else first.';
  }

  return null;
}

/**
 * Setting `target.isActive` to `isActive`. Reactivating is always allowed.
 * targetPermissions are those of the target's role.
 */
function statusChangeProblem({ actorId, actorRole, actorPermissions, target, targetPermissions, isActive, activeAdmins }) {
  if (!target || isActive) return null;
  const targetId = target._id || target.id;

  if (same(actorId, targetId)) return 'You cannot deactivate your own account.';

  if (isAdmin(target.role) && !isAdmin(actorRole)) {
    return 'Only an administrator can deactivate an administrator.';
  }

  const above = !isAdmin(actorRole) && widerTab(actorPermissions, targetPermissions);
  if (above) return `This account has more access than yours (${above}), so ask an administrator to deactivate it.`;

  if (isAdmin(target.role) && target.isActive !== false && Number(activeAdmins) <= 1) {
    return 'This is the last active administrator and cannot be deactivated.';
  }

  return null;
}

/** Deleting `target` outright. targetPermissions are those of its role. */
function deleteProblem({ actorId, actorRole, actorPermissions, target, targetPermissions, activeAdmins }) {
  if (!target) return null;
  const targetId = target._id || target.id;

  if (same(actorId, targetId)) return 'You cannot delete your own account from here.';

  if (isAdmin(target.role) && !isAdmin(actorRole)) {
    return 'Only an administrator can delete an administrator.';
  }

  const above = !isAdmin(actorRole) && widerTab(actorPermissions, targetPermissions);
  if (above) return `This account has more access than yours (${above}), so ask an administrator to delete it.`;

  if (isAdmin(target.role) && target.isActive !== false && Number(activeAdmins) <= 1) {
    return 'This is the last active administrator and cannot be deleted.';
  }

  return null;
}

/**
 * Creating a brand-new account straight into `role`, with the front-desk
 * `grants` it is given (staff only). Refused whatever way its first password
 * travels: emailed to an address the actor typed, it is theirs all the same.
 */
function createRoleProblem({ actorRole, actorPermissions, actorGrants, role, rolePermissions, grants }) {
  if (isAdmin(role) && !isAdmin(actorRole)) {
    return 'Only an administrator can create an administrator account.';
  }
  if (isAdmin(actorRole)) return null;

  const beyond = widerTab(actorPermissions, rolePermissions);
  if (beyond) return `That role has more access than yours (${beyond}), so ask an administrator to create this account.`;

  return grantProblem({ actorRole, actorGrants, grants });
}

/**
 * Doing something to somebody else's account that is not a change of role,
 * status or existence but still reaches into it: signing it out everywhere,
 * recording its owner's consent, vouching for its email address. The same
 * two lines as everything above -- an administrator's account only by an
 * administrator, and nothing on an account that reaches further than the
 * actor's own (a tab at a higher level, or a front-desk grant they lack).
 * `doing` words the refusal: "sign out", "record consent for".
 *
 * @param {{ actorRole, actorPermissions, actorGrants, target, targetPermissions, doing }} args
 *   target carries role and the two front-desk grants; targetPermissions are
 *   those of its role.
 */
function reachProblem({ actorRole, actorPermissions, actorGrants = {}, target, targetPermissions, doing = 'change' }) {
  if (!target) return null;

  if (isAdmin(target.role) && !isAdmin(actorRole)) {
    return `Only an administrator can ${doing} an administrator.`;
  }
  if (isAdmin(actorRole)) return null;

  const above = widerTab(actorPermissions, targetPermissions);
  if (above) return `This account has more access than yours (${above}), so ask an administrator to ${doing} this account.`;

  if (deskGrantBeyond(actorGrants, target)) {
    return `This account can use the front-desk app and yours cannot, so ask an administrator to ${doing} this account.`;
  }
  return null;
}

/**
 * Creating a role, or changing one, so that it holds `nextPermissions`.
 * `role` is the role as it stands ({ slug, permissions }); null for a new
 * one. An administrator may do either; below that, see the top of this file.
 */
function roleEditProblem({ actorRole, actorPermissions, role = null, nextPermissions }) {
  if (isAdmin(actorRole)) return null;

  if (role) {
    if (isAdmin(role.slug)) return 'Only an administrator can change the Administrator role.';
    if (same(String(role.slug || '').toLowerCase(), String(actorRole || '').toLowerCase())) {
      return 'You cannot change the role you hold yourself. Ask an administrator to do it.';
    }
    const above = widerTab(actorPermissions, role.permissions);
    if (above) return `This role has more access than yours (${above}), so ask an administrator to change it.`;
  }

  const beyond = widerTab(actorPermissions, nextPermissions);
  if (beyond) return `You cannot give a role more access than your own (${beyond}). Ask an administrator to do it.`;

  return null;
}

module.exports = {
  ADMIN_SLUG,
  isAdmin,
  widerTab,
  deskGrantBeyond,
  reachProblem,
  roleEditProblem,
  roleChangeProblem,
  statusChangeProblem,
  deleteProblem,
  createRoleProblem,
  grantProblem
};
