// updateBlogCategoryService.js
const path = require('path');
const BlogCategory = require(path.resolve(__dirname, '../../models/BlogCategory'));

/**
 * Service for updating a blog category
 * @param {String} categoryId - The ID of the blog category to update
 * @param {Object} updateData - The updated blog category data
 * @returns {Promise<Object>} - The updated blog category
 */
const updateBlogCategoryService = async (categoryId, updateData) => {
  try {
    // Validate required fields
    if (!categoryId) {
      throw new Error('Blog category ID is required');
    }

    // Find the category
    const category = await BlogCategory.findById(categoryId);
    if (!category) {
      throw new Error('Blog category not found');
    }

    // If slug is being updated, check if it already exists
    if (updateData.slug && updateData.slug !== category.slug) {
      const existingCategory = await BlogCategory.findOne({ 
        slug: updateData.slug,
        _id: { $ne: categoryId } // Exclude current category
      });
      
      if (existingCategory) {
        throw new Error(`A blog category with slug "${updateData.slug}" already exists`);
      }
    }

    // Create slug from name if name is updated and slug is not provided
    if (updateData.name && !updateData.slug && updateData.name !== category.name) {
      updateData.slug = updateData.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    }

    // Update the blog category
    const updatedCategory = await BlogCategory.findByIdAndUpdate(
      categoryId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    return updatedCategory;
  } catch (error) {
    console.error('Error in updateBlogCategoryService:', error);
    throw error;
  }
};

module.exports = updateBlogCategoryService;
