// getBlogCategoriesService.js
const path = require('path');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));
const mongoose = require('mongoose');

/**
 * Service for getting all blog categories
 * @param {Object} options - Query options (sorting, filtering)
 * @returns {Promise<Array>} - Array of blog categories
 */
const getBlogCategoriesService = async (options = {}) => {
  try {
    const { sort = { createdAt: -1 }, filter = {} } = options;
    
    // Build query
    const query = BlogCategory.find(filter).sort(sort);
    
    // Execute query
    const categories = await query.exec();
    
    return categories;
  } catch (error) {
    console.error('Error in getBlogCategoriesService:', error);
    throw error;
  }
};

/**
 * Service for getting a single blog category by ID
 * @param {String} categoryId - The ID of the blog category
 * @returns {Promise<Object>} - The blog category
 */
const getBlogCategoryByIdService = async (categoryId) => {
  try {
    // Validate ID format
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw new Error('Invalid blog category ID format');
    }
    
    // Find the category
    const category = await BlogCategory.findById(categoryId);
    
    if (!category) {
      throw new Error('Blog category not found');
    }
    
    return category;
  } catch (error) {
    console.error('Error in getBlogCategoryByIdService:', error);
    throw error;
  }
};

/**
 * Service for getting blog categories with post counts
 * @param {Object} options - Query options (sorting, filtering)
 * @returns {Promise<Array>} - Array of blog categories with counts
 */
const getBlogCategoriesWithCountService = async (options = {}) => {
  try {
    const { sort = { createdAt: -1 }, filter = {} } = options;

    // Use aggregation to get categories with blog counts
    const categoriesWithCount = await BlogCategory.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'blogs', // Collection name for blogs
          localField: '_id',
          foreignField: 'categoryId',
          as: 'blogs'
        }
      },
      {
        $addFields: {
          count: { $size: '$blogs' }
        }
      },
      {
        $project: {
          blogs: 0 // Remove the blogs array, we only need the count
        }
      },
      { $sort: sort }
    ]);

    return categoriesWithCount;
  } catch (error) {
    console.error('Error in getBlogCategoriesWithCountService:', error);
    throw error;
  }
};

/**
 * Service for toggling the active status of a blog category
 * @param {String} categoryId - The ID of the blog category
 * @returns {Promise<Object>} - The updated blog category
 */
const toggleBlogCategoryActiveService = async (categoryId) => {
  try {
    // Validate ID format
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw new Error('Invalid blog category ID format');
    }

    // Find the category
    const category = await BlogCategory.findById(categoryId);

    if (!category) {
      throw new Error('Blog category not found');
    }

    // Toggle active status
    category.active = !category.active;

    // Save the updated category
    const updatedCategory = await category.save();

    return updatedCategory;
  } catch (error) {
    console.error('Error in toggleBlogCategoryActiveService:', error);
    throw error;
  }
};

/**
 * Service for toggling the featured status of a blog category
 * @param {String} categoryId - The ID of the blog category
 * @returns {Promise<Object>} - The updated blog category
 */
const toggleBlogCategoryFeaturedService = async (categoryId) => {
  try {
    // Validate ID format
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw new Error('Invalid blog category ID format');
    }

    // Find the category
    const category = await BlogCategory.findById(categoryId);

    if (!category) {
      throw new Error('Blog category not found');
    }

    // Toggle featured status
    category.featured = !category.featured;

    // Save the updated category
    const updatedCategory = await category.save();

    return updatedCategory;
  } catch (error) {
    console.error('Error in toggleBlogCategoryFeaturedService:', error);
    throw error;
  }
};

module.exports = {
  getBlogCategoriesService,
  getBlogCategoryByIdService,
  getBlogCategoriesWithCountService,
  toggleBlogCategoryActiveService,
  toggleBlogCategoryFeaturedService
};
