// deleteBlogCategoryService.js
const path = require('path');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));
const mongoose = require('mongoose');

/**
 * Service for deleting a blog category
 * @param {String} categoryId - The ID of the blog category to delete
 * @returns {Promise<Object>} - Result of the deletion operation
 */
const deleteBlogCategoryService = async (categoryId) => {
  try {
    // Validate required fields
    if (!categoryId) {
      throw new Error('Blog category ID is required');
    }

    // Validate ID format
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw new Error('Invalid blog category ID format');
    }

    // Check if the category exists
    const category = await BlogCategory.findById(categoryId);
    if (!category) {
      throw new Error('Blog category not found');
    }

    // Check if the category is used in any blogs
    // This would require a Blog model, which we'll assume exists or will be created
    // If Blog model doesn't exist yet, this check can be added later
    if (mongoose.models.Blog) {
      const blogCount = await mongoose.models.Blog.countDocuments({ category: categoryId });
      if (blogCount > 0) {
        throw new Error(`Cannot delete category: it is used in ${blogCount} blog(s)`);
      }
    }

    // Delete the category
    const result = await BlogCategory.findByIdAndDelete(categoryId);
    
    return { success: true, message: 'Blog category deleted successfully', data: result };
  } catch (error) {
    console.error('Error in deleteBlogCategoryService:', error);
    throw error;
  }
};

module.exports = deleteBlogCategoryService;
