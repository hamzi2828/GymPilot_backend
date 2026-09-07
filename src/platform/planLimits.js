// src/platform/planLimits.js
//
// What a gym's platform plan allows it to have, checked at the moment it
// tries to add one more. A limit of 0 (or no plan at all) means unlimited.
//
// Enforced on creation only. A gym that downgrades to a smaller plan keeps
// what it already has -- deleting a member because a plan changed would be
// the platform destroying a customer's records.

const PlatformPlan = require('./models/platformPlanModel');
const { currentTenant } = require('./tenantContext');

const PLAN_TTL_MS = 60 * 1000;
const plans = new Map(); // plan id -> { at, plan }

function invalidatePlanCache() {
  plans.clear();
}

async function currentPlan() {
  const gym = currentTenant();
  if (!gym || !gym.plan) return null;

  const id = String(gym.plan);
  const hit = plans.get(id);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;

  const plan = await PlatformPlan.findById(id).lean();
  plans.set(id, { at: Date.now(), plan });
  return plan;
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
    count: () => require('../models/user').countDocuments({ 'employment.isStaff': true })
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

module.exports = { checkLimit, currentPlan, invalidatePlanCache, LIMIT_KINDS };
