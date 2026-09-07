// src/platform/controllers/plansController.js

const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { slugify } = require('../provisioning');
const { invalidatePlanCache } = require('../planLimits');

function fail(res, error) {
  if (error && error.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (error && error.code === 11000) {
    return res.status(409).json({ success: false, message: 'A plan with that slug already exists' });
  }
  console.error('[platform] plans:', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

function nonNegative(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function applyBody(plan, body) {
  if (body.name !== undefined) plan.name = String(body.name || '').trim();
  if (body.slug !== undefined) plan.slug = slugify(body.slug);
  if (body.description !== undefined) plan.description = String(body.description || '').trim();
  if (body.price && typeof body.price === 'object') {
    if (body.price.monthly !== undefined) plan.price.monthly = nonNegative(body.price.monthly);
    if (body.price.yearly !== undefined) plan.price.yearly = nonNegative(body.price.yearly);
    if (body.price.currency !== undefined) plan.price.currency = String(body.price.currency || 'USD').toUpperCase().trim();
  }
  if (body.limits && typeof body.limits === 'object') {
    for (const key of ['maxMembers', 'maxStaff', 'maxTrainers', 'maxClasses']) {
      if (body.limits[key] !== undefined) plan.limits[key] = Math.floor(nonNegative(body.limits[key]));
    }
  }
  if (body.features !== undefined) {
    plan.features = (Array.isArray(body.features) ? body.features : String(body.features || '').split('\n'))
      .map((f) => String(f).trim())
      .filter(Boolean);
  }
  if (body.trialDays !== undefined) plan.trialDays = Math.floor(nonNegative(body.trialDays, 14));
  if (body.isActive !== undefined) plan.isActive = !!body.isActive;
  if (body.order !== undefined) plan.order = nonNegative(body.order);
}

async function withGymCounts(plans) {
  const counts = await Gym.aggregate([
    { $match: { plan: { $ne: null } } },
    { $group: { _id: '$plan', gyms: { $sum: 1 } } }
  ]);
  const byPlan = new Map(counts.map((row) => [String(row._id), row.gyms]));
  return plans.map((plan) => ({ ...plan, id: String(plan._id), gym_count: byPlan.get(String(plan._id)) || 0 }));
}

module.exports = {
  // GET /api/platform/plans
  // GET /api/platform/public/plans -- the price list for the marketing site:
  // active plans only, and nothing about who is on them.
  publicPlans: async (req, res) => {
    try {
      const plans = await PlatformPlan.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean();
      return res.json({
        success: true,
        data: plans.map((plan) => ({
          id: String(plan._id),
          name: plan.name,
          slug: plan.slug,
          description: plan.description || '',
          price: plan.price,
          limits: plan.limits,
          features: plan.features || [],
          trialDays: plan.trialDays,
          order: plan.order
        }))
      });
    } catch (error) {
      console.error('[platform] public plans:', error);
      return res.status(500).json({ success: false, message: 'Could not load plans' });
    }
  },

  list: async (req, res) => {
    try {
      const plans = await PlatformPlan.find({}).sort({ order: 1, createdAt: 1 }).lean();
      return res.json({ success: true, data: await withGymCounts(plans) });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/platform/plans
  create: async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || !String(body.name).trim()) {
        return res.status(400).json({ success: false, message: 'Plan name is required' });
      }
      const plan = new PlatformPlan({ name: String(body.name).trim(), slug: slugify(body.slug || body.name) });
      applyBody(plan, body);
      await plan.save();

      PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action: 'plan_created', meta: { slug: plan.slug } });
      invalidatePlanCache();

      return res.status(201).json({ success: true, data: { ...plan.toObject(), id: String(plan._id), gym_count: 0 } });
    } catch (error) {
      return fail(res, error);
    }
  },

  // PUT /api/platform/plans/:id
  update: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }
      const plan = await PlatformPlan.findById(req.params.id);
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

      applyBody(plan, req.body || {});
      if (!plan.name) return res.status(400).json({ success: false, message: 'Plan name cannot be empty' });
      await plan.save();

      PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action: 'plan_updated', meta: { slug: plan.slug } });
      invalidatePlanCache();

      const [withCount] = await withGymCounts([plan.toObject()]);
      return res.json({ success: true, data: withCount });
    } catch (error) {
      return fail(res, error);
    }
  },

  // DELETE /api/platform/plans/:id
  remove: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }
      const plan = await PlatformPlan.findById(req.params.id);
      if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

      const inUse = await Gym.countDocuments({ plan: plan._id });
      if (inUse) {
        return res.status(409).json({
          success: false,
          message: `${inUse} gym(s) are on this plan. Move them to another plan first, or deactivate this one instead.`
        });
      }

      await PlatformPlan.deleteOne({ _id: plan._id });
      PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action: 'plan_deleted', meta: { slug: plan.slug } });
      invalidatePlanCache();

      return res.json({ success: true, message: 'Plan deleted' });
    } catch (error) {
      return fail(res, error);
    }
  }
};
