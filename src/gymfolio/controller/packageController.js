const mongoose = require('mongoose');
const Package = require('../models/packageModel');
const PackageOrder = require('../models/packageOrderModel');
const { currencyOr } = require('../../services/currency');
const { parseAmount } = require('../../helper/money');
const { periodProblem } = require('../services/membershipService');

const KINDS = ['membership', 'session_pack', 'day_pass', 'trial', 'pt_pack'];
const INTERVALS = ['day', 'week', 'month', 'year'];

// The billing shape of a package from a request body, falling back to what
// the package already has (on update) or the defaults (on create).
function billingFields({ kind, billing, durationDays, sessions, joiningFee }, existing = {}) {
  const current = existing.billing || {};
  const b = billing && typeof billing === 'object' ? billing : {};
  const out = {};
  if (kind !== undefined || !existing.kind) out.kind = KINDS.includes(kind) ? kind : existing.kind || 'membership';
  if (billing !== undefined || !existing.billing) {
    out.billing = {
      mode: b.mode === 'recurring' ? 'recurring' : b.mode === 'one_time' ? 'one_time' : current.mode || 'one_time',
      interval: INTERVALS.includes(b.interval) ? b.interval : current.interval || 'month',
      intervalCount: Math.max(1, parseInt(b.intervalCount, 10) || current.intervalCount || 1),
      trialDays: Math.max(0, parseInt(b.trialDays, 10) || (b.trialDays === undefined ? current.trialDays || 0 : 0))
    };
  }
  if (durationDays !== undefined) out.durationDays = Math.max(0, parseInt(durationDays, 10) || 0);
  if (sessions !== undefined) out.sessions = Math.max(0, parseInt(sessions, 10) || 0);
  if (joiningFee !== undefined) out.joiningFee = Math.max(0, Number(joiningFee) || 0);
  return out;
}

// A package whose period names no length of time is not saved: it used to
// be sold as 30 days whatever it cost (membershipService.periodProblem).
function refusePeriod(res, problem) {
  return res.status(400).json({ success: false, code: 'PERIOD_NOT_UNDERSTOOD', message: problem, errors: [problem] });
}

// Get all active packages (public endpoint)
const getActivePackages = async (req, res) => {
  try {
    const packages = await Package.getActivePackages();

    res.status(200).json({
      success: true,
      message: 'Active packages retrieved successfully',
      data: packages
    });
  } catch (error) {
    console.error('Error fetching active packages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active packages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all packages (admin only)
const getAllPackages = async (req, res) => {
  try {
    const packages = await Package.getAllPackagesSorted();

    res.status(200).json({
      success: true,
      message: 'All packages retrieved successfully',
      data: packages
    });
  } catch (error) {
    console.error('Error fetching all packages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch packages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single package by ID
const getPackageById = async (req, res) => {
  try {
    const { id } = req.params;
    const package = await Package.findById(id);

    if (!package) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Package retrieved successfully',
      data: package
    });
  } catch (error) {
    console.error('Error fetching package:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch package',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create new package
const createPackage = async (req, res) => {
  try {
    const {
      name,
      price,
      currency,
      period,
      features,
      theme,
      badge,
      supportingText,
      isActive,
      order,
      kind,
      billing,
      durationDays,
      sessions,
      joiningFee
    } = req.body;

    // Parse features if it's a string
    let parsedFeatures = features;
    if (typeof features === 'string') {
      try {
        parsedFeatures = JSON.parse(features);
      } catch (e) {
        // If parsing fails, assume it's a comma-separated string
        parsedFeatures = features.split(',').map(f => f.trim());
      }
    }

    const packageData = {
      name,
      price,
      // The gym's own currency (Settings → General) unless one was given.
      currency: await currencyOr(currency),
      period,
      features: parsedFeatures,
      theme: theme || 'light',
      badge: badge || undefined,
      supportingText: supportingText || undefined,
      isActive: isActive !== undefined ? isActive === 'true' || isActive === true : true,
      order: order ? parseInt(order) : undefined,
      ...billingFields({ kind, billing, durationDays, sessions, joiningFee })
    };

    const problem = period ? periodProblem(packageData) : null;
    if (problem) return refusePeriod(res, problem);

    const package = new Package(packageData);
    await package.save();

    res.status(201).json({
      success: true,
      message: 'Package created successfully',
      data: package
    });
  } catch (error) {
    console.error('Error creating package:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create package',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update package
const updatePackage = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      price,
      currency,
      period,
      features,
      theme,
      badge,
      supportingText,
      isActive,
      order,
      kind,
      billing,
      durationDays,
      sessions,
      joiningFee
    } = req.body;

    const package = await Package.findById(id);
    if (!package) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    // Parse features if it's a string
    let parsedFeatures = features;
    if (features && typeof features === 'string') {
      try {
        parsedFeatures = JSON.parse(features);
      } catch (e) {
        // If parsing fails, assume it's a comma-separated string
        parsedFeatures = features.split(',').map(f => f.trim());
      }
    }

    const updateData = {
      name: name || package.name,
      price: price || package.price,
      // findByIdAndUpdate skips the model's pre-save hook, which is what
      // normally keeps the numeric price in step with the display string.
      priceAmount: parseAmount(price || package.price),
      currency: currency || package.currency,
      period: period || package.period,
      features: parsedFeatures || package.features,
      theme: theme !== undefined ? theme : package.theme,
      badge: badge !== undefined ? badge : package.badge,
      supportingText: supportingText !== undefined ? supportingText : package.supportingText,
      isActive: isActive !== undefined ? (isActive === 'true' || isActive === true) : package.isActive,
      order: order ? parseInt(order) : package.order,
      ...billingFields({ kind, billing, durationDays, sessions, joiningFee }, package)
    };

    // Checked as the package will be once saved. One stored before periods
    // were checked keeps saving while its period is left as it was, so its
    // price or features can still be edited.
    const problem = periodProblem({
      period: updateData.period,
      durationDays: updateData.durationDays !== undefined ? updateData.durationDays : package.durationDays,
      billing: updateData.billing || package.billing
    });
    if (problem && !(periodProblem(package) && String(updateData.period).trim() === package.period)) return refusePeriod(res, problem);

    const updatedPackage = await Package.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    });

    res.status(200).json({
      success: true,
      message: 'Package updated successfully',
      data: updatedPackage
    });
  } catch (error) {
    console.error('Error updating package:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update package',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle package active status.
//
// An explicit boolean in the body is honoured; a body with none (what the
// admin page's toggle button sends) flips the current value.
const togglePackageStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const raw = (req.body || {}).isActive;
    const wanted = typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : null;

    const current = await Package.findById(id).select('isActive');
    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    const isActive = wanted === null ? !current.isActive : wanted;
    const package = await Package.findByIdAndUpdate(
      id,
      { isActive },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: `Package ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: package
    });
  } catch (error) {
    console.error('Error updating package status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update package status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update package order
const updatePackageOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { order } = req.body;

    if (typeof order !== 'number' || order < 0) {
      return res.status(400).json({
        success: false,
        message: 'Order must be a non-negative number'
      });
    }

    const package = await Package.findByIdAndUpdate(
      id,
      { order },
      { new: true, runValidators: true }
    );

    if (!package) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Package order updated successfully',
      data: package
    });
  } catch (error) {
    console.error('Error updating package order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update package order',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Who still depends on a package, as far as deleting it goes.
//
// `live`: orders that are running or waiting on a payment -- a paid
// membership that is active, frozen or past due, or a pending one (a bank
// transfer yet to be confirmed). `renewable`: lapsed memberships that are
// still their member's latest order, i.e. the member has not come back on
// anything since, so the desk may yet renew them. Renewing reads the package
// itself (membershipService.renew), so either kind breaks once it is gone.
// Guest orders are left out of `renewable`: with no account there is nothing
// to renew.
async function packageHolders(packageId) {
  const live = await PackageOrder.countDocuments({
    packageId,
    $or: [
      { 'payment.status': 'paid', status: { $in: ['active', 'frozen', 'past_due'] } },
      { 'payment.status': { $in: ['pending', 'processing'] }, status: 'pending' }
    ]
  });

  const lapsed = await PackageOrder.find({ packageId, userId: { $ne: null }, 'payment.status': 'paid', status: 'expired' })
    .select('userId createdAt')
    .lean();
  let renewable = 0;
  if (lapsed.length) {
    const members = [...new Map(lapsed.map((o) => [String(o.userId), o.userId])).values()];
    const latest = await PackageOrder.aggregate([
      { $match: { userId: { $in: members }, 'payment.status': { $in: ['paid', 'refunded'] } } },
      { $group: { _id: '$userId', at: { $max: '$createdAt' } } }
    ]);
    const latestBy = new Map(latest.map((row) => [String(row._id), new Date(row.at).getTime()]));
    renewable = lapsed.filter((o) => latestBy.get(String(o.userId)) === new Date(o.createdAt).getTime()).length;
  }
  return { live, renewable };
}

// Delete package.
//
// Refused (409) while members still hold it: renewing an order reads its
// package, so deleting one somebody holds left the desk unable to renew
// them. Deactivating takes a package off sale and keeps those working.
const deletePackage = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: 'Package not found' });
    }

    const package = await Package.findById(id);
    if (!package) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    const { live, renewable } = await packageHolders(package._id);
    if (live || renewable) {
      const held = [live ? `${live} running or awaiting payment` : '', renewable ? `${renewable} lapsed and not yet renewed` : '']
        .filter(Boolean)
        .join(', ');
      return res.status(409).json({
        success: false,
        code: 'PACKAGE_IN_USE',
        message: `${package.name} cannot be deleted while members still hold it (${held}). Deactivate it instead: it comes off sale and their memberships keep working.`,
        live,
        renewable
      });
    }

    await Package.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Package deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting package:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete package',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  getActivePackages,
  getAllPackages,
  getPackageById,
  createPackage,
  updatePackage,
  togglePackageStatus,
  updatePackageOrder,
  deletePackage
};
