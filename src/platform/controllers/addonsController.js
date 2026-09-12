// src/platform/controllers/addonsController.js
//
// What a gym can buy beside its plan. See models/platformAddonModel.js.

const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const PlatformAddon = require('../models/platformAddonModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { slugify } = require('../provisioning');

function fail(res, error) {
  if (error && error.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (error && error.code === 11000) {
    return res.status(409).json({ success: false, message: 'An add-on with that slug already exists' });
  }
  console.error('[platform] addons:', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

function nonNegative(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function applyBody(addon, body) {
  if (body.name !== undefined) addon.name = String(body.name || '').trim();
  if (body.slug !== undefined) addon.slug = slugify(body.slug);
  if (body.description !== undefined) addon.description = String(body.description || '').trim();
  if (body.price && typeof body.price === 'object') {
    if (body.price.monthly !== undefined) addon.price.monthly = nonNegative(body.price.monthly);
    if (body.price.yearly !== undefined) addon.price.yearly = nonNegative(body.price.yearly);
    if (body.price.currency !== undefined) addon.price.currency = String(body.price.currency || 'PKR').toUpperCase().trim();
  }
  if (body.planSlugs !== undefined) {
    addon.planSlugs = (Array.isArray(body.planSlugs) ? body.planSlugs : String(body.planSlugs || '').split(','))
      .map((s) => slugify(s))
      .filter(Boolean);
  }
  if (body.isPublic !== undefined) addon.isPublic = !!body.isPublic;
  if (body.isActive !== undefined) addon.isActive = !!body.isActive;
  if (body.order !== undefined) addon.order = nonNegative(body.order);
}

/** How many gyms are paying for each add-on right now. */
async function withGymCounts(addons) {
  const counts = await Gym.aggregate([
    { $unwind: '$subscription.addons' },
    { $group: { _id: '$subscription.addons.slug', gyms: { $sum: 1 } } }
  ]);
  const bySlug = new Map(counts.map((row) => [row._id, row.gyms]));
  return addons.map((addon) => ({ ...addon, id: String(addon._id), gym_count: bySlug.get(addon.slug) || 0 }));
}

/**
 * Turns the slugs a caller asked for into add-on documents, refusing any that
 * do not exist, are switched off, or are not sold with that plan. Used by
 * both provisioning and the subscription editor, so a gym can never end up
 * paying for something we do not sell.
 *
 * Whatever the plan includes is added whether it was asked for or not: a Pro
 * gym has the member app because Pro comes with it, not because somebody
 * remembered to tick it.
 */
async function resolveAddons(slugs, plan) {
  const included = ((plan && plan.includedAddons) || []).map((s) => slugify(s)).filter(Boolean);
  const asked = (Array.isArray(slugs) ? slugs : String(slugs || '').split(','))
    .map((s) => slugify(s))
    .filter(Boolean);
  const wanted = [...new Set([...included, ...asked])];
  if (!wanted.length) return [];

  const planSlug = plan && plan.slug;
  const found = await PlatformAddon.find({ slug: { $in: wanted }, isActive: true });
  // A plan that includes an add-on may have it even when the add-on is not
  // otherwise sold with that tier.
  const usable = found.filter((addon) => addon.appliesTo(planSlug) || included.includes(addon.slug));

  const missing = asked.filter((slug) => !usable.some((addon) => addon.slug === slug));
  if (missing.length) {
    const error = new Error(`Not available on this plan: ${missing.join(', ')}`);
    error.status = 400;
    throw error;
  }

  // A paid add-on has to be priced in the plan's currency, or the total is a
  // number in no currency at all. What the plan includes costs nothing, so
  // its list price is irrelevant.
  const planCurrency = String((plan && plan.price && plan.price.currency) || '').toUpperCase();
  if (planCurrency) {
    const foreign = usable.find((addon) => {
      const currency = String((addon.price && addon.price.currency) || '').toUpperCase();
      return !included.includes(addon.slug) && currency && currency !== planCurrency;
    });
    if (foreign) {
      const error = new Error(`Add-on ${foreign.name} is priced in ${foreign.price.currency} but the plan is in ${planCurrency}`);
      error.status = 400;
      throw error;
    }
  }
  return usable;
}

module.exports = {
  resolveAddons,

  // GET /api/platform/public/addons -- the price list's extras.
  publicAddons: async (req, res) => {
    try {
      const addons = await PlatformAddon.find({ isActive: true, isPublic: true }).sort({ order: 1, createdAt: 1 }).lean();
      return res.json({
        success: true,
        data: addons.map((addon) => ({
          id: String(addon._id),
          name: addon.name,
          slug: addon.slug,
          description: addon.description || '',
          price: addon.price,
          planSlugs: addon.planSlugs || []
        }))
      });
    } catch (error) {
      console.error('[platform] public addons:', error);
      return res.status(500).json({ success: false, message: 'Could not load add-ons' });
    }
  },

  list: async (req, res) => {
    try {
      const addons = await PlatformAddon.find({}).sort({ order: 1, createdAt: 1 }).lean();
      return res.json({ success: true, data: await withGymCounts(addons) });
    } catch (error) {
      return fail(res, error);
    }
  },

  create: async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || !String(body.name).trim()) {
        return res.status(400).json({ success: false, message: 'Add-on name is required' });
      }
      const addon = new PlatformAddon({ name: String(body.name).trim(), slug: slugify(body.slug || body.name) });
      applyBody(addon, body);
      await addon.save();

      PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action: 'addon_created', meta: { slug: addon.slug } });
      return res.status(201).json({ success: true, data: { ...addon.toObject(), id: String(addon._id), gym_count: 0 } });
    } catch (error) {
      return fail(res, error);
    }
  },

  update: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Add-on not found' });
      }
      const addon = await PlatformAddon.findById(req.params.id);
      if (!addon) return res.status(404).json({ success: false, message: 'Add-on not found' });

      applyBody(addon, req.body || {});
      if (!addon.name) return res.status(400).json({ success: false, message: 'Add-on name cannot be empty' });
      await addon.save();

      PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action: 'addon_updated', meta: { slug: addon.slug } });

      const [withCount] = await withGymCounts([addon.toObject()]);
      return res.json({ success: true, data: withCount });
    } catch (error) {
      return fail(res, error);
    }
  },

  remove: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Add-on not found' });
      }
      const addon = await PlatformAddon.findById(req.params.id);
      if (!addon) return res.status(404).json({ success: false, message: 'Add-on not found' });

      const inUse = await Gym.countDocuments({ 'subscription.addons.slug': addon.slug });
      if (inUse) {
        return res.status(409).json({
          success: false,
          message: `${inUse} gym(s) are paying for this add-on. Take it off them first, or switch it off instead of deleting it.`
        });
      }

      await PlatformAddon.deleteOne({ _id: addon._id });
      PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action: 'addon_deleted', meta: { slug: addon.slug } });
      return res.json({ success: true, message: 'Add-on deleted' });
    } catch (error) {
      return fail(res, error);
    }
  }
};
