// src/services/blogs/getBlogsByCategoryService.js
const path = require('path');
const Blog = require('../../models/blogModel');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));
const mongoose = require('mongoose');

/**
 * Get blogs by category with pagination
 * @param {String} categoryId - Category ID or slug
 * @param {Object} options - Query options
 * @param {Number} options.page - Page number (default: 1)
 * @param {Number} options.limit - Items per page (default: 10)
 * @param {String} options.status - Filter by status (default: published)
 * @param {String} options.sortBy - Sort field (default: createdAt)
 * @param {String} options.sortOrder - Sort order (default: desc)
 * @param {Boolean} options.includeCategory - Include category details (default: true)
 * @param {String} options.exclude - Blog ID to exclude from results
 * @returns {Promise<Object>} Blogs with pagination info
 */
const getBlogsByCategoryService = async (categoryId, options = {}) => {
  try {
    const {
      page = 1,
      limit = 10,
      status = 'published',
      sortBy = 'createdAt',
      sortOrder = 'desc',
      includeCategory = true,
      exclude
    } = options;
    
    // Find category by ID or slug
    let category;
    if (mongoose.Types.ObjectId.isValid(categoryId)) {
      category = await BlogCategory.findById(categoryId);
    } else {
      // Try to find by slug
      category = await BlogCategory.findOne({ slug: categoryId });
    }
    
    if (!category) {
      throw new Error('Category not found');
    }
    
    // Build query
    const query = {
      categoryId: category._id
    };
    
    // Add status filter if provided
    if (status) {
      query.status = status;
    }

    // Exclude specific blog if provided
    if (exclude && mongoose.Types.ObjectId.isValid(exclude)) {
      query._id = { $ne: exclude };
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    
    // Execute queries in parallel
    const [blogs, total] = await Promise.all([
      Blog.find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('author', 'firstName lastName email avatarUrl')
        .lean(),
      Blog.countDocuments(query)
    ]);
    
    // Transform blogs
    const transformedBlogs = blogs.map(blog => ({
      ...blog,
      categoryName: category.name,
      categorySlug: category.slug,
      authorName: blog.author 
        ? `${blog.author.firstName} ${blog.author.lastName}` 
        : 'Unknown',
      excerpt: blog.content 
        ? blog.content.replace(/<[^>]*>?/gm, '').slice(0, 150) + '...' 
        : '',
      readingTime: calculateReadingTime(blog.content || '')
    }));
    
    const result = {
      success: true,
      data: transformedBlogs,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1
      }
    };
    
    // Include category details if requested
    if (includeCategory) {
      result.category = {
        id: category._id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        active: category.active,
        blogCount: total
      };
    }
    
    return result;
  } catch (error) {
    throw new Error(`Failed to fetch blogs by category: ${error.message}`);
  }
};

/**
 * Get blog count by categories
 * @param {Array<String>} categoryIds - Optional array of category IDs to filter
 * @returns {Promise<Array>} Categories with blog counts
 */
const getBlogCountByCategoriesService = async (categoryIds = []) => {
  try {
    // Build match condition
    const matchCondition = { status: 'published' };
    
    if (categoryIds && categoryIds.length > 0) {
      const validIds = categoryIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      
      if (validIds.length > 0) {
        matchCondition.categoryId = { $in: validIds };
      }
    }
    
    // Aggregate blog counts by category
    const blogCounts = await Blog.aggregate([
      { $match: matchCondition },
      {
        $group: {
          _id: '$categoryId',
          count: { $sum: 1 },
          latestBlog: { $max: '$createdAt' },
          totalViews: { $sum: '$views' }
        }
      },
      {
        $lookup: {
          from: 'blogcategories',
          localField: '_id',
          foreignField: '_id',
          as: 'category'
        }
      },
      { $unwind: '$category' },
      {
        $project: {
          categoryId: '$_id',
          categoryName: '$category.name',
          categorySlug: '$category.slug',
          categoryActive: '$category.active',
          blogCount: '$count',
          latestBlogDate: '$latestBlog',
          totalViews: '$totalViews',
          averageViews: { $divide: ['$totalViews', '$count'] }
        }
      },
      { $sort: { blogCount: -1 } }
    ]);
    
    return {
      success: true,
      data: blogCounts
    };
  } catch (error) {
    throw new Error(`Failed to get blog counts by categories: ${error.message}`);
  }
};

/**
 * Get trending blogs by category
 * @param {String} categoryId - Category ID (optional, all categories if not provided)
 * @param {Number} limit - Number of blogs to return (default: 5)
 * @param {Number} days - Number of days to consider for trending (default: 7)
 * @returns {Promise<Array>} Trending blogs
 */
const getTrendingBlogsByCategoryService = async (categoryId = null, limit = 5, days = 7) => {
  try {
    // Calculate date threshold
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - days);
    
    // Build query
    const query = {
      status: 'published',
      createdAt: { $gte: dateThreshold }
    };
    
    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        throw new Error('Invalid category ID format');
      }
      query.categoryId = categoryId;
    }
    
    // Find trending blogs based on views
    const trendingBlogs = await Blog.find(query)
      .sort({ views: -1, createdAt: -1 })
      .limit(limit)
      .populate('categoryId', 'name slug')
      .populate('author', 'firstName lastName avatarUrl')
      .select('title slug image thumbnail views createdAt categoryId author')
      .lean();
    
    // Transform blogs
    const transformedBlogs = trendingBlogs.map(blog => ({
      ...blog,
      categoryName: blog.categoryId ? blog.categoryId.name : '',
      authorName: blog.author 
        ? `${blog.author.firstName} ${blog.author.lastName}` 
        : 'Unknown',
      trendingScore: calculateTrendingScore(blog.views, blog.createdAt)
    }));
    
    return {
      success: true,
      data: transformedBlogs,
      period: `${days} days`,
      totalFound: transformedBlogs.length
    };
  } catch (error) {
    throw new Error(`Failed to get trending blogs: ${error.message}`);
  }
};

/**
 * Calculate reading time for content
 * @param {String} content - Blog content
 * @returns {Number} Reading time in minutes
 */
const calculateReadingTime = (content) => {
  const wordsPerMinute = 200;
  const text = content.replace(/<[^>]*>?/gm, '');
  const wordCount = text.split(/\s+/).length;
  const readingTime = Math.ceil(wordCount / wordsPerMinute);
  return readingTime;
};

/**
 * Calculate trending score based on views and recency
 * @param {Number} views - Number of views
 * @param {Date} createdAt - Creation date
 * @returns {Number} Trending score
 */
const calculateTrendingScore = (views, createdAt) => {
  const hoursSinceCreation = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  // Give more weight to recent posts
  const recencyFactor = Math.max(1, 72 / hoursSinceCreation);
  return Math.round(views * recencyFactor);
};

module.exports = {
  getBlogsByCategoryService,
  getBlogCountByCategoriesService,
  getTrendingBlogsByCategoryService
};