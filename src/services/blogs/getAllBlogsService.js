// src/services/blogs/getAllBlogsService.js
const Blog = require('../../models/blogModel');

const BLOG_STATUSES = ['published', 'draft'];

/**
 * A search box's text as a literal pattern. Unescaped, "(" is a regex error
 * (a 500) and a crafted pattern can keep the database busy for as long as
 * it likes.
 */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Get all blogs with pagination, filtering and population
 * @param {Object} queryParams - Query parameters for filtering
 * @param {Number} queryParams.page - Page number (default: 1)
 * @param {Number} queryParams.limit - Items per page (default: 10)
 * @param {String} queryParams.status - Filter by status (published/draft); only honoured with includeDrafts
 * @param {String} queryParams.categoryId - Filter by category ID
 * @param {String} queryParams.search - Search in title and content
 * @param {String} queryParams.sortBy - Sort field (default: createdAt)
 * @param {String} queryParams.sortOrder - Sort order (asc/desc, default: desc)
 * @param {Object} [options]
 * @param {Boolean} [options.includeDrafts] - The admin list: drafts too (default: published only)
 * @returns {Promise<Object>} Blogs with pagination info
 */
const getAllBlogsService = async (queryParams = {}, { includeDrafts = false } = {}) => {
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
    
    // Apply filters. The public list -- the blog pages and the website's
    // sitemap -- is published posts only, whatever the query string asks
    // for; drafts are for the admin list, which says so with includeDrafts.
    if (!includeDrafts) {
      query.status = 'published';
    } else if (BLOG_STATUSES.includes(status)) {
      query.status = status;
    }
    
    if (categoryId) {
      query.categoryId = categoryId;
    }
    
    // Search functionality
    const term = search ? escapeRegex(String(search).trim().slice(0, 100)) : '';
    if (term) {
      query.$or = [
        { title: { $regex: term, $options: 'i' } },
        { content: { $regex: term, $options: 'i' } },
        { metaKeywords: { $regex: term, $options: 'i' } }
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
      // The stored summary when the editor wrote one, else the first lines.
      excerpt: blog.excerpt
        ? blog.excerpt
        : blog.content
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
module.exports.escapeRegex = escapeRegex;