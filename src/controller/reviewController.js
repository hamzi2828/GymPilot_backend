// src/controller/reviewController.js

const Review = require('../models/review');
const Product = require('../models/product');
const { toPublicPath } = require('../helper/upload');

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

async function processReviewImages(files) {
  if (!files || !files.length) return [];
  if (USE_BLOB_STORAGE) {
    const { uploadMultipleToBlob } = require('../helper/blobUpload');
    return uploadMultipleToBlob(files, 'reviews');
  }
  return files.map((f) => toPublicPath(f.filename));
}

const reviewController = {
  // Create a new review
  createReview: async (req, res) => {
    try {
      const { productId, rating, title, comment } = req.body;
      const userId = req.user.id;
      const userName = `${req.user.firstName} ${req.user.lastName}`.trim();
      const parsedRating = typeof rating === 'string' ? parseInt(rating, 10) : rating;

      // Validate required fields
      if (!productId || !parsedRating || !comment) {
        return res.status(400).json({
          success: false,
          message: 'Product ID, rating, and comment are required'
        });
      }

      // Validate rating range
      if (parsedRating < 1 || parsedRating > 5) {
        return res.status(400).json({
          success: false,
          message: 'Rating must be between 1 and 5'
        });
      }

      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      // Check if user already reviewed this product
      const existingReview = await Review.findOne({ product: productId, user: userId });
      if (existingReview) {
        return res.status(400).json({
          success: false,
          message: 'You have already reviewed this product'
        });
      }

      const imageUrls = await processReviewImages(req.files);

      // Create the review
      const review = new Review({
        product: productId,
        user: userId,
        userName,
        rating: parsedRating,
        title: title || null,
        comment,
        verified: false,
        images: imageUrls
      });

      await review.save();

      console.log('✅ Review created successfully:', review._id);

      res.status(201).json({
        success: true,
        message: 'Review submitted successfully',
        data: review
      });
    } catch (error) {
      console.error('❌ Error creating review:', error);

      // Handle duplicate key error
      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: 'You have already reviewed this product'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Failed to submit review',
        error: error.message
      });
    }
  },

  // Get reviews for a product
  getProductReviews: async (req, res) => {
    try {
      const { productId } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      // Get reviews with pagination
      const reviews = await Review.find({ product: productId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      // Get total count
      const totalReviews = await Review.countDocuments({ product: productId });

      // Calculate aggregate stats
      const stats = await Review.aggregate([
        { $match: { product: require('mongoose').Types.ObjectId.createFromHexString(productId) } },
        {
          $group: {
            _id: null,
            averageRating: { $avg: '$rating' },
            totalReviews: { $sum: 1 },
            rating5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
            rating4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
            rating3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
            rating2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
            rating1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } }
          }
        }
      ]);

      const aggregateStats = stats[0] || {
        averageRating: 0,
        totalReviews: 0,
        rating5: 0,
        rating4: 0,
        rating3: 0,
        rating2: 0,
        rating1: 0
      };

      res.status(200).json({
        success: true,
        reviews,
        averageRating: Math.round(aggregateStats.averageRating * 10) / 10 || 0,
        totalReviews: aggregateStats.totalReviews,
        ratingDistribution: {
          5: aggregateStats.rating5,
          4: aggregateStats.rating4,
          3: aggregateStats.rating3,
          2: aggregateStats.rating2,
          1: aggregateStats.rating1
        },
        pagination: {
          page,
          limit,
          totalPages: Math.ceil(totalReviews / limit),
          hasNextPage: page * limit < totalReviews
        }
      });
    } catch (error) {
      console.error('❌ Error fetching reviews:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch reviews',
        error: error.message
      });
    }
  },

  // Update own review
  updateReview: async (req, res) => {
    try {
      const { reviewId } = req.params;
      const { rating, title, comment } = req.body;
      const userId = req.user.id;

      // Find the review
      const review = await Review.findById(reviewId);
      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }

      // Check ownership
      if (review.user.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: 'You can only update your own reviews'
        });
      }

      // Validate rating if provided
      if (rating && (rating < 1 || rating > 5)) {
        return res.status(400).json({
          success: false,
          message: 'Rating must be between 1 and 5'
        });
      }

      // Update fields
      if (rating) review.rating = rating;
      if (title !== undefined) review.title = title || null;
      if (comment) review.comment = comment;

      await review.save();

      console.log('✅ Review updated successfully:', review._id);

      res.status(200).json({
        success: true,
        message: 'Review updated successfully',
        data: review
      });
    } catch (error) {
      console.error('❌ Error updating review:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update review',
        error: error.message
      });
    }
  },

  // Delete own review
  deleteReview: async (req, res) => {
    try {
      const { reviewId } = req.params;
      const userId = req.user.id;

      // Find the review
      const review = await Review.findById(reviewId);
      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }

      // Check ownership
      if (review.user.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete your own reviews'
        });
      }

      await Review.findByIdAndDelete(reviewId);

      console.log('✅ Review deleted successfully:', reviewId);

      res.status(200).json({
        success: true,
        message: 'Review deleted successfully'
      });
    } catch (error) {
      console.error('❌ Error deleting review:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete review',
        error: error.message
      });
    }
  },

  // Get user's reviews
  getUserReviews: async (req, res) => {
    try {
      const userId = req.user.id;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const reviews = await Review.find({ user: userId })
        .populate('product', 'name slug thumbnailUrl')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await Review.countDocuments({ user: userId });

      res.status(200).json({
        success: true,
        reviews,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total
        }
      });
    } catch (error) {
      console.error('❌ Error fetching user reviews:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch reviews',
        error: error.message
      });
    }
  },

  // Check if user can review a product
  canReviewProduct: async (req, res) => {
    try {
      const { productId } = req.params;
      const userId = req.user.id;

      // Check if user already has a review for this product
      const existingReview = await Review.findOne({ product: productId, user: userId });

      res.status(200).json({
        success: true,
        canReview: !existingReview,
        hasReviewed: !!existingReview,
        existingReview: existingReview || null
      });
    } catch (error) {
      console.error('❌ Error checking review status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to check review status',
        error: error.message
      });
    }
  },

  // ==================== ADMIN METHODS ====================

  // Get all reviews with pagination, search, and filters (Admin)
  getAllReviews: async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;
      const search = req.query.search || '';
      const rating = req.query.rating ? parseInt(req.query.rating) : null;
      const verified = req.query.verified;
      const productId = req.query.productId;

      // Build filter query
      const filter = {};

      // Filter by rating
      if (rating && rating >= 1 && rating <= 5) {
        filter.rating = rating;
      }

      // Filter by verified status
      if (verified === 'true') {
        filter.verified = true;
      } else if (verified === 'false') {
        filter.verified = false;
      }

      // Filter by product
      if (productId) {
        filter.product = productId;
      }

      // Build aggregation pipeline for search
      let pipeline = [];

      // Lookup product details
      pipeline.push({
        $lookup: {
          from: 'products',
          localField: 'product',
          foreignField: '_id',
          as: 'productData'
        }
      });

      pipeline.push({
        $unwind: {
          path: '$productData',
          preserveNullAndEmptyArrays: true
        }
      });

      // Apply base filters
      if (Object.keys(filter).length > 0) {
        pipeline.push({ $match: filter });
      }

      // Search by user name or product name
      if (search) {
        pipeline.push({
          $match: {
            $or: [
              { userName: { $regex: search, $options: 'i' } },
              { 'productData.name': { $regex: search, $options: 'i' } }
            ]
          }
        });
      }

      // Get total count before pagination
      const countPipeline = [...pipeline, { $count: 'total' }];
      const countResult = await Review.aggregate(countPipeline);
      const total = countResult[0]?.total || 0;

      // Add sorting and pagination
      pipeline.push({ $sort: { createdAt: -1 } });
      pipeline.push({ $skip: skip });
      pipeline.push({ $limit: limit });

      // Project final fields
      pipeline.push({
        $project: {
          _id: 1,
          user: 1,
          userName: 1,
          rating: 1,
          title: 1,
          comment: 1,
          verified: 1,
          helpful: 1,
          createdAt: 1,
          updatedAt: 1,
          product: {
            _id: '$productData._id',
            name: '$productData.name',
            slug: '$productData.slug',
            thumbnailUrl: '$productData.thumbnailUrl'
          }
        }
      });

      const reviews = await Review.aggregate(pipeline);

      res.status(200).json({
        success: true,
        data: reviews,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total
        }
      });
    } catch (error) {
      console.error('❌ Error fetching all reviews:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch reviews',
        error: error.message
      });
    }
  },

  // Get single review by ID with product and user details (Admin)
  getReviewById: async (req, res) => {
    try {
      const { id } = req.params;

      const review = await Review.findById(id)
        .populate('product', 'name slug thumbnailUrl')
        .populate('user', 'firstName lastName email')
        .lean();

      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }

      res.status(200).json({
        success: true,
        data: review
      });
    } catch (error) {
      console.error('❌ Error fetching review:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch review',
        error: error.message
      });
    }
  },

  // Update any review (Admin - no ownership check)
  adminUpdateReview: async (req, res) => {
    try {
      const { id } = req.params;
      const { rating, title, comment } = req.body;

      const review = await Review.findById(id);
      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }

      // Validate rating if provided
      if (rating && (rating < 1 || rating > 5)) {
        return res.status(400).json({
          success: false,
          message: 'Rating must be between 1 and 5'
        });
      }

      // Update fields
      if (rating) review.rating = rating;
      if (title !== undefined) review.title = title || null;
      if (comment) review.comment = comment;

      await review.save();

      // Fetch updated review with populated fields
      const updatedReview = await Review.findById(id)
        .populate('product', 'name slug thumbnailUrl')
        .populate('user', 'firstName lastName email')
        .lean();

      console.log('✅ Review updated by admin:', review._id);

      res.status(200).json({
        success: true,
        message: 'Review updated successfully',
        data: updatedReview
      });
    } catch (error) {
      console.error('❌ Error updating review:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update review',
        error: error.message
      });
    }
  },

  // Toggle verified status (Admin)
  toggleVerified: async (req, res) => {
    try {
      const { id } = req.params;

      const review = await Review.findById(id);
      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }

      review.verified = !review.verified;
      await review.save();

      console.log(`✅ Review ${review._id} verified status toggled to: ${review.verified}`);

      res.status(200).json({
        success: true,
        message: `Review ${review.verified ? 'verified' : 'unverified'} successfully`,
        data: {
          _id: review._id,
          verified: review.verified
        }
      });
    } catch (error) {
      console.error('❌ Error toggling review verified status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to toggle verified status',
        error: error.message
      });
    }
  },

  // Delete any review (Admin - no ownership check)
  adminDeleteReview: async (req, res) => {
    try {
      const { id } = req.params;

      const review = await Review.findById(id);
      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }

      await Review.findByIdAndDelete(id);

      console.log('✅ Review deleted by admin:', id);

      res.status(200).json({
        success: true,
        message: 'Review deleted successfully'
      });
    } catch (error) {
      console.error('❌ Error deleting review:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete review',
        error: error.message
      });
    }
  },

  // Get overall review statistics (Admin)
  getReviewStats: async (req, res) => {
    try {
      const stats = await Review.aggregate([
        {
          $group: {
            _id: null,
            totalReviews: { $sum: 1 },
            averageRating: { $avg: '$rating' },
            verifiedCount: { $sum: { $cond: ['$verified', 1, 0] } },
            rating5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
            rating4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
            rating3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
            rating2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
            rating1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } }
          }
        }
      ]);

      const result = stats[0] || {
        totalReviews: 0,
        averageRating: 0,
        verifiedCount: 0,
        rating5: 0,
        rating4: 0,
        rating3: 0,
        rating2: 0,
        rating1: 0
      };

      res.status(200).json({
        success: true,
        data: {
          totalReviews: result.totalReviews,
          averageRating: Math.round(result.averageRating * 10) / 10 || 0,
          verifiedCount: result.verifiedCount,
          unverifiedCount: result.totalReviews - result.verifiedCount,
          ratingDistribution: {
            5: result.rating5,
            4: result.rating4,
            3: result.rating3,
            2: result.rating2,
            1: result.rating1
          }
        }
      });
    } catch (error) {
      console.error('❌ Error fetching review stats:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch review statistics',
        error: error.message
      });
    }
  }
};

module.exports = reviewController;
