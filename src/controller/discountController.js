const Discount = require('../models/discount');

// Get all discounts (admin)
const getAllDiscounts = async (req, res) => {
  try {
    const discounts = await Discount.find().sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      message: 'Discounts retrieved successfully',
      data: discounts
    });
  } catch (error) {
    console.error('Error fetching discounts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch discounts',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single discount by ID
const getDiscountById = async (req, res) => {
  try {
    const { id } = req.params;
    const discount = await Discount.findById(id);

    if (!discount) {
      return res.status(404).json({
        success: false,
        message: 'Discount not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Discount retrieved successfully',
      data: discount
    });
  } catch (error) {
    console.error('Error fetching discount:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch discount',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create new discount
const createDiscount = async (req, res) => {
  try {
    const {
      code,
      description,
      discountType,
      discountValue,
      minimumOrderAmount,
      maximumDiscount,
      usageLimit,
      startDate,
      endDate,
      isActive,
      onePerUser
    } = req.body;

    // Check if code already exists
    const existingDiscount = await Discount.findOne({ code: code.toUpperCase() });
    if (existingDiscount) {
      return res.status(400).json({
        success: false,
        message: 'A discount with this code already exists'
      });
    }

    // Validate percentage value
    if (discountType === 'percentage' && discountValue > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage discount cannot exceed 100%'
      });
    }

    const discountData = {
      code: code.toUpperCase(),
      description,
      discountType,
      discountValue: parseFloat(discountValue),
      minimumOrderAmount: minimumOrderAmount ? parseFloat(minimumOrderAmount) : 0,
      maximumDiscount: maximumDiscount ? parseFloat(maximumDiscount) : null,
      usageLimit: usageLimit ? parseInt(usageLimit) : null,
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: endDate ? new Date(endDate) : null,
      isActive: isActive !== undefined ? isActive : true,
      onePerUser: onePerUser !== undefined ? onePerUser : true
    };

    const discount = new Discount(discountData);
    await discount.save();

    res.status(201).json({
      success: true,
      message: 'Discount created successfully',
      data: discount
    });
  } catch (error) {
    console.error('Error creating discount:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A discount with this code already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create discount',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update discount
const updateDiscount = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      code,
      description,
      discountType,
      discountValue,
      minimumOrderAmount,
      maximumDiscount,
      usageLimit,
      startDate,
      endDate,
      isActive,
      onePerUser
    } = req.body;

    const discount = await Discount.findById(id);
    if (!discount) {
      return res.status(404).json({
        success: false,
        message: 'Discount not found'
      });
    }

    // Check if new code already exists (if code is being changed)
    if (code && code.toUpperCase() !== discount.code) {
      const existingDiscount = await Discount.findOne({ code: code.toUpperCase() });
      if (existingDiscount) {
        return res.status(400).json({
          success: false,
          message: 'A discount with this code already exists'
        });
      }
    }

    // Validate percentage value
    if (discountType === 'percentage' && discountValue > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage discount cannot exceed 100%'
      });
    }

    const updateData = {
      code: code ? code.toUpperCase() : discount.code,
      description: description !== undefined ? description : discount.description,
      discountType: discountType || discount.discountType,
      discountValue: discountValue !== undefined ? parseFloat(discountValue) : discount.discountValue,
      minimumOrderAmount: minimumOrderAmount !== undefined ? parseFloat(minimumOrderAmount) : discount.minimumOrderAmount,
      maximumDiscount: maximumDiscount !== undefined ? (maximumDiscount ? parseFloat(maximumDiscount) : null) : discount.maximumDiscount,
      usageLimit: usageLimit !== undefined ? (usageLimit ? parseInt(usageLimit) : null) : discount.usageLimit,
      startDate: startDate ? new Date(startDate) : discount.startDate,
      endDate: endDate !== undefined ? (endDate ? new Date(endDate) : null) : discount.endDate,
      isActive: isActive !== undefined ? isActive : discount.isActive,
      onePerUser: onePerUser !== undefined ? onePerUser : discount.onePerUser
    };

    const updatedDiscount = await Discount.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    });

    res.status(200).json({
      success: true,
      message: 'Discount updated successfully',
      data: updatedDiscount
    });
  } catch (error) {
    console.error('Error updating discount:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update discount',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle discount active status
const toggleDiscountStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }

    const discount = await Discount.findByIdAndUpdate(
      id,
      { isActive },
      { new: true, runValidators: true }
    );

    if (!discount) {
      return res.status(404).json({
        success: false,
        message: 'Discount not found'
      });
    }

    res.status(200).json({
      success: true,
      message: `Discount ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: discount
    });
  } catch (error) {
    console.error('Error updating discount status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update discount status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete discount
const deleteDiscount = async (req, res) => {
  try {
    const { id } = req.params;

    const discount = await Discount.findById(id);
    if (!discount) {
      return res.status(404).json({
        success: false,
        message: 'Discount not found'
      });
    }

    await Discount.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Discount deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting discount:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete discount',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Apply discount code (uses optional auth to check per-user usage)
const applyDiscount = async (req, res) => {
  try {
    const { code, orderAmount } = req.body;
    // Get user ID if authenticated (from optionalAuth middleware)
    const userId = req.user ? (req.user._id || req.user.id) : null;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Discount code is required'
      });
    }

    const discount = await Discount.findOne({ code: code.toUpperCase() });

    if (!discount) {
      return res.status(404).json({
        success: false,
        message: 'Invalid discount code'
      });
    }

    // Check if discount is valid (including per-user check)
    const validation = discount.isValid(orderAmount || 0, userId);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.message
      });
    }

    // For one-per-user coupons, require user to be logged in
    if (discount.onePerUser && !userId) {
      return res.status(400).json({
        success: false,
        message: 'Please log in to use this discount code'
      });
    }

    // Calculate discount amount
    const discountAmount = discount.calculateDiscount(orderAmount || 0);

    res.status(200).json({
      success: true,
      message: 'Discount code applied successfully',
      data: {
        discount: discount.discountType === 'percentage' ? discount.discountValue : null,
        discountAmount,
        discountType: discount.discountType,
        discountValue: discount.discountValue,
        code: discount.code
      }
    });
  } catch (error) {
    console.error('Error applying discount:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to apply discount',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get discount statistics
const getDiscountStats = async (req, res) => {
  try {
    const totalDiscounts = await Discount.countDocuments();
    const activeDiscounts = await Discount.countDocuments({ isActive: true });
    const expiredDiscounts = await Discount.countDocuments({
      endDate: { $lt: new Date() }
    });

    const totalUsage = await Discount.aggregate([
      { $group: { _id: null, total: { $sum: '$usedCount' } } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalDiscounts,
        activeDiscounts,
        expiredDiscounts,
        inactiveDiscounts: totalDiscounts - activeDiscounts,
        totalUsage: totalUsage[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('Error fetching discount stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch discount statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Generate unique code
const generateCode = async (req, res) => {
  try {
    const { prefix } = req.query;
    let code;
    let exists = true;

    // Generate unique code
    while (exists) {
      code = Discount.generateCode(prefix || 'PROMO');
      exists = await Discount.findOne({ code });
    }

    res.status(200).json({
      success: true,
      data: { code }
    });
  } catch (error) {
    console.error('Error generating code:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate code',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  getAllDiscounts,
  getDiscountById,
  createDiscount,
  updateDiscount,
  toggleDiscountStatus,
  deleteDiscount,
  applyDiscount,
  getDiscountStats,
  generateCode
};
