// src/services/blogs/index.js
const createBlogService = require('./createBlogService');
const updateBlogService = require('./updateBlogService');
const getAllBlogsService = require('./getAllBlogsService');
const getBlogByIdService = require('./getBlogByIdService');
const { deleteBlogService, deleteBulkBlogsService } = require('./deleteBlogService');
const { 
  incrementViewsService, 
  bulkIncrementViewsService, 
  getViewStatisticsService 
} = require('./incrementViewsService');
const {
  getBlogsByCategoryService,
  getBlogCountByCategoriesService,
  getTrendingBlogsByCategoryService
} = require('./getBlogsByCategoryService');

module.exports = {
  // Create and Update
  createBlogService,
  updateBlogService,
  
  // Read
  getAllBlogsService,
  getBlogByIdService,
  getBlogsByCategoryService,
  getBlogCountByCategoriesService,
  getTrendingBlogsByCategoryService,
  
  // Delete
  deleteBlogService,
  deleteBulkBlogsService,
  
  // Views
  incrementViewsService,
  bulkIncrementViewsService,
  getViewStatisticsService
};