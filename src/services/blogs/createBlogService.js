// src/services/blogs/createBlogService.js
const path = require('path');
const Blog = require('../../models/blogModel');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));
const mongoose = require('mongoose');
const { gymSiteName } = require('../gymName');
const { cleanBlogHtml, cleanExcerpt, readMetaSchema, writeMetaSchema } = require('./blogHtml');

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
      authorId, // Add authorId from request
      status = 'draft',
      slug,
      tags,
      excerpt,
      metaTitle,
      metaDescription,
      metaKeywords,
      metaSchema
    } = blogData;
    // The body is stored as the article markup it may contain and nothing
    // else (services/blogs/blogHtml.js). One that is only a script is empty.
    const content = cleanBlogHtml(blogData.content);
    // The category may arrive as an id or as the populated object an edit
    // form hands back; either way only the id is wanted.
    const categoryId = normaliseCategoryId(blogData.categoryId);
    const featured = readBoolean(blogData.isFeatured !== undefined ? blogData.isFeatured : blogData.featured);

    // Validate required fields
    if (!title || !content || !categoryId) {
      throw new Error('Title, content, and category are required');
    }

    // Handle file uploads. The cover image is optional: a post can be
    // drafted first and get its photo on a later update. A URL string (from
    // the generic media upload) is accepted in place of a file.
    const imageFile = files?.image?.[0];
    const thumbnailFile = files?.thumbnail?.[0];

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

    // Validate JSON-LD schema: a JSON object, stored re-serialised.
    const storedSchema = metaSchema ? readMetaSchema(metaSchema) : null;

    // Generate slug if not provided
    const finalSlug = slug || generateSlug(title);

    // Check for duplicate slug
    const existingBlog = await Blog.findOne({ slug: finalSlug });
    if (existingBlog) {
      throw new Error('A blog with this slug already exists');
    }

    // Upload files (or keep the URL strings the form sent)
    const imageUrl = imageFile ? await storeUpload(imageFile, 'blogs/images') : urlOrNull(blogData.image);
    const thumbnailUrl = thumbnailFile ? await storeUpload(thumbnailFile, 'blogs/thumbnails') : urlOrNull(blogData.thumbnail);

    // The gym's name for the structured data -- from its settings, not env.
    const siteName = await gymSiteName();

    // Prepare blog data
    const newBlogData = {
      title: title.trim(),
      content,
      categoryId: new mongoose.Types.ObjectId(categoryId),
      status,
      featured,
      slug: finalSlug,
      image: imageUrl,
      thumbnail: thumbnailUrl,
      excerpt: cleanExcerpt(excerpt),
      author: authorId ? new mongoose.Types.ObjectId(authorId) : null, // Use authorId if provided
      tags: parsedTags,
      // SEO fields with fallbacks
      metaTitle: metaTitle || title.slice(0, 60),
      metaDescription: metaDescription || stripHtml(content).slice(0, 155),
      metaKeywords: metaKeywords || parsedTags.join(', '),
      metaSchema: storedSchema || generateDefaultSchema(title, content, imageUrl, siteName)
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
 * Store an uploaded file where this deployment keeps uploads and return the
 * public URL: Vercel Blob when configured, the local uploads folder otherwise.
 */
const storeUpload = async (file, folder) => {
  if (USE_BLOB_STORAGE && blobUpload) {
    return blobUpload.uploadToBlob(file.buffer, file.originalname, file.mimetype, folder);
  }
  return `/uploads/${file.filename}`;
};

/** A URL string from the form, or null. Anything that is not text is ignored. */
const urlOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** 'true' / true / 1 -> true; anything else false. Forms send strings. */
const readBoolean = (value) => value === true || value === 'true' || value === 1 || value === '1';

/**
 * The category id out of whatever the form sent: a string id, a populated
 * category object, or that object as JSON (multipart forms stringify).
 */
const normaliseCategoryId = (value) => {
  if (value && typeof value === 'object') return String(value._id || value.id || '');
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      return normaliseCategoryId(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return value;
};

/**
 * Generate default JSON-LD schema
 * @param {String} title - Blog title
 * @param {String} content - Blog content
 * @param {String|null} imageUrl - Image URL, already public (a blob URL or /uploads/...)
 * @param {String} siteName - The gym's name
 * @returns {String} JSON-LD schema string
 */
const generateDefaultSchema = (title, content, imageUrl, siteName = 'GymPilot') => {
  const schema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": title,
    "description": stripHtml(content).slice(0, 155),
    "image": imageUrl || undefined,
    "datePublished": new Date().toISOString(),
    "dateModified": new Date().toISOString(),
    "author": {
      "@type": "Organization",
      "name": siteName
    },
    "publisher": {
      "@type": "Organization",
      "name": siteName,
      "logo": {
        "@type": "ImageObject",
        "url": "/images/logo.png"
      }
    }
  };

  return writeMetaSchema(schema);
};

module.exports = createBlogService;
module.exports.normaliseCategoryId = normaliseCategoryId;
module.exports.readBoolean = readBoolean;
module.exports.urlOrNull = urlOrNull;
module.exports.storeUpload = storeUpload;