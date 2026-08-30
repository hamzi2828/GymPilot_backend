// src/services/blogs/createBlogService.js
const path = require('path');
const Blog = require('../../models/blogModel');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));
const mongoose = require('mongoose');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

/**
 * Create a new blog post with SEO optimization
 * @param {Object} blogData - The blog data
 * @param {Object} files - Uploaded files
 * @param {String} userId - Author's user ID
 * @returns {Promise<Object>} Created blog
 */
const createBlogService = async (blogData, files, userId) => {
  try {
    const {
      title,
      content,
      categoryId,
      authorId, // Add authorId from request
      status = 'draft',
      slug,
      tags,
      metaTitle,
      metaDescription,
      metaKeywords,
      metaSchema
    } = blogData;

    // Validate required fields
    if (!title || !content || !categoryId) {
      throw new Error('Title, content, and category are required');
    }

    // Handle file uploads
    const imageFile = files?.image?.[0];
    const thumbnailFile = files?.thumbnail?.[0];

    if (!imageFile) {
      throw new Error('Cover image is required');
    }

    // Validate category ID
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw new Error('Invalid category ID format');
    }

    // Check if category exists
    const category = await BlogCategory.findById(categoryId);
    if (!category) {
      throw new Error('Category not found');
    }

    // Validate author if provided
    if (authorId) {
      if (!mongoose.Types.ObjectId.isValid(authorId)) {
        throw new Error('Invalid author ID format');
      }
      const Author = require('../../models/authorModel');
      const author = await Author.findById(authorId);
      if (!author) {
        throw new Error('Author not found');
      }
    }

    // Parse and process tags
    let parsedTags = [];
    if (tags) {
      if (typeof tags === 'string') {
        parsedTags = tags.split(',').map(tag => tag.trim()).filter(tag => tag);
      } else if (Array.isArray(tags)) {
        parsedTags = tags.map(tag => tag.trim()).filter(tag => tag);
      }
    }

    // Validate JSON-LD schema
    if (metaSchema) {
      try {
        const schema = JSON.parse(metaSchema);
        // Ensure it has basic structure
        if (!schema['@context'] || !schema['@type']) {
          throw new Error('JSON-LD schema must include @context and @type');
        }
      } catch (e) {
        throw new Error(`Invalid JSON-LD schema: ${e.message}`);
      }
    }

    // Generate slug if not provided
    const finalSlug = slug || generateSlug(title);

    // Check for duplicate slug
    const existingBlog = await Blog.findOne({ slug: finalSlug });
    if (existingBlog) {
      throw new Error('A blog with this slug already exists');
    }

    // Upload files
    let imageUrl, thumbnailUrl;
    if (USE_BLOB_STORAGE && blobUpload) {
      imageUrl = await blobUpload.uploadToBlob(
        imageFile.buffer, imageFile.originalname, imageFile.mimetype, 'blogs/images'
      );
      if (thumbnailFile) {
        thumbnailUrl = await blobUpload.uploadToBlob(
          thumbnailFile.buffer, thumbnailFile.originalname, thumbnailFile.mimetype, 'blogs/thumbnails'
        );
      }
    } else {
      imageUrl = `/uploads/${imageFile.filename}`;
      thumbnailUrl = thumbnailFile ? `/uploads/${thumbnailFile.filename}` : null;
    }

    // Prepare blog data
    const newBlogData = {
      title: title.trim(),
      content: content.trim(),
      categoryId: new mongoose.Types.ObjectId(categoryId),
      status,
      slug: finalSlug,
      image: imageUrl,
      thumbnail: thumbnailUrl,
      author: authorId ? new mongoose.Types.ObjectId(authorId) : null, // Use authorId if provided
      tags: parsedTags,
      // SEO fields with fallbacks
      metaTitle: metaTitle || title.slice(0, 60),
      metaDescription: metaDescription || stripHtml(content).slice(0, 155),
      metaKeywords: metaKeywords || parsedTags.join(', '),
      metaSchema: metaSchema || generateDefaultSchema(title, content, imageUrl)
    };

    // Create and save the blog
    const blog = new Blog(newBlogData);
    await blog.save();

    // Populate and return the saved blog
    const savedBlog = await Blog.findById(blog._id)
      .populate('categoryId', 'name slug')
      .populate('author', 'name email bio avatar active');

    return savedBlog;
  } catch (error) {
    throw error;
  }
};

/**
 * Generate a URL-friendly slug from title
 * @param {String} title - The blog title
 * @returns {String} Generated slug
 */
const generateSlug = (title) => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 100); // Limit slug length
};

/**
 * Strip HTML tags from content
 * @param {String} html - HTML content
 * @returns {String} Plain text
 */
const stripHtml = (html) => {
  return html.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
};

/**
 * Generate default JSON-LD schema
 * @param {String} title - Blog title
 * @param {String} content - Blog content
 * @param {String} imageUrl - Image URL
 * @returns {String} JSON-LD schema string
 */
const generateDefaultSchema = (title, content, imageUrl) => {
  const schema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": title,
    "description": stripHtml(content).slice(0, 155),
    "image": imageUrl ? `/uploads/${imageUrl}` : undefined,
    "datePublished": new Date().toISOString(),
    "dateModified": new Date().toISOString(),
    "author": {
      "@type": "Organization",
      "name": process.env.SITE_NAME || "GymPilot"
    },
    "publisher": {
      "@type": "Organization",
      "name": process.env.SITE_NAME || "GymPilot",
      "logo": {
        "@type": "ImageObject",
        "url": "/images/logo.png"
      }
    }
  };
  
  return JSON.stringify(schema);
};

module.exports = createBlogService;