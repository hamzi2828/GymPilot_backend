const publicProductService = require('../services/publicProductService');

const publicProductController = {
  // Optimized "Shop Latest Products" endpoint - returns minimal data for product cards
  async getShopLatestProducts(req, res) {
    try {
      const { limit = 10 } = req.query;
      const result = await publicProductService.getShopLatestProducts(limit);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  // Optimized "Shop Sale Products" endpoint
  async getShopSaleProducts(req, res) {
    try {
      const { limit = 10 } = req.query;
      const result = await publicProductService.getShopSaleProducts(limit);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  async getLatestProducts(req, res) {
    try {
      const { limit = 10 } = req.query;
      const result = await publicProductService.getLatestProducts(limit);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  async getRandomProducts(req, res) {
    try {
      const { limit = 10 } = req.query;
      const result = await publicProductService.getRandomProducts(limit);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  async getProductBySlug(req, res) {
    try {
      const { slug } = req.params;
      const result = await publicProductService.getProductBySlug(slug);
      res.status(200).json(result);
    } catch (error) {
      res.status(error.message.includes('not found') ? 404 : 500).json({
        success: false,
        error: error.message
      });
    }
  },

  async getProductsByCategory(req, res) {
    try {
      const { category } = req.params;
      const { limit = 20, page = 1, sortBy = 'price', sortOrder = 'asc' } = req.query;
      const result = await publicProductService.getProductsByCategory(category, limit, page, sortBy, sortOrder);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  async getFeaturedProducts(req, res) {
    try {
      const { limit = 10 } = req.query;
      const result = await publicProductService.getFeaturedProducts(limit);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  async searchProducts(req, res) {
    try {
      const { q, limit = 20, page = 1 } = req.query;
      
      if (!q || q.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Search query is required'
        });
      }
      
      const result = await publicProductService.searchProducts(q, limit, page);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  async getSaleProducts(req, res) {
    try {
      const {
        limit = 50,
        page = 1,
        sortBy = 'price',
        sortOrder = 'asc'
      } = req.query;

      const result = await publicProductService.getSaleProducts(
        limit,
        page,
        sortBy,
        sortOrder
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  async getAllPublishedProducts(req, res) {
    try {
      const { 
        limit = 50, 
        page = 1, 
        sortBy = 'createdAt', 
        sortOrder = 'desc' 
      } = req.query;
      
      const result = await publicProductService.getAllPublishedProducts(
        limit, 
        page, 
        sortBy, 
        sortOrder
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
};

module.exports = publicProductController;