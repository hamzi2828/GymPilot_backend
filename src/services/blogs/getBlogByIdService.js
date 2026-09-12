// src/services/blogs/getBlogByIdService.js
const Blog = require('../../models/blogModel');
const mongoose = require('mongoose');

/**
 * Get a single blog by ID or slug
 * @param {String} identifier - Blog ID or slug
 * @param {Boolean} incrementView - Whether to increment view count (default: false)
 * @returns {Promise<Object>} Blog details
 */
const getBlogByIdService = async (identifier, incrementView = false) => {
  try {
    // Determine if identifier is an ObjectId or slug
    let query;
    if (mongoose.Types.ObjectId.isValid(identifier)) {
      query = { _id: identifier };
    } else {
      // Treat as slug
      query = { slug: identifier };
    }
    
    // Find the blog
    const blog = await Blog.findOne(query)
      .populate('categoryId', 'name slug active description')
      .populate('author', 'name email bio avatar active')
      .lean();
    
    if (!blog) {
      throw new Error('Blog not found');
    }
    
    // Increment view count if requested
    if (incrementView) {
      await Blog.findByIdAndUpdate(
        blog._id,
        { $inc: { views: 1 } },
        { new: false }
      );
      blog.views = (blog.views || 0) + 1;
    }
    
    // Transform blog with computed fields
    const transformedBlog = {
      ...blog,
      categoryName: blog.categoryId ? blog.categoryId.name : '',
      authorName: blog.author 
        ? blog.author.name
        : 'Unknown',
      authorBio: blog.author ? blog.author.bio : '',
      // The stored summary when the editor wrote one, else the first lines.
      excerpt: blog.excerpt
        ? blog.excerpt
        : blog.content
          ? blog.content.replace(/<[^>]*>?/gm, '').slice(0, 200) + '...'
          : '',
      readingTime: calculateReadingTime(blog.content || ''),
      publishedDate: blog.status === 'published' ? blog.createdAt : null,
      lastModified: blog.updatedAt,
      // SEO fields with defaults
      seo: {
        title: blog.metaTitle || blog.title,
        description: blog.metaDescription || 
          blog.content?.replace(/<[^>]*>?/gm, '').slice(0, 155) || '',
        keywords: blog.metaKeywords || '',
        schema: blog.metaSchema || null,
        ogImage: blog.image || blog.thumbnail || null
      }
    };
    
    // Get related blogs (same category, exclude current)
    const relatedBlogs = await getRelatedBlogs(blog._id, blog.categoryId, 3);
    
    return {
      success: true,
      data: transformedBlog,
      relatedBlogs
    };
  } catch (error) {
    if (error.message === 'Blog not found') throw error;
    throw new Error(`Failed to fetch blog: ${error.message}`);
  }
};

/**
 * Get related blogs based on category
 * @param {ObjectId} excludeId - Blog ID to exclude
 * @param {ObjectId} categoryId - Category ID
 * @param {Number} limit - Number of related blogs to fetch
 * @returns {Promise<Array>} Related blogs
 */
const getRelatedBlogs = async (excludeId, categoryId, limit = 3) => {
  try {
    if (!categoryId) return [];
    
    const relatedBlogs = await Blog.find({
      _id: { $ne: excludeId },
      categoryId: categoryId,
      status: 'published'
    })
    .select('title slug image thumbnail views createdAt')
    .sort({ views: -1, createdAt: -1 })
    .limit(limit)
    .lean();
    
    return relatedBlogs.map(blog => ({
      ...blog,
      excerpt: blog.content 
        ? blog.content.replace(/<[^>]*>?/gm, '').slice(0, 100) + '...' 
        : ''
    }));
  } catch (error) {
    console.error('Error fetching related blogs:', error);
    return [];
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

module.exports = getBlogByIdService;