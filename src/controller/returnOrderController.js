const ReturnOrder = require('../models/returnOrder');
const Order = require('../models/order');
const { sendReturnEmail } = require('../services/emailService');

const returnOrderController = {
  // Create a return request (User)
  async createReturnRequest(req, res) {
    try {
      const userId = req.user.id;
      const { orderId, items, reason, reasonDescription } = req.body;

      // Validate input
      if (!orderId || !items || items.length === 0 || !reason) {
        return res.status(400).json({
          success: false,
          message: 'Order ID, items, and reason are required'
        });
      }

      // Find the order
      const order = await Order.findById(orderId).populate('items.product');

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      // Check if order belongs to user
      if (order.user && order.user.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: 'You are not authorized to return this order'
        });
      }

      // Check if order is delivered
      if (order.orderStatus !== 'completed') {
        return res.status(400).json({
          success: false,
          message: 'Only completed orders can be returned'
        });
      }

      // Check if return already exists for this order
      const existingReturn = await ReturnOrder.findOne({ order: orderId, status: { $ne: 'rejected' } });
      if (existingReturn) {
        return res.status(400).json({
          success: false,
          message: 'A return request already exists for this order'
        });
      }

      // Calculate refund amount based on returned items
      let refundAmount = 0;
      const returnItems = [];

      for (const returnItem of items) {
        const orderItem = order.items.find(
          item => item.variantId === returnItem.variantId && item.sku === returnItem.sku
        );

        if (!orderItem) {
          return res.status(400).json({
            success: false,
            message: `Item with SKU ${returnItem.sku} not found in order`
          });
        }

        if (returnItem.quantity > orderItem.quantity) {
          return res.status(400).json({
            success: false,
            message: `Cannot return more than ordered quantity for SKU ${returnItem.sku}`
          });
        }

        refundAmount += orderItem.price * returnItem.quantity;
        returnItems.push({
          product: orderItem.product._id || orderItem.product,
          variantId: orderItem.variantId,
          sku: orderItem.sku,
          quantity: returnItem.quantity,
          price: orderItem.price,
          size: orderItem.size,
          color: orderItem.color
        });
      }

      // Generate return number
      const returnNumber = await ReturnOrder.generateReturnNumber();

      // Create return request
      const returnOrder = new ReturnOrder({
        returnNumber,
        order: orderId,
        user: userId,
        items: returnItems,
        reason,
        reasonDescription: reasonDescription || '',
        refundAmount,
        status: 'pending'
      });

      await returnOrder.save();

      // Send return submitted confirmation email
      sendReturnEmail(returnOrder, order, 'returnSubmitted').catch(err => {
        console.error('Failed to send return submitted email:', err.message);
      });

      res.status(201).json({
        success: true,
        message: 'Return request submitted successfully',
        returnOrder
      });
    } catch (error) {
      console.error('Error in createReturnRequest:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to create return request'
      });
    }
  },

  // Get user's return requests
  async getUserReturns(req, res) {
    try {
      const userId = req.user.id;
      const { status, page = 1, limit = 10 } = req.query;

      const query = { user: userId };
      if (status) {
        query.status = status;
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const total = await ReturnOrder.countDocuments(query);

      const returns = await ReturnOrder.find(query)
        .populate({
          path: 'order',
          select: 'orderNumber total createdAt'
        })
        .populate({
          path: 'items.product',
          select: 'name thumbnailUrl primaryImageUrl images bannerUrls'
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

      res.status(200).json({
        success: true,
        returns,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit)),
          limit: parseInt(limit)
        }
      });
    } catch (error) {
      console.error('Error in getUserReturns:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch return requests'
      });
    }
  },

  // Get all return requests (Admin)
  async getAllReturns(req, res) {
    try {
      const { status, page = 1, limit = 10, search } = req.query;

      const query = {};
      if (status && status !== 'all') {
        query.status = status;
      }

      // Handle search
      if (search) {
        query.$or = [
          { returnNumber: { $regex: search, $options: 'i' } }
        ];
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const total = await ReturnOrder.countDocuments(query);

      const returns = await ReturnOrder.find(query)
        .populate({
          path: 'order',
          select: 'orderNumber total createdAt shippingAddress'
        })
        .populate({
          path: 'user',
          select: 'firstName lastName email'
        })
        .populate({
          path: 'items.product',
          select: 'name thumbnailUrl primaryImageUrl images bannerUrls'
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

      res.status(200).json({
        success: true,
        returns,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit)),
          limit: parseInt(limit),
          hasNext: parseInt(page) < Math.ceil(total / parseInt(limit)),
          hasPrev: parseInt(page) > 1
        }
      });
    } catch (error) {
      console.error('Error in getAllReturns:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch return requests'
      });
    }
  },

  // Get return by ID
  async getReturnById(req, res) {
    try {
      const { returnId } = req.params;

      const returnOrder = await ReturnOrder.findById(returnId)
        .populate({
          path: 'order',
          select: 'orderNumber total createdAt shippingAddress paymentMethod stripePaymentIntentId'
        })
        .populate({
          path: 'user',
          select: 'firstName lastName email phone'
        })
        .populate({
          path: 'items.product',
          select: 'name thumbnailUrl primaryImageUrl images bannerUrls'
        });

      if (!returnOrder) {
        return res.status(404).json({
          success: false,
          message: 'Return request not found'
        });
      }

      res.status(200).json({
        success: true,
        returnOrder
      });
    } catch (error) {
      console.error('Error in getReturnById:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch return request'
      });
    }
  },

  // Update return status (Admin)
  async updateReturnStatus(req, res) {
    try {
      const { returnId } = req.params;
      const { status, adminNotes } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          message: 'Status is required'
        });
      }

      const validStatuses = ['pending', 'approved', 'rejected', 'received', 'refunded'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        });
      }

      const returnOrder = await ReturnOrder.findById(returnId);

      if (!returnOrder) {
        return res.status(404).json({
          success: false,
          message: 'Return request not found'
        });
      }

      // Update status and timestamp
      returnOrder.status = status;
      if (adminNotes) {
        returnOrder.adminNotes = adminNotes;
      }

      // Set appropriate timestamp based on status
      switch (status) {
        case 'approved':
          returnOrder.approvedAt = new Date();
          break;
        case 'rejected':
          returnOrder.rejectedAt = new Date();
          break;
        case 'received':
          returnOrder.receivedAt = new Date();
          break;
        case 'refunded':
          returnOrder.refundedAt = new Date();
          // Update the original order status to refunded
          await Order.findByIdAndUpdate(returnOrder.order, {
            orderStatus: 'refunded',
            paymentStatus: 'refunded',
            refundedAt: new Date()
          });
          break;
      }

      await returnOrder.save();

      // Send email notification based on status change
      const order = await Order.findById(returnOrder.order);
      const emailTemplateMap = {
        'approved': 'returnApproved',
        'rejected': 'returnRejected',
        'received': 'returnReceived',
        'refunded': 'returnRefunded'
      };
      const templateType = emailTemplateMap[status];
      if (templateType && order) {
        sendReturnEmail(returnOrder, order, templateType).catch(err => {
          console.error(`Failed to send ${status} return email:`, err.message);
        });
      }

      res.status(200).json({
        success: true,
        message: `Return status updated to ${status}`,
        returnOrder
      });
    } catch (error) {
      console.error('Error in updateReturnStatus:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to update return status'
      });
    }
  },

  // Get return stats (Admin)
  async getReturnStats(req, res) {
    try {
      const stats = await ReturnOrder.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalAmount: { $sum: '$refundAmount' }
          }
        }
      ]);

      const formattedStats = {
        pending: 0,
        approved: 0,
        rejected: 0,
        received: 0,
        refunded: 0,
        totalReturns: 0,
        totalRefundAmount: 0
      };

      stats.forEach(stat => {
        formattedStats[stat._id] = stat.count;
        formattedStats.totalReturns += stat.count;
        if (stat._id === 'refunded') {
          formattedStats.totalRefundAmount = stat.totalAmount;
        }
      });

      res.status(200).json({
        success: true,
        stats: formattedStats
      });
    } catch (error) {
      console.error('Error in getReturnStats:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to fetch return stats'
      });
    }
  },

  // Check if order can be returned
  async canReturnOrder(req, res) {
    try {
      const userId = req.user.id;
      const { orderId } = req.params;

      const order = await Order.findById(orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          canReturn: false,
          message: 'Order not found'
        });
      }

      // Check if order belongs to user
      if (order.user && order.user.toString() !== userId) {
        return res.status(403).json({
          success: false,
          canReturn: false,
          message: 'You are not authorized to return this order'
        });
      }

      // Check if order is delivered
      if (order.orderStatus !== 'completed') {
        return res.status(200).json({
          success: true,
          canReturn: false,
          message: 'Only completed orders can be returned'
        });
      }

      // Check if return already exists
      const existingReturn = await ReturnOrder.findOne({
        order: orderId,
        status: { $nin: ['rejected'] }
      });

      if (existingReturn) {
        return res.status(200).json({
          success: true,
          canReturn: false,
          message: 'A return request already exists for this order',
          existingReturn: {
            returnNumber: existingReturn.returnNumber,
            status: existingReturn.status
          }
        });
      }

      // Check return window (30 days from completion)
      if (order.completedAt) {
        const deliveryDate = new Date(order.completedAt);
        const returnWindowDays = 30;
        const returnDeadline = new Date(deliveryDate);
        returnDeadline.setDate(returnDeadline.getDate() + returnWindowDays);

        if (new Date() > returnDeadline) {
          return res.status(200).json({
            success: true,
            canReturn: false,
            message: `Return window of ${returnWindowDays} days has expired`
          });
        }
      }

      res.status(200).json({
        success: true,
        canReturn: true,
        message: 'Order can be returned'
      });
    } catch (error) {
      console.error('Error in canReturnOrder:', error);
      res.status(500).json({
        success: false,
        canReturn: false,
        message: error.message || 'Failed to check return eligibility'
      });
    }
  }
};

module.exports = returnOrderController;
