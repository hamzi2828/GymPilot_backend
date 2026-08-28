// createBlogCategoryService.js
const path = require('path');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));

/**
 * Service for creating a blog category
 * @param {Object} categoryData - The blog category data
 * @returns {Promise<Object>} - The created blog category
 */
const createBlogCategoryService = async (categoryData) => {
  try {
    // Validate required fields
    if (!categoryData.name) {
      throw new Error('Blog category name is required');
    }

    // Create slug if not provided
    if (!categoryData.slug) {
      categoryData.slug = categoryData.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    }

    // Check if slug already exists
    const existingCategory = await BlogCategory.findOne({ slug: categoryData.slug });
    if (existingCategory) {
      throw new Error(`A blog category with slug "${categoryData.slug}" already exists`);
    }

    // Create the blog category
    const blogCategory = new BlogCategory(categoryData);
    const savedCategory = await blogCategory.save();

    return savedCategory;
  } catch (error) {
    console.error('Error in createBlogCategoryService:', error);
    throw error;
  }
};

module.exports = createBlogCategoryService;
