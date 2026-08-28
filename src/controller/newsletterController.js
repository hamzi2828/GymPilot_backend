// src/controller/newsletterController.js
const Newsletter = require('../models/newsletterModel');

// Subscribe to newsletter
exports.subscribe = async (req, res) => {
  try {
    const { email, source = 'blog' } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Check if email already exists
    const existingSubscription = await Newsletter.findOne({
      email: email.toLowerCase()
    });

    if (existingSubscription) {
      if (existingSubscription.status === 'active') {
        return res.status(409).json({
          success: false,
          message: 'Email is already subscribed to our newsletter'
        });
      } else {
        // Reactivate unsubscribed email
        existingSubscription.status = 'active';
        existingSubscription.subscribedAt = new Date();
        existingSubscription.source = source;
        await existingSubscription.save();

        return res.status(200).json({
          success: true,
          message: 'Welcome back! Your subscription has been reactivated',
          data: {
            email: existingSubscription.email,
            subscribedAt: existingSubscription.subscribedAt
          }
        });
      }
    }

    // Create new subscription
    const newSubscription = new Newsletter({
      email: email.toLowerCase(),
      source,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('User-Agent')
    });

    await newSubscription.save();

    return res.status(201).json({
      success: true,
      message: 'Successfully subscribed to newsletter! Welcome to the Jymor family.',
      data: {
        email: newSubscription.email,
        subscribedAt: newSubscription.subscribedAt
      }
    });

  } catch (error) {
    console.error('Error subscribing to newsletter:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Email is already subscribed'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to subscribe to newsletter. Please try again.',
      error: error.message
    });
  }
};

// Unsubscribe from newsletter
exports.unsubscribe = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const subscription = await Newsletter.unsubscribeEmail(email);

    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'Email not found in our subscription list'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Successfully unsubscribed from newsletter',
      data: {
        email: subscription.email,
        unsubscribedAt: subscription.unsubscribedAt
      }
    });

  } catch (error) {
    console.error('Error unsubscribing from newsletter:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to unsubscribe. Please try again.',
      error: error.message
    });
  }
};

// Get newsletter statistics (admin only)
exports.getStats = async (req, res) => {
  try {
    const activeCount = await Newsletter.getActiveSubscribersCount();
    const totalCount = await Newsletter.countDocuments();
    const unsubscribedCount = await Newsletter.countDocuments({ status: 'unsubscribed' });

    // Get recent subscriptions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentSubscriptions = await Newsletter.countDocuments({
      subscribedAt: { $gte: thirtyDaysAgo },
      status: 'active'
    });

    // Get subscriptions by source
    const subscriptionsBySource = await Newsletter.aggregate([
      { $match: { status: 'active' } },
      {
        $group: {
          _id: '$source',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    return res.status(200).json({
      success: true,
      message: 'Newsletter statistics retrieved successfully',
      data: {
        totalSubscribers: activeCount,
        totalSubscriptions: totalCount,
        unsubscribed: unsubscribedCount,
        recentSubscriptions: recentSubscriptions,
        subscriptionsBySource: subscriptionsBySource
      }
    });

  } catch (error) {
    console.error('Error getting newsletter stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve newsletter statistics',
      error: error.message
    });
  }
};

// Get all subscribers (admin only)
exports.getAllSubscribers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status = 'active',
      sortBy = 'subscribedAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (page - 1) * limit;
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const query = status === 'all' ? {} : { status };

    const [subscribers, total] = await Promise.all([
      Newsletter.find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .select('-userAgent -ipAddress'),
      Newsletter.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      message: 'Subscribers retrieved successfully',
      data: subscribers,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1
      }
    });

  } catch (error) {
    console.error('Error getting subscribers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve subscribers',
      error: error.message
    });
  }
};