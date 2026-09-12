// src/services/blogs/updateBlogService.js
const path = require('path');
const Blog = require('../../models/blogModel');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));
const mongoose = require('mongoose');
// The same form helpers the create path uses, so an edit form is read the
// same way as a create form.
const { normaliseCategoryId, readBoolean, urlOrNull, storeUpload } = require('./createBlogService');

/**
 * Update an existing blog post
 * @param {String} blogId - The blog ID to update
 * @param {Object} updateData - The data to update
 * @param {Object} files - Uploaded files (optional)
 * @returns {Promise<Object>} Updated blog
 */
const updateBlogService = async (blogId, updateData, files = {}) => {
  try {
    // Validate blog ID
    if (!mongoose.Types.ObjectId.isValid(blogId)) {
      throw new Error('Invalid blog ID format');
    }

    // Check if blog exists
    const existingBlog = await Blog.findById(blogId);
    if (!existingBlog) {
      throw new Error('Blog not found');
    }

    const {
      title,
      content,
      authorId, // Add authorId
      status,
      slug,
      tags,
      excerpt,
      metaTitle,
      metaDescription,
      metaKeywords,
      metaSchema
    } = updateData;
    // An edit form hands the category back as the populated object it was
    // given; only the id is wanted.
    const categoryId = normaliseCategoryId(updateData.categoryId);
    const featuredInput = updateData.isFeatured !== undefined ? updateData.isFeatured : updateData.featured;

    // Validate category if provided
    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        throw new Error('Invalid category ID format');
      }
      
      const category = await BlogCategory.findById(categoryId);
      if (!category) {
        throw new Error('Category not found');
      }
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

    // Handle file uploads if provided
    const imageFile = files?.image?.[0];
    const thumbnailFile = files?.thumbnail?.[0];

    // Parse and process tags
    let parsedTags = tags;
    if (tags && typeof tags === 'string') {
      parsedTags = tags.split(',').map(tag => tag.trim()).filter(tag => tag);
    }

    // Validate JSON-LD schema if provided
    if (metaSchema) {
      try {
        const schema = JSON.parse(metaSchema);
        if (!schema['@context'] || !schema['@type']) {
          throw new Error('JSON-LD schema must include @context and @type');
        }
      } catch (e) {
        throw new Error(`Invalid JSON-LD schema: ${e.message}`);
      }
    }

    // Check for duplicate slug if slug is being changed
    if (slug && slug !== existingBlog.slug) {
      const duplicateBlog = await Blog.findOne({ 
        slug, 
        _id: { $ne: blogId } 
      });
      if (duplicateBlog) {
        throw new Error('A blog with this slug already exists');
      }
    }

    // Build update object
    const updateObject = {};
    
    // Core fields
    if (title !== undefined) updateObject.title = String(title).trim();
    if (content !== undefined) updateObject.content = String(content).trim();
    if (categoryId) updateObject.categoryId = new mongoose.Types.ObjectId(categoryId);
    if (authorId !== undefined) updateObject.author = authorId ? new mongoose.Types.ObjectId(authorId) : null;
    if (status !== undefined) updateObject.status = status;
    if (slug !== undefined) updateObject.slug = slug;
    if (parsedTags !== undefined) updateObject.tags = parsedTags;
    if (featuredInput !== undefined) updateObject.featured = readBoolean(featuredInput);
    if (excerpt !== undefined) updateObject.excerpt = typeof excerpt === 'string' ? excerpt.trim().slice(0, 500) : '';

    // File uploads. Without a file, a URL string (from the generic media
    // upload, or the existing value echoed back) is accepted for either.
    if (imageFile) {
      updateObject.image = await storeUpload(imageFile, 'blogs/images');
    } else if (typeof updateData.image === 'string' && updateData.image.trim() && updateData.image.trim() !== existingBlog.image) {
      updateObject.image = urlOrNull(updateData.image);
    }
    if (thumbnailFile) {
      updateObject.thumbnail = await storeUpload(thumbnailFile, 'blogs/thumbnails');
    } else if (typeof updateData.thumbnail === 'string' && updateData.thumbnail.trim() !== (existingBlog.thumbnail || '')) {
      // An empty string clears the thumbnail; a new URL replaces it.
      updateObject.thumbnail = urlOrNull(updateData.thumbnail);
    }
    
    // SEO fields
    if (metaTitle !== undefined) {
      updateObject.metaTitle = metaTitle || (title || existingBlog.title).slice(0, 60);
    }
    if (metaDescription !== undefined) {
      updateObject.metaDescription = metaDescription || 
        stripHtml(content || existingBlog.content).slice(0, 155);
    }
    if (metaKeywords !== undefined) {
      updateObject.metaKeywords = metaKeywords;
    }
    if (metaSchema !== undefined) {
      updateObject.metaSchema = metaSchema;
    }

    // Update modified date in schema if content changed
    if ((title || content) && existingBlog.metaSchema) {
      try {
        const schema = JSON.parse(existingBlog.metaSchema);
        schema.dateModified = new Date().toISOString();
        if (title) schema.headline = title;
        if (content) schema.description = stripHtml(content).slice(0, 155);
        updateObject.metaSchema = JSON.stringify(schema);
      } catch (e) {
        // If existing schema is invalid, ignore
      }
    }

    // Perform the update
    const updatedBlog = await Blog.findByIdAndUpdate(
      blogId,
      updateObject,
      { new: true, runValidators: true }
    )
    .populate('categoryId', 'name slug')
    .populate('author', 'name email bio avatar active');

    return updatedBlog;
  } catch (error) {
    throw error;
  }
};

/**
 * Strip HTML tags from content
 * @param {String} html - HTML content
 * @returns {String} Plain text
 */
const stripHtml = (html) => {
  return html.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
};

module.exports = updateBlogService;