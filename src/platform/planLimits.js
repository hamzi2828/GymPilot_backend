// src/platform/planLimits.js
//
// What a gym's platform plan allows it to have, checked at the moment it
// tries to add one more. A limit of 0 (or no plan at all) means unlimited.
//
// Enforced on creation only. A gym that downgrades to a smaller plan keeps
// what it already has -- deleting a member because a plan changed would be
// the platform destroying a customer's records.

const { currentTenant } = require('./tenantContext');
// One plan cache for limits and entitlements alike, so a plan edited in the
// panel lands everywhere at once.
const { planFor, invalidatePlanCache } = require('./entitlements');

function currentPlan() {
  return planFor(currentTenant());
}

/**
 * The staff accounts a plan's maxStaff counts. The owner is on the staff
 * list (provisioning creates them as staff, job title Owner) but is not one
 * of the seats the plan sells: a plan for one member of staff means one
 * besides the owner, or the setup wizard's "Your team" step fails on the
 * very first person. The owner is whoever the platform has on record for
 * the gym -- gym.owner.email, written at provisioning and edited only from
 * the platform panel -- so nothing inside the gym can move the marker onto
 * somebody else, and roles and permissions are untouched.
 */
function staffCountFilter(gym) {
  const filter = { 'employment.isStaff': true };
  const ownerEmail = String((gym && gym.owner && gym.owner.email) || '').toLowerCase().trim();
  if (ownerEmail) filter.email = { $ne: ownerEmail };
  return filter;
}

// Models are required lazily: this module is used from inside the user
// controller, and the user model must not depend on it in turn.
const LIMIT_KINDS = {
  members: {
    field: 'maxMembers',
    label: 'members',
    count: () => require('../models/user').countDocuments({ role: 'user' })
  },
  staff: {
    field: 'maxStaff',
    label: 'staff accounts',
    // Not the owner: see staffCountFilter.
    count: () => require('../models/user').countDocuments(staffCountFilter(currentTenant()))
  },
  trainers: {
    field: 'maxTrainers',
    label: 'trainers',
    count: () => require('../gymfolio/models/trainerModel').countDocuments({})
  },
  classes: {
    field: 'maxClasses',
    label: 'classes',
    count: () => require('../gymfolio/models/gymClassModel').countDocuments({})
  }
};

/**
 * @returns {Promise<{ok: boolean, limit: number, used: number|null, code?: string, message?: string}>}
 */
async function checkLimit(kind) {
  const spec = LIMIT_KINDS[kind];
  if (!spec) throw new Error(`Unknown plan limit "${kind}"`);

  const plan = await currentPlan();
  const limit = plan && plan.limits ? Number(plan.limits[spec.field]) || 0 : 0;
  if (!limit) return { ok: true, limit: 0, used: null };

  const used = await spec.count();
  if (used >= limit) {
    return {
      ok: false,
      limit,
      used,
      code: 'PLAN_LIMIT_REACHED',
      message: `This gym's plan allows up to ${limit} ${spec.label}. Upgrade the plan to add more.`
    };
  }
  return { ok: true, limit, used };
}

module.exports = { checkLimit, currentPlan, invalidatePlanCache, staffCountFilter, LIMIT_KINDS };
