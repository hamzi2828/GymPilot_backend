const Order = require('../models/order');

// Helper function to find color media for a specific color with case-insensitive matching
function findColorMedia(colorMediaObj, variantColor) {
  // Create variations of the color name to try different case formats
  const colorVariations = [
    variantColor,                                    // Original case
    variantColor.toLowerCase(),                      // lowercase
    variantColor.toUpperCase(),                      // UPPERCASE
    variantColor.charAt(0).toUpperCase() + variantColor.slice(1).toLowerCase(), // Title case
  ];

  // Try to find an exact match first
  for (const colorKey of colorVariations) {
    if (colorMediaObj[colorKey]) {
      return {
        media: colorMediaObj[colorKey],
        key: colorKey
      };
    }
  }

  return { media: null, key: null };
}

class OrderService {
  /**
   * Get orders for a specific user
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Orders with pagination
   */
  async getUserOrders(userId, options = {}) {
    const { status, page = 1, limit = 10 } = options;

    const query = { user: userId };
    if (status) {
      query.orderStatus = status;
    }

    const skip = (page - 1) * limit;

    const orders = await Order.find(query)
      .populate({
        path: 'items.product',
        select: 'name price discountedPrice thumbnail thumbnailUrl stock category status productType colorMedia variants featured bannerUrls images'
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalOrders = await Order.countDocuments(query);

    // Process orders to add variant-specific data
    this.processOrdersVariants(orders);

    return {
      success: true,
      orders: orders,
      pagination: {
        total: totalOrders,
        page: parseInt(page),
        pages: Math.ceil(totalOrders / limit),
        limit: parseInt(limit)
      }
    };
  }

  /**
   * Get all orders for admin
   * @param {Object} options - Query options
   * @returns {Promise<Object>} All orders with pagination
   */
  async getAllOrders(options = {}) {
    const { status, page = 1, limit = 50, search } = options;

    const query = {};
    if (status) {
      query.orderStatus = status;
    }

    // Add search functionality for order number, customer name, or email
    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'shippingAddress.fullName': { $regex: search, $options: 'i' } },
        { 'shippingAddress.email': { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (page - 1) * limit;

    const orders = await Order.find(query)
      .populate({
        path: 'items.product',
        select: 'name price discountedPrice thumbnail thumbnailUrl stock category status productType colorMedia variants featured bannerUrls images'
      })
      .populate({
        path: 'user',
        select: 'firstName lastName email'
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalOrders = await Order.countDocuments(query);

    // Process orders to add variant-specific data
    this.processOrdersVariants(orders);

    return {
      success: true,
      orders: orders,
      pagination: {
        total: totalOrders,
        page: parseInt(page),
        pages: Math.ceil(totalOrders / limit),
        limit: parseInt(limit)
      }
    };
  }

  /**
   * Get order by ID for a specific user
   * @param {string} orderId - Order ID
   * @param {string} [userId] - User ID. Pass null/undefined to bypass the user filter (admin lookup).
   * @returns {Promise<Object>} Order details
   */
  async getOrderById(orderId, userId) {
    const query = { _id: orderId };
    if (userId) query.user = userId;
    const order = await Order.findOne(query).populate({
      path: 'items.product',
      select: 'name price discountedPrice thumbnail thumbnailUrl stock category status productType colorMedia variants featured bannerUrls images description'
    });

    if (!order) {
      throw new Error('Order not found');
    }

    // Process order to add variant-specific data
    this.processOrdersVariants([order]);

    return {
      success: true,
      order: order
    };
  }

  /**
   * Update order status
   * @param {string} orderId - Order ID
   * @param {string} newStatus - New status
   * @returns {Promise<Object>} Updated order
   */
  async updateOrderStatus(orderId, newStatus) {
    const validStatuses = ['submitted', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'];

    if (!validStatuses.includes(newStatus)) {
      throw new Error('Invalid order status');
    }

    const order = await Order.findById(orderId);
    if (!order) {
      throw new Error('Order not found');
    }

    order.orderStatus = newStatus;

    // Set timestamps based on status
    const now = new Date();
    switch (newStatus) {
      case 'shipped':
        order.shippedAt = now;
        break;
      case 'completed':
        order.completedAt = now;
        break;
      case 'cancelled':
        order.cancelledAt = now;
        break;
      case 'refunded':
        order.refundedAt = now;
        break;
    }

    await order.save();

    return {
      success: true,
      order: order
    };
  }

  /**
   * Bulk update order status for multiple orders
   * @param {Array<string>} orderIds
   * @param {string} newStatus
   */
  async bulkUpdateOrderStatus(orderIds, newStatus) {
    const validStatuses = ['submitted', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error('Invalid order status');
    }
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      throw new Error('orderIds must be a non-empty array');
    }

    const update = { orderStatus: newStatus };
    const now = new Date();
    if (newStatus === 'shipped') update.shippedAt = now;
    if (newStatus === 'completed') update.completedAt = now;
    if (newStatus === 'cancelled') update.cancelledAt = now;
    if (newStatus === 'refunded') update.refundedAt = now;

    const result = await Order.updateMany({ _id: { $in: orderIds } }, { $set: update });
    return {
      success: true,
      modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
      matchedCount: result.matchedCount ?? result.n ?? 0
    };
  }

  /**
   * Delete a single order
   * @param {string} orderId
   */
  async deleteOrder(orderId) {
    const result = await Order.deleteOne({ _id: orderId });
    if (result.deletedCount === 0) {
      throw new Error('Order not found');
    }
    return { success: true };
  }

  /**
   * Bulk delete orders
   * @param {Array<string>} orderIds
   */
  async bulkDeleteOrders(orderIds) {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      throw new Error('orderIds must be a non-empty array');
    }
    const result = await Order.deleteMany({ _id: { $in: orderIds } });
    return { success: true, deletedCount: result.deletedCount ?? 0 };
  }

  /**
   * Process orders to add variant-specific data
   * @param {Array} orders - Array of orders
   */
  processOrdersVariants(orders) {
    orders.forEach(order => {
      order.items.forEach(item => {
        if (item.product && item.variantId && item.product.variants) {
          // Find the specific variant for this order item
          const productVariant = item.product.variants.find(v => v.variantId === item.variantId);

          if (productVariant) {
            // Convert to plain object to allow modifications
            const productObj = item.product.toObject();

            // Handle colorMedia properly
            let colorMediaObj = {};
            if (item.product.colorMedia) {
              if (item.product.colorMedia instanceof Map || item.product.colorMedia.get) {
                colorMediaObj = Object.fromEntries(item.product.colorMedia);
              } else {
                colorMediaObj = item.product.colorMedia;
              }
            }

            // Replace all variants with only the specific variant for this order item
            productObj.variants = [productVariant];

            // Find and set only the specific colorMedia for this variant's color
            if (Object.keys(colorMediaObj).length > 0 && productVariant.color) {
              const specificColorMedia = findColorMedia(colorMediaObj, productVariant.color);

              if (specificColorMedia.media && specificColorMedia.key) {
                productObj.colorMedia = {
                  [specificColorMedia.key]: specificColorMedia.media
                };

                // Set the primary image URL for easy access
                if (specificColorMedia.media.thumbnailUrl) {
                  productObj.primaryImageUrl = specificColorMedia.media.thumbnailUrl;
                } else if (specificColorMedia.media.bannerUrls && specificColorMedia.media.bannerUrls.length > 0) {
                  productObj.primaryImageUrl = specificColorMedia.media.bannerUrls[0];
                }
              } else {
                productObj.colorMedia = {};
              }
            }

            // Replace the product with the modified object
            item.product = productObj;
          } else {
            // Convert to plain object and clear variants if no match found
            const productObj = item.product.toObject();
            productObj.variants = [];
            item.product = productObj;
          }
        }
      });
    });
  }
}

module.exports = new OrderService();