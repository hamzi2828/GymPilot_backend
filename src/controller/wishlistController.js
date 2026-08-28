const wishlistService = require('../services/wishlistService');

const wishlistController = {
  // Get user's wishlist
  getWishlist: async (req, res) => {
    try {
      const userId = req.user.id;
      console.log('📝 Getting wishlist for user:', userId);

      // Use wishlist service to get wishlist with optimized product data
      const wishlist = await wishlistService.getWishlistWithProducts(userId);

      res.status(200).json({
        success: true,
        message: wishlist.products.length > 0 ? 'Wishlist retrieved successfully' : 'Wishlist is empty',
        data: wishlist
      });
    } catch (error) {
      console.error('❌ Error getting wishlist:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get wishlist',
        error: error.message
      });
    }
  },

  // Add product to wishlist
  addToWishlist: async (req, res) => {
    try {
      const { productId } = req.body;
      const userId = req.user.id;

      console.log('❤️ Adding to wishlist:', { userId, productId });

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: 'Product ID is required'
        });
      }

      // Use wishlist service to add product
      await wishlistService.addToWishlist(userId, productId);

      // Get updated wishlist with populated products
      const wishlist = await wishlistService.getWishlistWithProducts(userId);

      console.log('✅ Product added to wishlist successfully');
      res.status(200).json({
        success: true,
        message: 'Product added to wishlist successfully',
        data: wishlist
      });
    } catch (error) {
      console.error('❌ Error adding to wishlist:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to add product to wishlist',
        error: error.message
      });
    }
  },

  // Remove product from wishlist
  removeFromWishlist: async (req, res) => {
    try {
      const { productId } = req.params;
      const userId = req.user.id;

      console.log('💔 Removing from wishlist:', { userId, productId });

      // Use wishlist service to remove product
      await wishlistService.removeFromWishlist(userId, productId);

      // Get updated wishlist with populated products
      const wishlist = await wishlistService.getWishlistWithProducts(userId);

      console.log('✅ Product removed from wishlist successfully');
      res.status(200).json({
        success: true,
        message: 'Product removed from wishlist successfully',
        data: wishlist
      });
    } catch (error) {
      console.error('❌ Error removing from wishlist:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to remove product from wishlist',
        error: error.message
      });
    }
  },

  // Clear entire wishlist
  clearWishlist: async (req, res) => {
    try {
      const userId = req.user.id;

      console.log('🗑️ Clearing wishlist for user:', userId);

      // Use wishlist service to clear wishlist
      const wishlist = await wishlistService.clearWishlist(userId);

      console.log('✅ Wishlist cleared successfully');
      res.status(200).json({
        success: true,
        message: 'Wishlist cleared successfully',
        data: wishlist
      });
    } catch (error) {
      console.error('❌ Error clearing wishlist:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to clear wishlist',
        error: error.message
      });
    }
  }
};

module.exports = wishlistController;