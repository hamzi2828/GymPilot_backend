// src/controller/preorderController.js

const Preorder = require('../models/preorder');
const Product = require('../models/product');
const { sendEmail } = require('../services/emailService');
const emailTemplates = require('../templates/emailTemplates');

/**
 * Create a new preorder reservation
 * POST /api/preorders
 * Auth: Optional (can be guest or logged-in user)
 */
const createPreorder = async (req, res) => {
  try {
    const { productId, variantId, email, fullName, phone, quantity = 1, variantDetails: requestVariantDetails } = req.body;

    // Debug log for variant tracking
    console.log('Creating preorder:', { productId, variantId, email, variantDetails: requestVariantDetails });

    // Validate required fields
    if (!productId || !email || !fullName) {
      return res.status(400).json({
        success: false,
        message: 'Product ID, email, and full name are required',
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address',
      });
    }

    // Get the product and check if preorder is enabled
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    if (!product.preorderEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Pre-order is not available for this product',
      });
    }

    // Check for existing active preorder with same email, product, AND variant
    // Only block if same exact variant (or both have no variant)
    const existingQuery = {
      product: productId,
      email: email.toLowerCase(),
      status: 'pending',
    };

    // If variantId is provided, check for exact match
    // If no variantId, check for preorders without variant
    if (variantId) {
      existingQuery.variantId = variantId;
    } else {
      // Check for preorders with null/undefined variantId
      existingQuery.$or = [
        { variantId: null },
        { variantId: { $exists: false } }
      ];
    }

    const existingPreorder = await Preorder.findOne(existingQuery);

    if (existingPreorder) {
      // Build descriptive message
      let message = 'You already have an active pre-order for this product';
      if (existingPreorder.variantDetails?.color || existingPreorder.variantDetails?.size) {
        const details = [];
        if (existingPreorder.variantDetails.color) details.push(existingPreorder.variantDetails.color);
        if (existingPreorder.variantDetails.size) details.push(existingPreorder.variantDetails.size);
        message = `You already have an active pre-order for this variant (${details.join(' / ')})`;
      }

      return res.status(400).json({
        success: false,
        message,
        preorderNumber: existingPreorder.preorderNumber,
      });
    }

    // Get variant details - prefer request data, fallback to product variants lookup
    let variantDetails = {};
    if (requestVariantDetails && (requestVariantDetails.color || requestVariantDetails.size)) {
      // Use variant details from request
      variantDetails = {
        color: requestVariantDetails.color || '',
        size: requestVariantDetails.size || '',
      };
    } else if (variantId && product.variants && product.variants.length > 0) {
      // Fallback: try to find variant in product
      const variant = product.variants.find((v) => v.variantId === variantId);
      if (variant) {
        variantDetails = {
          color: variant.color,
          size: variant.size,
        };
      }
    }

    // Create the preorder
    // Note: JWT token uses 'id' not '_id'
    const preorder = new Preorder({
      product: productId,
      variantId: variantId || null,
      user: req.user?.id || req.user?._id || null,
      email: email.toLowerCase(),
      fullName: fullName.trim(),
      phone: phone?.trim() || '',
      quantity: Math.max(1, parseInt(quantity) || 1),
      variantDetails,
    });

    await preorder.save();

    // Send confirmation email
    try {
      const { subject, html } = emailTemplates.preorderConfirmation(preorder, product);
      await sendEmail(preorder.email, subject, html);
    } catch (emailError) {
      console.error('Failed to send preorder confirmation email:', emailError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Pre-order reservation created successfully',
      preorder: {
        preorderNumber: preorder.preorderNumber,
        productName: product.name,
        quantity: preorder.quantity,
        variantDetails: preorder.variantDetails,
        status: preorder.status,
      },
    });
  } catch (error) {
    console.error('Error creating preorder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create pre-order reservation',
    });
  }
};

/**
 * Check if email has active preorder for a product
 * GET /api/preorders/check/:productId
 * Auth: None
 */
const checkPreorder = async (req, res) => {
  try {
    const { productId } = req.params;
    const { email, variantId } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    const query = {
      product: productId,
      email: email.toLowerCase(),
      status: 'pending',
    };

    if (variantId) {
      query.variantId = variantId;
    }

    const preorder = await Preorder.findOne(query);

    res.status(200).json({
      success: true,
      hasActivePreorder: !!preorder,
      preorderNumber: preorder?.preorderNumber || null,
    });
  } catch (error) {
    console.error('Error checking preorder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check pre-order status',
    });
  }
};

/**
 * Get user's preorders
 * GET /api/preorders/user
 * Auth: Required
 */
const getUserPreorders = async (req, res) => {
  try {
    // JWT token uses 'id' not '_id'
    const userId = req.user.id || req.user._id;
    const userEmail = req.user.email;
    const { status, page = 1, limit = 10 } = req.query;

    console.log('getUserPreorders:', { userId, userEmail });

    // Query by user ID OR by email (for preorders created before user ID was properly saved)
    const query = {
      $or: [
        { user: userId },
        { email: userEmail?.toLowerCase() }
      ]
    };
    if (status && ['pending', 'notified', 'converted', 'cancelled'].includes(status)) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [preorders, total] = await Promise.all([
      Preorder.find(query)
        .populate('product', 'name thumbnailUrl slug price discountedPrice colorMedia bannerUrls stock variants')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Preorder.countDocuments(query),
    ]);

    console.log('getUserPreorders result:', { total, preordersCount: preorders.length });

    res.status(200).json({
      success: true,
      preorders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error getting user preorders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get pre-orders',
    });
  }
};

/**
 * Cancel a preorder
 * DELETE /api/preorders/:id
 * Auth: Required
 */
const cancelPreorder = async (req, res) => {
  try {
    const { id } = req.params;
    // JWT token uses 'id' not '_id'
    const userId = req.user.id || req.user._id;

    const preorder = await Preorder.findOne({
      _id: id,
      user: userId,
      status: 'pending',
    });

    if (!preorder) {
      return res.status(404).json({
        success: false,
        message: 'Pre-order not found or cannot be cancelled',
      });
    }

    preorder.status = 'cancelled';
    await preorder.save();

    res.status(200).json({
      success: true,
      message: 'Pre-order cancelled successfully',
    });
  } catch (error) {
    console.error('Error cancelling preorder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel pre-order',
    });
  }
};

/**
 * Admin: Get all preorders
 * GET /api/admin/preorders
 * Auth: Admin
 */
const getAllPreorders = async (req, res) => {
  try {
    const { status, productId, search, page = 1, limit = 20 } = req.query;

    const query = {};

    if (status && ['pending', 'notified', 'converted', 'cancelled'].includes(status)) {
      query.status = status;
    }

    if (productId) {
      query.product = productId;
    }

    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { fullName: { $regex: search, $options: 'i' } },
        { preorderNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [preorders, total] = await Promise.all([
      Preorder.find(query)
        .populate('product', 'name thumbnailUrl slug colorMedia bannerUrls')
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Preorder.countDocuments(query),
    ]);

    // Get counts by status
    const statusCounts = await Preorder.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counts = {
      pending: 0,
      notified: 0,
      converted: 0,
      cancelled: 0,
    };
    statusCounts.forEach((s) => {
      counts[s._id] = s.count;
    });

    res.status(200).json({
      success: true,
      preorders,
      counts,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error getting all preorders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get pre-orders',
    });
  }
};

/**
 * Admin: Send back-in-stock notifications for a product
 * POST /api/admin/preorders/notify/:productId
 * Auth: Admin
 */
const sendBackInStockNotifications = async (req, res) => {
  try {
    const { productId } = req.params;

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Find all pending preorders for this product
    const pendingPreorders = await Preorder.find({
      product: productId,
      status: 'pending',
    });

    if (pendingPreorders.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No pending pre-orders to notify',
        notified: 0,
      });
    }

    let successCount = 0;
    let failedCount = 0;

    // Send emails to all pending preorders
    for (const preorder of pendingPreorders) {
      try {
        const { subject, html } = emailTemplates.preorderBackInStock(preorder, product);
        const result = await sendEmail(preorder.email, subject, html);

        if (result.success) {
          preorder.status = 'notified';
          preorder.notifiedAt = new Date();
          await preorder.save();
          successCount++;
        } else {
          failedCount++;
        }
      } catch (emailError) {
        console.error(`Failed to notify ${preorder.email}:`, emailError.message);
        failedCount++;
      }
    }

    res.status(200).json({
      success: true,
      message: `Notifications sent: ${successCount} successful, ${failedCount} failed`,
      notified: successCount,
      failed: failedCount,
    });
  } catch (error) {
    console.error('Error sending notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send notifications',
    });
  }
};

/**
 * Admin: Toggle preorder on a product
 * PUT /api/admin/products/:productId/preorder
 * Auth: Admin
 */
const toggleProductPreorder = async (req, res) => {
  try {
    const { productId } = req.params;
    const { preorderEnabled, preorderMessage } = req.body;

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    if (typeof preorderEnabled === 'boolean') {
      product.preorderEnabled = preorderEnabled;
    }

    if (typeof preorderMessage === 'string') {
      product.preorderMessage = preorderMessage.trim();
    }

    await product.save();

    res.status(200).json({
      success: true,
      message: `Pre-order ${product.preorderEnabled ? 'enabled' : 'disabled'} for ${product.name}`,
      product: {
        _id: product._id,
        name: product.name,
        preorderEnabled: product.preorderEnabled,
        preorderMessage: product.preorderMessage,
      },
    });
  } catch (error) {
    console.error('Error toggling product preorder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product pre-order settings',
    });
  }
};

/**
 * Admin: Cancel a preorder
 * DELETE /api/admin/preorders/:id
 * Auth: Admin
 */
const adminCancelPreorder = async (req, res) => {
  try {
    const { id } = req.params;

    const preorder = await Preorder.findById(id);
    if (!preorder) {
      return res.status(404).json({
        success: false,
        message: 'Pre-order not found',
      });
    }

    if (preorder.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Pre-order is already cancelled',
      });
    }

    preorder.status = 'cancelled';
    await preorder.save();

    res.status(200).json({
      success: true,
      message: 'Pre-order cancelled successfully',
    });
  } catch (error) {
    console.error('Error cancelling preorder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel pre-order',
    });
  }
};

/**
 * Admin: Delete all preorders
 * DELETE /api/admin/preorders/all
 * Auth: Admin
 */
const deleteAllPreorders = async (req, res) => {
  try {
    const result = await Preorder.deleteMany({});

    res.status(200).json({
      success: true,
      message: `Successfully deleted ${result.deletedCount} pre-orders`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting all preorders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete pre-orders',
    });
  }
};

module.exports = {
  createPreorder,
  checkPreorder,
  getUserPreorders,
  cancelPreorder,
  getAllPreorders,
  sendBackInStockNotifications,
  toggleProductPreorder,
  adminCancelPreorder,
  deleteAllPreorders,
};
