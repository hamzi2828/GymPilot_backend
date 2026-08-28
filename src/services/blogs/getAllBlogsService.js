// src/services/blogs/getAllBlogsService.js
const Blog = require('../../models/blogModel');

/**
 * Get all blogs with pagination, filtering and population
 * @param {Object} queryParams - Query parameters for filtering
 * @param {Number} queryParams.page - Page number (default: 1)
 * @param {Number} queryParams.limit - Items per page (default: 10)
 * @param {String} queryParams.status - Filter by status (published/draft)
 * @param {String} queryParams.categoryId - Filter by category ID
 * @param {String} queryParams.search - Search in title and content
 * @param {String} queryParams.sortBy - Sort field (default: createdAt)
 * @param {String} queryParams.sortOrder - Sort order (asc/desc, default: desc)
 * @returns {Promise<Object>} Blogs with pagination info
 */
const getAllBlogsService = async (queryParams = {}) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      categoryId,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = queryParams;

    // Build query
    const query = {};
    
    // Apply filters
    if (status) {
      query.status = status;
    }
    
    if (categoryId) {
      query.categoryId = categoryId;
    }
    
    // Search functionality
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } },
        { metaKeywords: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;
    
    // Execute queries in parallel for performance
    const [blogs, total] = await Promise.all([
      Blog.find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('categoryId', 'name slug active')
        .populate('author', 'name email bio avatar active')
        .lean(),
      Blog.countDocuments(query)
    ]);
    
    // Transform blogs to include computed fields
    const transformedBlogs = blogs.map(blog => ({
      ...blog,
      categoryName: blog.categoryId ? blog.categoryId.name : '',
      authorName: blog.author 
        ? blog.author.name
        : 'Unknown',
      excerpt: blog.content 
        ? blog.content.replace(/<[^>]*>?/gm, '').slice(0, 150) + '...' 
        : '',
      readingTime: calculateReadingTime(blog.content || '')
    }));
    
    return {
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
  } catch (error) {
    throw new Error(`Failed to fetch blogs: ${error.message}`);
  }
};

/**
 * Calculate estimated reading time for content
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

module.exports = getAllBlogsService;