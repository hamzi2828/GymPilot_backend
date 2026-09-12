// src/services/roleGuards.js
//
// The rules about who may change whose role, status or existence. Kept out
// of the controllers (and away from the database) so the same sentence is
// returned from every screen that can touch an account -- the Users tab, the
// Staff tab, and the admin user-creation form -- and so the rules can be
// tested without a gym.
//
// Three rules, in order of how often they bite:
//
//   * nobody changes their own role, deactivates or deletes themselves --
//     an admin who demotes themselves by mistake has no way back in;
//   * only an administrator may grant or revoke the administrator role, or
//     switch off / delete an administrator -- a manager with `users: manage`
//     must not be able to make themselves (or a friend) an admin;
//   * the last active administrator can never be demoted, deactivated or
//     deleted -- somebody has to be able to hand the role back out.
//
// Every function returns a sentence explaining the refusal, or null when the
// change may go ahead. The callers turn a sentence into a 403.

const ADMIN_SLUG = 'admin';

function same(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isAdmin(role) {
  return String(role || '').toLowerCase() === ADMIN_SLUG;
}

/**
 * Changing `target`'s role to `nextRole`.
 *
 * @param {{ actorId, actorRole, target: { _id|id, role, isActive }, nextRole, activeAdmins }} args
 *   activeAdmins is how many active administrators exist right now,
 *   including the target if they are one.
 */
function roleChangeProblem({ actorId, actorRole, target, nextRole, activeAdmins }) {
  if (!target) return null;
  const targetId = target._id || target.id;
  const next = String(nextRole || '').toLowerCase();
  if (next === String(target.role || '').toLowerCase()) return null; // nothing changes

  if (same(actorId, targetId)) return 'You cannot change your own role. Ask another administrator to do it.';

  if ((isAdmin(target.role) || isAdmin(next)) && !isAdmin(actorRole)) {
    return 'Only an administrator can grant or revoke the administrator role.';
  }

  if (isAdmin(target.role) && !isAdmin(next) && target.isActive !== false && Number(activeAdmins) <= 1) {
    return 'This is the last active administrator. Promote someone else first.';
  }

  return null;
}

/** Setting `target.isActive` to `isActive`. Reactivating is always allowed. */
function statusChangeProblem({ actorId, actorRole, target, isActive, activeAdmins }) {
  if (!target || isActive) return null;
  const targetId = target._id || target.id;

  if (same(actorId, targetId)) return 'You cannot deactivate your own account.';

  if (isAdmin(target.role) && !isAdmin(actorRole)) {
    return 'Only an administrator can deactivate an administrator.';
  }

  if (isAdmin(target.role) && target.isActive !== false && Number(activeAdmins) <= 1) {
    return 'This is the last active administrator and cannot be deactivated.';
  }

  return null;
}

/** Deleting `target` outright. */
function deleteProblem({ actorId, actorRole, target, activeAdmins }) {
  if (!target) return null;
  const targetId = target._id || target.id;

  if (same(actorId, targetId)) return 'You cannot delete your own account from here.';

  if (isAdmin(target.role) && !isAdmin(actorRole)) {
    return 'Only an administrator can delete an administrator.';
  }

  if (isAdmin(target.role) && target.isActive !== false && Number(activeAdmins) <= 1) {
    return 'This is the last active administrator and cannot be deleted.';
  }

  return null;
}

/** Creating a brand-new account straight into `role`. */
function createRoleProblem({ actorRole, role }) {
  if (isAdmin(role) && !isAdmin(actorRole)) {
    return 'Only an administrator can create an administrator account.';
  }
  return null;
}

module.exports = {
  ADMIN_SLUG,
  isAdmin,
  roleChangeProblem,
  statusChangeProblem,
  deleteProblem,
  createRoleProblem
};
