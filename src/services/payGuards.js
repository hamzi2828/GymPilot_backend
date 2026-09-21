// src/services/payGuards.js
//
// Who may change whose pay. A manager holding `staff: manage` runs payroll
// for the team -- but not for themselves, and not for the administrators
// above them. Without this, the same permission that lets them pay the
// front desk lets them raise their own salary, point their own pay at a new
// bank account, approve their own leave and pay their own payslip.
//
// Administrators are not held to it: they can hand themselves any role or
// permission anyway, and in a small gym the owner is the only one who could
// set their own pay.
//
// Same shape as services/roleGuards.js: a sentence explaining the refusal,
// or null when the change may go ahead. The callers turn a sentence into a
// 403.

const { isAdmin } = require('./roleGuards');

function same(a, b) {
  return a != null && b != null && String(a) === String(b);
}

const REFUSALS = {
  pay: {
    self: 'You cannot change your own pay or bank details. Ask another manager or an administrator to do it.',
    admin: "Only an administrator can change an administrator's pay or bank details."
  },
  leave: {
    self: 'You cannot record or decide your own leave. Request it from your staff portal and another manager or an administrator will decide it.',
    admin: "Only an administrator can record or decide an administrator's leave."
  },
  payslip: {
    self: 'You cannot edit, issue or pay your own payslip. Ask another manager or an administrator to do it.',
    admin: "Only an administrator can edit, issue or pay an administrator's payslip."
  }
};

/**
 * `actor` changing `target`'s pay, leave or payslip.
 *
 * @param {{ actorId, actorRole, target: { _id|id, role }, what: 'pay'|'leave'|'payslip' }} args
 *   actorRole must be the live role (req.roleSlug), not the token's claim.
 */
function payChangeProblem({ actorId, actorRole, target, what = 'pay' }) {
  if (!target || isAdmin(actorRole)) return null;
  const refusal = REFUSALS[what] || REFUSALS.pay;
  if (same(actorId, target._id || target.id)) return refusal.self;
  if (isAdmin(target.role)) return refusal.admin;
  return null;
}

module.exports = { payChangeProblem };
