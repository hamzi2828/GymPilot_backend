// blogCategoryController.js
const createBlogCategoryService = require('../services/blogCategories/createBlogCategoryService');
const updateBlogCategoryService = require('../services/blogCategories/updateBlogCategoryService');
const deleteBlogCategoryService = require('../services/blogCategories/deleteBlogCategoryService');
const {
  getBlogCategoriesService,
  getBlogCategoryByIdService,
  getBlogCategoriesWithCountService,
  toggleBlogCategoryActiveService
} = require('../services/blogCategories/getBlogCategoriesService');
const { toPublicPath } = require('../helper/upload');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');  
}

/**
 * Controller for blog category operations  
 */
const blogCategoryController = {
  /**
   * Get all blog categories
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  getAllCategories: async (req, res) => {
    try {
      const categories = await getBlogCategoriesService();
      return res.status(200).json({
        success: true,
        message: 'Blog categories retrieved successfully',
        data: categories
      });
    } catch (error) {
      console.error('Error in getAllCategories controller:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve blog categories',
        error: error.message
      });
    }
  },

  /**
   * Get blog categories with post counts
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  getCategoriesWithCount: async (req, res) => {
    try {
      const categories = await getBlogCategoriesWithCountService();
      return res.status(200).json({
        success: true,
        message: 'Blog categories with counts retrieved successfully',
        data: categories
      });
    } catch (error) {
      console.error('Error in getCategoriesWithCount controller:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve blog categories with counts',
        error: error.message
      });
    }
  },

  /**
   * Get a single blog category by ID
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  getCategoryById: async (req, res) => {
    try {
      const { id } = req.params;
      const category = await getBlogCategoryByIdService(id);
      
      return res.status(200).json({
        success: true,
        message: 'Blog category retrieved successfully',
        data: category
      });
    } catch (error) {
      console.error('Error in getCategoryById controller:', error);
      
      if (error.message === 'Blog category not found') {
        return res.status(404).json({
          success: false,
          message: 'Blog category not found',
          error: error.message
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve blog category',
        error: error.message
      });
    }
  },

  /**
   * Create a new blog category
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  createCategory: async (req, res) => {
    try {
      const categoryData = req.body;

      // Process uploaded files if any
      if (req.files) {
        if (USE_BLOB_STORAGE && blobUpload) {
          if (req.files.thumbnail && req.files.thumbnail[0]) {
            const file = req.files.thumbnail[0];
            categoryData.thumbnailUrl = await blobUpload.uploadToBlob(
              file.buffer, file.originalname, file.mimetype, 'blog-categories/thumbnails'
            );
          }
          if (req.files.banner && req.files.banner[0]) {
            const file = req.files.banner[0];
            categoryData.bannerUrl = await blobUpload.uploadToBlob(
              file.buffer, file.originalname, file.mimetype, 'blog-categories/banners'
            );
          }
        } else {
          if (req.files.thumbnail && req.files.thumbnail[0]) {
            categoryData.thumbnailUrl = toPublicPath(req.files.thumbnail[0].filename);
          }
          if (req.files.banner && req.files.banner[0]) {
            categoryData.bannerUrl = toPublicPath(req.files.banner[0].filename);
          }
        }
      }

      const newCategory = await createBlogCategoryService(categoryData);

      return res.status(201).json({
        success: true,
        message: 'Blog category created successfully',
        data: newCategory
      });
    } catch (error) {
      console.error('Error in createCategory controller:', error);

      if (error.message.includes('already exists')) {
        return res.status(409).json({
          success: false,
          message: 'Blog category with this slug already exists',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to create blog category',
        error: error.message
      });
    }
  },

  /**
   * Update an existing blog category
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  updateCategory: async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;

      // Process uploaded files if any
      if (req.files) {
        if (USE_BLOB_STORAGE && blobUpload) {
          if (req.files.thumbnail && req.files.thumbnail[0]) {
            const file = req.files.thumbnail[0];
            updateData.thumbnailUrl = await blobUpload.uploadToBlob(
              file.buffer, file.originalname, file.mimetype, 'blog-categories/thumbnails'
            );
          }
          if (req.files.banner && req.files.banner[0]) {
            const file = req.files.banner[0];
            updateData.bannerUrl = await blobUpload.uploadToBlob(
              file.buffer, file.originalname, file.mimetype, 'blog-categories/banners'
            );
          }
        } else {
          if (req.files.thumbnail && req.files.thumbnail[0]) {
            updateData.thumbnailUrl = toPublicPath(req.files.thumbnail[0].filename);
          }
          if (req.files.banner && req.files.banner[0]) {
            updateData.bannerUrl = toPublicPath(req.files.banner[0].filename);
          }
        }
      }

      const updatedCategory = await updateBlogCategoryService(id, updateData);

      return res.status(200).json({
        success: true,
        message: 'Blog category updated successfully',
        data: updatedCategory
      });
    } catch (error) {
      console.error('Error in updateCategory controller:', error);

      if (error.message === 'Blog category not found') {
        return res.status(404).json({
          success: false,
          message: 'Blog category not found',
          error: error.message
        });
      }

      if (error.message.includes('already exists')) {
        return res.status(409).json({
          success: false,
          message: 'Blog category with this slug already exists',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to update blog category',
        error: error.message
      });
    }
  },

  /**
   * Delete a blog category
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  deleteCategory: async (req, res) => {
    try {
      const { id } = req.params;
      const result = await deleteBlogCategoryService(id);
      
      return res.status(200).json({
        success: true,
        message: 'Blog category deleted successfully',
        data: result
      });
    } catch (error) {
      console.error('Error in deleteCategory controller:', error);
      
      if (error.message === 'Blog category not found') {
        return res.status(404).json({
          success: false,
          message: 'Blog category not found',
          error: error.message
        });
      }
      
      if (error.message.includes('Cannot delete category')) {
        return res.status(409).json({
          success: false,
          message: 'Cannot delete category as it is being used in blogs',
          error: error.message
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to delete blog category',
        error: error.message
      });
    }
  },

  /**
   * Toggle the active status of a blog category
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  toggleCategoryActive: async (req, res) => {
    try {
      const { id } = req.params;
      const updatedCategory = await toggleBlogCategoryActiveService(id);
      
      return res.status(200).json({
        success: true,
        message: `Blog category ${updatedCategory.active ? 'activated' : 'deactivated'} successfully`,
        data: updatedCategory
      });
    } catch (error) {
      console.error('Error in toggleCategoryActive controller:', error);
      
      if (error.message === 'Blog category not found') {
        return res.status(404).json({
          success: false,
          message: 'Blog category not found',
          error: error.message
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to toggle blog category active status',
        error: error.message
      });
    }
  },

  /**
   * Toggle the featured status of a blog category
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  toggleCategoryFeatured: async (req, res) => {
    try {
      const { id } = req.params;
      const { toggleBlogCategoryFeaturedService } = require('../services/blogCategories/getBlogCategoriesService');

      const updatedCategory = await toggleBlogCategoryFeaturedService(id);

      return res.status(200).json({
        success: true,
        message: `Blog category ${updatedCategory.featured ? 'marked as featured' : 'removed from featured'} successfully`,
        data: updatedCategory
      });
    } catch (error) {
      console.error('Error in toggleCategoryFeatured controller:', error);

      if (error.message === 'Blog category not found') {
        return res.status(404).json({
          success: false,
          message: 'Blog category not found',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to toggle blog category featured status',
        error: error.message
      });
    }
  }
};

module.exports = blogCategoryController;
