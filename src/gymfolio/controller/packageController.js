const Package = require('../models/packageModel');

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
      order
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
      currency: currency || 'PKR',
      period,
      features: parsedFeatures,
      theme: theme || 'light',
      badge: badge || undefined,
      supportingText: supportingText || undefined,
      isActive: isActive !== undefined ? isActive === 'true' || isActive === true : true,
      order: order ? parseInt(order) : undefined
    };

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
      order
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
      currency: currency || package.currency,
      period: period || package.period,
      features: parsedFeatures || package.features,
      theme: theme !== undefined ? theme : package.theme,
      badge: badge !== undefined ? badge : package.badge,
      supportingText: supportingText !== undefined ? supportingText : package.supportingText,
      isActive: isActive !== undefined ? (isActive === 'true' || isActive === true) : package.isActive,
      order: order ? parseInt(order) : package.order
    };

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

// Toggle package active status
const togglePackageStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }

    const package = await Package.findByIdAndUpdate(
      id,
      { isActive },
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

// Delete package
const deletePackage = async (req, res) => {
  try {
    const { id } = req.params;

    const package = await Package.findById(id);
    if (!package) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
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
