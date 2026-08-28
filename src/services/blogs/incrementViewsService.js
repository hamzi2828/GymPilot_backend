// src/services/blogs/incrementViewsService.js
const Blog = require('../../models/blogModel');
const mongoose = require('mongoose');

/**
 * Increment view count for a blog
 * @param {String} blogId - Blog ID
 * @param {String} userIp - User IP address for tracking (optional)
 * @param {String} userId - User ID for tracking (optional)
 * @returns {Promise<Object>} Updated view count
 */
const incrementViewsService = async (blogId, userIp = null, userId = null) => {
  try {
    // Validate blog ID
    if (!mongoose.Types.ObjectId.isValid(blogId)) {
      throw new Error('Invalid blog ID format');
    }
    
    // Find and update blog atomically
    const blog = await Blog.findByIdAndUpdate(
      blogId,
      { 
        $inc: { views: 1 },
        $set: { lastViewedAt: new Date() }
      },
      { 
        new: true,
        select: 'views title slug',
        runValidators: true
      }
    );
    
    if (!blog) {
      throw new Error('Blog not found');
    }
    
    // Log view analytics (if needed in future)
    if (userIp || userId) {
      await logViewAnalytics(blogId, userIp, userId);
    }
    
    return {
      success: true,
      message: 'View count incremented successfully',
      data: {
        blogId: blog._id,
        title: blog.title,
        slug: blog.slug,
        views: blog.views
      }
    };
  } catch (error) {
    throw new Error(`Failed to increment views: ${error.message}`);
  }
};

/**
 * Bulk increment views for multiple blogs
 * @param {Array<String>} blogIds - Array of blog IDs
 * @returns {Promise<Object>} Update results
 */
const bulkIncrementViewsService = async (blogIds) => {
  try {
    // Validate all blog IDs
    const validIds = blogIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    
    if (validIds.length === 0) {
      throw new Error('No valid blog IDs provided');
    }
    
    // Bulk update views
    const result = await Blog.updateMany(
      { _id: { $in: validIds } },
      { 
        $inc: { views: 1 },
        $set: { lastViewedAt: new Date() }
      }
    );
    
    return {
      success: true,
      message: `Views incremented for ${result.modifiedCount} blog(s)`,
      data: {
        blogsUpdated: result.modifiedCount,
        blogsMatched: result.matchedCount
      }
    };
  } catch (error) {
    throw new Error(`Failed to increment views: ${error.message}`);
  }
};

/**
 * Get view statistics for a blog
 * @param {String} blogId - Blog ID
 * @returns {Promise<Object>} View statistics
 */
const getViewStatisticsService = async (blogId) => {
  try {
    // Validate blog ID
    if (!mongoose.Types.ObjectId.isValid(blogId)) {
      throw new Error('Invalid blog ID format');
    }
    
    const blog = await Blog.findById(blogId)
      .select('views createdAt updatedAt title slug');
    
    if (!blog) {
      throw new Error('Blog not found');
    }
    
    // Calculate statistics
    const daysSincePublished = Math.floor(
      (Date.now() - new Date(blog.createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    
    const averageViewsPerDay = daysSincePublished > 0 
      ? Math.round(blog.views / daysSincePublished) 
      : blog.views;
    
    return {
      success: true,
      data: {
        blogId: blog._id,
        title: blog.title,
        slug: blog.slug,
        totalViews: blog.views,
        daysSincePublished,
        averageViewsPerDay,
        publishedDate: blog.createdAt,
        lastModified: blog.updatedAt
      }
    };
  } catch (error) {
    throw new Error(`Failed to get view statistics: ${error.message}`);
  }
};

/**
 * Log view analytics for future tracking
 * @param {String} blogId - Blog ID
 * @param {String} userIp - User IP address
 * @param {String} userId - User ID
 * @returns {Promise<void>}
 */
const logViewAnalytics = async (blogId, userIp, userId) => {
  try {
    // This is a placeholder for future analytics implementation
    // You could store this in a separate collection for detailed analytics
    
    // Example structure:
    // const analytics = {
    //   blogId,
    //   userIp,
    //   userId,
    //   viewedAt: new Date(),
    //   userAgent: req.headers['user-agent'],
    //   referrer: req.headers['referer']
    // };
    
    // For now, just log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`Blog view logged - Blog: ${blogId}, IP: ${userIp}, User: ${userId}`);
    }
  } catch (error) {
    // Don't throw error for analytics logging failure
    console.error('Failed to log view analytics:', error);
  }
};

module.exports = {
  incrementViewsService,
  bulkIncrementViewsService,
  getViewStatisticsService
};