// packageRegistrationController.js - Package Registration Controller

const PackageRegistration = require('../models/packageRegistrationModel');

/**
 * @desc    Create a new package registration
 * @route   POST /api/package-registrations
 * @access  Public
 */
const createRegistration = async (req, res) => {
  try {
    const { username, phone, email, platform } = req.body;

    // Validation
    if (!username || !phone || !email || !platform) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields: username, phone, email, and platform'
      });
    }

    // Validate platform
    if (!['gymwear', 'gymfolio'].includes(platform)) {
      return res.status(400).json({
        success: false,
        message: 'Platform must be either gymwear or gymfolio'
      });
    }

    // Create registration
    const registration = new PackageRegistration({
      username,
      phone,
      email,
      platform
    });

    await registration.save();

    res.status(201).json({
      success: true,
      message: 'Registration submitted successfully',
      data: registration
    });
  } catch (error) {
    console.error('Error creating registration:', error);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to submit registration',
      error: error.message
    });
  }
};

/**
 * @desc    Get all package registrations (Admin)
 * @route   GET /api/package-registrations
 * @access  Private/Admin
 */
const getAllRegistrations = async (req, res) => {
  try {
    const { platform, status, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (platform) filter.platform = platform;
    if (status) filter.status = status;

    const skip = (page - 1) * limit;

    const registrations = await PackageRegistration.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await PackageRegistration.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: registrations,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch registrations',
      error: error.message
    });
  }
};

/**
 * @desc    Get registration by ID (Admin)
 * @route   GET /api/package-registrations/:id
 * @access  Private/Admin
 */
const getRegistrationById = async (req, res) => {
  try {
    const registration = await PackageRegistration.findById(req.params.id);

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }

    res.status(200).json({
      success: true,
      data: registration
    });
  } catch (error) {
    console.error('Error fetching registration:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch registration',
      error: error.message
    });
  }
};

/**
 * @desc    Update registration status (Admin)
 * @route   PUT /api/package-registrations/:id/status
 * @access  Private/Admin
 */
const updateRegistrationStatus = async (req, res) => {
  try {
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    const validStatuses = ['pending', 'contacted', 'registered', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${validStatuses.join(', ')}`
      });
    }

    const registration = await PackageRegistration.findById(req.params.id);

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }

    registration.status = status;
    if (notes !== undefined) registration.notes = notes;

    await registration.save();

    res.status(200).json({
      success: true,
      message: 'Registration status updated successfully',
      data: registration
    });
  } catch (error) {
    console.error('Error updating registration status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update registration status',
      error: error.message
    });
  }
};

/**
 * @desc    Delete registration (Admin)
 * @route   DELETE /api/package-registrations/:id
 * @access  Private/Admin
 */
const deleteRegistration = async (req, res) => {
  try {
    const registration = await PackageRegistration.findById(req.params.id);

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }

    await registration.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Registration deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting registration:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete registration',
      error: error.message
    });
  }
};

/**
 * @desc    Get registration statistics (Admin)
 * @route   GET /api/package-registrations/stats
 * @access  Private/Admin
 */
const getRegistrationStats = async (req, res) => {
  try {
    const { platform } = req.query;
    const filter = platform ? { platform } : {};

    const total = await PackageRegistration.countDocuments(filter);
    const pending = await PackageRegistration.countDocuments({ ...filter, status: 'pending' });
    const contacted = await PackageRegistration.countDocuments({ ...filter, status: 'contacted' });
    const registered = await PackageRegistration.countDocuments({ ...filter, status: 'registered' });
    const rejected = await PackageRegistration.countDocuments({ ...filter, status: 'rejected' });

    const byPlatform = await PackageRegistration.aggregate([
      { $group: { _id: '$platform', count: { $sum: 1 } } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        total,
        byStatus: {
          pending,
          contacted,
          registered,
          rejected
        },
        byPlatform: byPlatform.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    console.error('Error fetching registration stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch registration statistics',
      error: error.message
    });
  }
};

module.exports = {
  createRegistration,
  getAllRegistrations,
  getRegistrationById,
  updateRegistrationStatus,
  deleteRegistration,
  getRegistrationStats
};
