// src/gymfolio/controller/couponController.js

const mongoose = require('mongoose');
const Coupon = require('../models/couponModel');
const Package = require('../models/packageModel');
const { parseAmount } = require('../../helper/money');
const { applyCoupon, MembershipError } = require('../services/membershipService');
const T = require('../../attendance/services/timeUtils');

// A bare 'YYYY-MM-DD' from a date input names a whole day at the gym: "valid
// until 30 Sep" must still work at 23:59 on the 30th there, not stop at
// midnight UTC the night before -- and "valid from 1 Oct" must start at the
// gym's midnight, not five hours later. A full timestamp is taken as is.
function readBoundary(value, edge) {
  if (T.isDateOnly(value)) {
    const key = String(value).trim();
    return edge === 'end' ? T.lastMomentOfLocalDay(key) : T.startOfLocalDay(key);
  }
  return new Date(value);
}

function fail(res, error) {
  if (error instanceof MembershipError) return res.status(error.status).json({ success: false, message: error.message, code: error.code || undefined });
  if (error && error.name === 'ValidationError') return res.status(400).json({ success: false, message: error.message });
  if (error && error.code === 11000) return res.status(409).json({ success: false, message: 'A coupon with that code already exists' });
  console.error('[coupons]', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

function applyBody(coupon, body) {
  if (body.code !== undefined) coupon.code = String(body.code || '').toUpperCase().trim();
  if (body.description !== undefined) coupon.description = String(body.description || '').trim();
  if (body.type !== undefined) coupon.type = body.type;
  if (body.value !== undefined) coupon.value = Number(body.value) || 0;
  // No currency from the body: a coupon is in the gym's currency, which the
  // model sets on save (services/currency.js catalogueCurrency).
  if (body.packageIds !== undefined) {
    coupon.packageIds = (Array.isArray(body.packageIds) ? body.packageIds : []).filter((id) => mongoose.Types.ObjectId.isValid(id));
  }
  if (body.validFrom !== undefined) coupon.validFrom = body.validFrom ? readBoundary(body.validFrom, 'start') : null;
  if (body.validUntil !== undefined) coupon.validUntil = body.validUntil ? readBoundary(body.validUntil, 'end') : null;
  if (body.maxRedemptions !== undefined) coupon.maxRedemptions = Math.max(0, Math.floor(Number(body.maxRedemptions) || 0));
  if (body.appliesToRenewals !== undefined) coupon.appliesToRenewals = !!body.appliesToRenewals;
  if (body.isActive !== undefined) coupon.isActive = !!body.isActive;
}

module.exports = {
  // GET /api/gymfolio/coupons
  list: async (req, res) => {
    try {
      const coupons = await Coupon.find({}).sort({ createdAt: -1 }).populate('packageIds', 'name').lean();
      return res.json({ success: true, data: coupons });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/coupons
  create: async (req, res) => {
    try {
      const body = req.body || {};
      const coupon = new Coupon({ createdBy: req.user && (req.user._id || req.user.id) });
      applyBody(coupon, body);
      if (coupon.type === 'percent' && (coupon.value <= 0 || coupon.value > 100)) {
        return res.status(400).json({ success: false, message: 'Percent discounts must be between 1 and 100' });
      }
      await coupon.save();
      return res.status(201).json({ success: true, data: coupon });
    } catch (error) {
      return fail(res, error);
    }
  },

  // PUT /api/gymfolio/coupons/:id
  update: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ success: false, message: 'Coupon not found' });
      const coupon = await Coupon.findById(req.params.id);
      if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
      applyBody(coupon, req.body || {});
      await coupon.save();
      return res.json({ success: true, data: coupon });
    } catch (error) {
      return fail(res, error);
    }
  },

  // DELETE /api/gymfolio/coupons/:id
  remove: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ success: false, message: 'Coupon not found' });
      const result = await Coupon.deleteOne({ _id: req.params.id });
      if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Coupon not found' });
      return res.json({ success: true, message: 'Coupon deleted' });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/coupons/validate   { code, packageId }  -- public preview at checkout
  validate: async (req, res) => {
    try {
      const { code, packageId } = req.body || {};
      if (!code || !packageId) return res.status(400).json({ success: false, message: 'Code and package are required' });
      const pkg = await Package.findById(packageId);
      if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });
      const price = parseAmount(pkg.price) || 0;
      const { coupon, discount, total } = await applyCoupon(code, pkg, price);
      return res.json({
        success: true,
        data: {
          code: coupon.code,
          description: coupon.description,
          type: coupon.type,
          value: coupon.value,
          discount,
          total,
          currency: pkg.currency,
          appliesToRenewals: coupon.appliesToRenewals
        }
      });
    } catch (error) {
      return fail(res, error);
    }
  }
};
