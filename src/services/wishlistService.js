const Wishlist = require('../models/wishlistModel');
const Product = require('../models/product');

class WishlistService {
  /**
   * Find or create a wishlist for the user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Wishlist document
   */
  async findOrCreateWishlist(userId) {
    let wishlist = await Wishlist.findOne({ userId });
    if (!wishlist) {
      wishlist = new Wishlist({ userId, products: [] });
    }
    return wishlist;
  }

  /**
   * Get wishlist with populated product details and optimized variant data
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Wishlist with populated products
   */
  async getWishlistWithProducts(userId) {
    const wishlist = await Wishlist.findOne({ userId })
      .populate({
        path: 'products.productId',
        select: 'name price discountedPrice thumbnail thumbnailUrl stock category status productType colorMedia variants featured bannerUrls'
      });

    if (!wishlist) {
      return { products: [] };
    }

    // Filter out items with deleted products
    const validProducts = wishlist.products.filter(item => item.productId && item.productId.status === 'published');

    // Process each wishlist item to optimize variant data (if needed in future)
    validProducts.forEach(item => {
      this.processWishlistItem(item);
    });

    return { products: validProducts };
  }

  /**
   * Process individual wishlist item (placeholder for future variant optimization)
   * @param {Object} item - Wishlist item
   */
  processWishlistItem(item) {
    // Currently wishlist doesn't store specific variants like cart
    // But this method is ready for future enhancements
    console.log(`📝 Processing wishlist item: ${item.productId.name}`);
  }

  /**
   * Add product to wishlist
   * @param {string} userId - User ID
   * @param {string} productId - Product ID
   * @returns {Promise<Object>} Updated wishlist
   */
  async addToWishlist(userId, productId) {
    // Validate product exists
    const product = await Product.findById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    // Find or create user's wishlist
    const wishlist = await this.findOrCreateWishlist(userId);

    // Check if product already in wishlist
    const existingProduct = wishlist.products.find(
      item => item.productId.toString() === productId
    );

    if (existingProduct) {
      throw new Error('Product already in wishlist');
    }

    // Add product to wishlist
    wishlist.products.push({
      productId,
      addedAt: new Date()
    });

    await wishlist.save();
    return wishlist;
  }

  /**
   * Remove product from wishlist
   * @param {string} userId - User ID
   * @param {string} productId - Product ID
   * @returns {Promise<Object>} Updated wishlist
   */
  async removeFromWishlist(userId, productId) {
    const wishlist = await Wishlist.findOne({ userId });

    if (!wishlist) {
      throw new Error('Wishlist not found');
    }

    // Find and remove the product
    const productIndex = wishlist.products.findIndex(
      item => item.productId.toString() === productId
    );

    if (productIndex === -1) {
      throw new Error('Product not found in wishlist');
    }

    wishlist.products.splice(productIndex, 1);
    await wishlist.save();
    return wishlist;
  }

  /**
   * Clear entire wishlist
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Empty wishlist response
   */
  async clearWishlist(userId) {
    await Wishlist.findOneAndDelete({ userId });
    return { products: [] };
  }

  /**
   * Check if product is in wishlist
   * @param {string} userId - User ID
   * @param {string} productId - Product ID
   * @returns {Promise<boolean>} True if product is in wishlist
   */
  async isProductInWishlist(userId, productId) {
    const wishlist = await Wishlist.findOne({ userId });

    if (!wishlist) {
      return false;
    }

    return wishlist.products.some(
      item => item.productId.toString() === productId
    );
  }

  /**
   * Get wishlist items count
   * @param {string} userId - User ID
   * @returns {Promise<number>} Number of items in wishlist
   */
  async getWishlistCount(userId) {
    const wishlist = await Wishlist.findOne({ userId });

    if (!wishlist) {
      return 0;
    }

    // Filter out any deleted products
    const validProducts = await Promise.all(
      wishlist.products.map(async (item) => {
        const product = await Product.findById(item.productId);
        return product && product.status === 'published' ? item : null;
      })
    );

    return validProducts.filter(item => item !== null).length;
  }
}

module.exports = new WishlistService();