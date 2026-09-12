// src/platform/entitlements.js
//
// What a gym is entitled to, from its plan and the add-ons on its
// subscription. The one question asked today is "does this gym have the
// member app" (add-on slug `member-app`, see scripts/platform/seedPlans.js);
// the mobile sign-in asks it as `gymHasAddon(gym, 'member-app')`.
//
// A gym with no plan is a gym the platform is not charging -- a free-hosted
// one, or a deployment where plans were never set up -- and is entitled to
// everything. Denying features to it would make an unconfigured platform a
// broken one.

const PlatformPlan = require('./models/platformPlanModel');

const PLAN_TTL_MS = 60 * 1000;
const plans = new Map(); // plan id -> { at, plan }

function invalidatePlanCache() {
  plans.clear();
}

function normalise(slug) {
  return String(slug || '').toLowerCase().trim();
}

/**
 * The plan document for a gym: the populated one when the gym came with it,
 * otherwise read (and cached briefly) by id. Null for a gym on no plan.
 */
async function planFor(gym) {
  if (!gym || !gym.plan) return null;
  const raw = gym.plan;
  // Already populated: a plain object with the plan's fields, not an ObjectId.
  if (typeof raw === 'object' && !raw._bsontype && (raw.slug || raw.price || raw.includedAddons)) return raw;

  const id = String(raw._id || raw);
  const hit = plans.get(id);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;

  const plan = await PlatformPlan.findById(id).lean();
  plans.set(id, { at: Date.now(), plan });
  return plan;
}

/**
 * The pure decision, for tests and for callers that already hold the plan:
 * no plan -> yes; the plan includes it -> yes; it is on the subscription -> yes.
 *
 * @param {object|null} plan       the plan document, or null
 * @param {object} subscription    gym.subscription (addons read)
 * @param {string} slug
 */
function hasAddon(plan, subscription, slug) {
  const wanted = normalise(slug);
  if (!wanted) return false;
  if (!plan) return true;
  const included = (plan.includedAddons || []).map(normalise);
  if (included.includes(wanted)) return true;
  const bought = ((subscription && subscription.addons) || []).map((a) => normalise(a && a.slug));
  return bought.includes(wanted);
}

/**
 * Whether the gym may use the add-on. Callers pass the gym document (lean or
 * not); `gym.plan` may be an id or already populated.
 */
async function gymHasAddon(gym, slug) {
  if (!gym) return false;
  if (!gym.plan) return true;
  const plan = await planFor(gym);
  return hasAddon(plan, gym.subscription, slug);
}

module.exports = { gymHasAddon, hasAddon, planFor, invalidatePlanCache };
