// src/controller/customOrderController.js

const CustomOrder = require('../models/customOrder');
const Category = require('../models/category');
const { toPublicPath } = require('../helper/upload');

// Check if blob storage is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Helper to process files (works with both local and blob storage)
async function processFiles(files) {
  if (!files || !files.referenceImages || files.referenceImages.length === 0) {
    return [];
  }

  if (USE_BLOB_STORAGE) {
    // Use blob storage
    const { processUploadedFiles } = require('../helper/blobUpload');
    const result = await processUploadedFiles(files, 'custom-orders');
    return result.referenceImages ? (Array.isArray(result.referenceImages) ? result.referenceImages : [result.referenceImages]) : [];
  } else {
    // Use local storage - files are already saved by multer
    return files.referenceImages.map(file => toPublicPath(file.filename));
  }
}

// Helper to delete file (works with both local and blob storage)
async function removeFile(url) {
  if (!url) return;

  if (USE_BLOB_STORAGE && url.includes('blob.vercel-storage.com')) {
    const { deleteFromBlob } = require('../helper/blobUpload');
    await deleteFromBlob(url);
  } else if (!USE_BLOB_STORAGE && url.startsWith('/uploads/')) {
    const fs = require('fs');
    const path = require('path');
    const { UPLOADS_DIR } = require('../helper/upload');
    const filePath = path.join(UPLOADS_DIR, path.basename(url));
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error('Error deleting local file:', err);
    }
  }
}

// Create a new custom order (Public - no auth required)
exports.createCustomOrder = async (req, res) => {
  try {
    const {
      categoryId,
      categoryName,
      customerDetails,
      measurements,
      // New fields
      kind,
      style,
      fabric,
      shippingOption,
      pricing
    } = req.body;

    // Parse JSON strings if needed (for form-data requests)
    const parsedCustomerDetails = typeof customerDetails === 'string'
      ? JSON.parse(customerDetails)
      : customerDetails;

    const parsedMeasurements = typeof measurements === 'string'
      ? JSON.parse(measurements)
      : (measurements || []);

    // Validate customer details
    if (!parsedCustomerDetails || !parsedCustomerDetails.fullName || !parsedCustomerDetails.email || !parsedCustomerDetails.phone) {
      return res.status(400).json({
        success: false,
        message: 'Full name, email, and phone are required'
      });
    }

    // Verify category exists (optional - allow 'custom' for generic orders)
    let category = null;
    let finalCategoryName = categoryName || 'Custom Order';

    if (categoryId && categoryId !== 'custom') {
      category = await Category.findById(categoryId);
      if (category) {
        finalCategoryName = categoryName || category.name;
      }
    }

    // Process uploaded images (for legacy form-data requests)
    let referenceImages = [];
    if (req.files && req.files.referenceImages) {
      referenceImages = await processFiles(req.files);
    }

    // Build custom order data
    const orderData = {
      category: category ? categoryId : null,
      categoryName: finalCategoryName,
      customerDetails: parsedCustomerDetails,
      measurements: parsedMeasurements,
      referenceImages,
      user: req.user?._id || null
    };

    // Add new selection fields if provided
    if (kind) {
      orderData.kind = typeof kind === 'string' ? JSON.parse(kind) : kind;
    }
    if (style) {
      orderData.style = typeof style === 'string' ? JSON.parse(style) : style;
    }
    if (fabric) {
      orderData.fabric = typeof fabric === 'string' ? JSON.parse(fabric) : fabric;
    }
    if (shippingOption) {
      orderData.shippingOption = typeof shippingOption === 'string' ? JSON.parse(shippingOption) : shippingOption;
    }
    if (pricing) {
      orderData.pricing = typeof pricing === 'string' ? JSON.parse(pricing) : pricing;
    }

    // Create custom order
    const customOrder = new CustomOrder(orderData);

    await customOrder.save();

    res.status(201).json({
      success: true,
      message: 'Custom order submitted successfully',
      data: customOrder
    });
  } catch (error) {
    console.error('Error creating custom order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create custom order',
      error: error.message
    });
  }
};

// Get all custom orders (Admin only)
exports.getAllCustomOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;

    const query = {};
    if (status && status !== 'all') {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'customerDetails.fullName': { $regex: search, $options: 'i' } },
        { 'customerDetails.email': { $regex: search, $options: 'i' } },
        { 'customerDetails.phone': { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [orders, total] = await Promise.all([
      CustomOrder.find(query)
        .populate('category', 'name slug')
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      CustomOrder.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching custom orders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch custom orders',
      error: error.message
    });
  }
};

// Get custom order by ID (Admin only)
exports.getCustomOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await CustomOrder.findById(id)
      .populate('category', 'name slug')
      .populate('user', 'name email');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Custom order not found'
      });
    }

    res.status(200).json({
      success: true,
      data: order
    });
  } catch (error) {
    console.error('Error fetching custom order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch custom order',
      error: error.message
    });
  }
};

// Update custom order status (Admin only)
exports.updateCustomOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes, quotedPrice, estimatedDelivery } = req.body;

    const order = await CustomOrder.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Custom order not found'
      });
    }

    // Update fields
    if (status) order.status = status;
    if (adminNotes !== undefined) order.adminNotes = adminNotes;
    if (quotedPrice !== undefined) order.quotedPrice = quotedPrice;
    if (estimatedDelivery !== undefined) order.estimatedDelivery = estimatedDelivery;

    // Set timestamps based on status
    if (status === 'quoted' || status === 'reviewing') {
      order.respondedAt = new Date();
    }
    if (status === 'completed') {
      order.completedAt = new Date();
    }

    await order.save();

    res.status(200).json({
      success: true,
      message: 'Custom order updated successfully',
      data: order
    });
  } catch (error) {
    console.error('Error updating custom order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update custom order',
      error: error.message
    });
  }
};

// Delete custom order (Admin only)
exports.deleteCustomOrder = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await CustomOrder.findById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Custom order not found'
      });
    }

    // Delete reference images from storage
    if (order.referenceImages && order.referenceImages.length > 0) {
      for (const imageUrl of order.referenceImages) {
        try {
          await removeFile(imageUrl);
        } catch (err) {
          console.error('Error deleting image:', err);
        }
      }
    }

    await CustomOrder.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Custom order deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting custom order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete custom order',
      error: error.message
    });
  }
};

// Get user's own custom orders (Authenticated user)
exports.getUserCustomOrders = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 10 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [orders, total] = await Promise.all([
      CustomOrder.find({ user: userId })
        .populate('category', 'name slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      CustomOrder.countDocuments({ user: userId })
    ]);

    res.status(200).json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching user custom orders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch custom orders',
      error: error.message
    });
  }
};

// Get custom order stats (Admin only)
exports.getCustomOrderStats = async (req, res) => {
  try {
    const stats = await CustomOrder.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const total = await CustomOrder.countDocuments();
    const statusCounts = stats.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        total,
        byStatus: statusCounts
      }
    });
  } catch (error) {
    console.error('Error fetching custom order stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch stats',
      error: error.message
    });
  }
};
