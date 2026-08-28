const Cart = require('../models/cartModel');
const Product = require('../models/product');

class CartService {
  /**
   * Find or create a cart for the user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Cart document
   */
  async findOrCreateCart(userId) {
    let cart = await Cart.findOne({ userId });
    if (!cart) {
      cart = new Cart({ userId, items: [] });
    }
    return cart;
  }

  /**
   * Get cart with populated product details and optimized variant data
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Cart with populated products
   */
  async getCartWithProducts(userId) {
    const cart = await Cart.findOne({ userId }).populate({
      path: 'items.productId',
      select: 'name price discountedPrice thumbnail thumbnailUrl stock category status productType colorMedia variants featured bannerUrls'
    });

    if (!cart) {
      return { userId, items: [], updatedAt: new Date() };
    }

    // Filter out items with deleted products
    cart.items = cart.items.filter(item => item.productId && item.productId.status === 'published');

    // Optimize response: only send specific variant and colorMedia for each cart item
    cart.items.forEach(item => {
      this.processCartItem(item);
    });

    return cart;
  }

  /**
   * Process individual cart item to add variant-specific data
   * @param {Object} item - Cart item
   */
  processCartItem(item) {
    console.log(`🔍 Product ID: ${item.productId._id}`);
    console.log(`🔍 Product colorMedia:`, JSON.stringify(item.productId.colorMedia, null, 2));
    console.log(`🔍 ColorMedia keys:`, Object.keys(item.productId.colorMedia || {}));
    console.log(`🔍 ColorMedia type:`, typeof item.productId.colorMedia);

    if (item.variant && item.variant.variantId && item.productId.variants) {
      // Find the specific variant for this cart item
      const productVariant = item.productId.variants.find(v => v.variantId === item.variant.variantId);

      if (productVariant) {
        console.log(`VariantId: "${item.variant.variantId}" has color: "${productVariant.color}"`);

        // Convert to plain object to allow modifications
        const productObj = item.productId.toObject();

        // Handle colorMedia properly - use the original colorMedia from the populated document
        let colorMediaObj = {};
        if (item.productId.colorMedia) {
          // Convert Mongoose Map to plain object
          if (item.productId.colorMedia instanceof Map || item.productId.colorMedia.get) {
            colorMediaObj = Object.fromEntries(item.productId.colorMedia);
          } else {
            colorMediaObj = item.productId.colorMedia;
          }
        }

        console.log(`🎨 Available colors:`, Object.keys(colorMediaObj));

        // Replace all variants with only the specific variant for this cart item
        productObj.variants = [productVariant];

        // Find and set only the specific colorMedia for this variant's color
        if (Object.keys(colorMediaObj).length > 0 && productVariant.color) {
          const specificColorMedia = this.findColorMedia(colorMediaObj, productVariant.color);

          if (specificColorMedia.media && specificColorMedia.key) {
            productObj.colorMedia = {
              [specificColorMedia.key]: specificColorMedia.media
            };
            // Also set the thumbnail URL for easy access
            item.variantThumbnailUrl = specificColorMedia.media.thumbnailUrl ||
                                       (specificColorMedia.media.bannerUrls && specificColorMedia.media.bannerUrls.length > 0 ?
                                        specificColorMedia.media.bannerUrls[0] : null);

            console.log(`Set variant thumbnail URL: ${item.variantThumbnailUrl}`);
          } else {
            // Clear colorMedia if no match found
            console.log(`No color media match found for ${productVariant.color}`);
            productObj.colorMedia = {};
          }
        }

        // Replace the productId with the modified object
        item.productId = productObj;
      } else {
        // Convert to plain object and clear variants if no match found
        const productObj = item.productId.toObject();
        productObj.variants = [];
        item.productId = productObj;
      }
    }
  }

  /**
   * Find color media for a specific color with case-insensitive matching
   * @param {Object} colorMediaObj - Color media object
   * @param {string} variantColor - Color to find
   * @returns {Object} { media, key } or { media: null, key: null }
   */
  findColorMedia(colorMediaObj, variantColor) {
    // Create variations of the color name to try different case formats
    const colorVariations = [
      variantColor,                                    // Original case
      variantColor.toLowerCase(),                      // lowercase
      variantColor.toUpperCase(),                      // UPPERCASE
      variantColor.charAt(0).toUpperCase() + variantColor.slice(1).toLowerCase(), // Title case
    ];

    // Try to find an exact match first
    for (const colorKey of colorVariations) {
      if (colorMediaObj[colorKey]) {
        console.log(`Found exact color match for ${variantColor}: ${colorKey}`);
        return {
          media: colorMediaObj[colorKey],
          key: colorKey
        };
      }
    }

    return { media: null, key: null };
  }

  /**
   * Add item to cart or update quantity if item exists
   * @param {string} userId - User ID
   * @param {string} productId - Product ID
   * @param {number} quantity - Quantity to add
   * @param {Object} variant - Variant details
   * @param {Object} customSizes - Custom sizes for customizable products
   * @param {boolean} isCustomized - Whether the product is customized
   * @returns {Promise<Object>} Updated cart
   */
  async addToCart(userId, productId, quantity = 1, variant = null, customSizes = null, isCustomized = false) {
    // Verify product exists
    const product = await Product.findById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    // Check stock availability
    if (product.stock < quantity) {
      throw new Error('Insufficient stock available');
    }

    // Find or create user's cart
    const cart = await this.findOrCreateCart(userId);

    // Check if item already exists in cart (use variantId for variant products)
    const existingItemIndex = cart.items.findIndex(item => {
      const isSameProduct = item.productId.toString() === productId;

      // For variant products, compare by variantId if available
      if (variant && variant.variantId && item.variant && item.variant.variantId) {
        return isSameProduct && item.variant.variantId === variant.variantId;
      }

      // Fallback to comparing full variant object for backward compatibility
      return isSameProduct && JSON.stringify(item.variant) === JSON.stringify(variant);
    });

    if (existingItemIndex >= 0 && !isCustomized) {
      // Update quantity if item exists (only for non-customized items)
      // Customized items are always added as new items since each customization is unique
      const newQuantity = cart.items[existingItemIndex].quantity + quantity;

      // Check total stock
      if (product.stock < newQuantity) {
        throw new Error('Cannot add more items. Insufficient stock available');
      }

      cart.items[existingItemIndex].quantity = newQuantity;
      cart.items[existingItemIndex].addedAt = new Date();
    } else {
      // Add new item (always add new for customized products)
      const newItem = {
        productId,
        quantity,
        variant,
        addedAt: new Date()
      };

      // Add custom sizes if provided
      if (isCustomized && customSizes) {
        newItem.customSizes = customSizes;
        newItem.isCustomized = true;
      }

      cart.items.push(newItem);
    }

    await cart.save();
    return cart;
  }

  /**
   * Update cart item quantity
   * @param {string} userId - User ID
   * @param {string} itemId - Cart item ID
   * @param {number} quantity - New quantity
   * @returns {Promise<Object>} Updated cart
   */
  async updateCartItem(userId, itemId, quantity) {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      throw new Error('Cart not found');
    }

    const item = cart.items.id(itemId);
    if (!item) {
      throw new Error('Item not found in cart');
    }

    if (quantity <= 0) {
      // Remove item if quantity is 0 or negative
      cart.items.pull(itemId);
    } else {
      // Verify stock availability
      const product = await Product.findById(item.productId);
      if (!product) {
        throw new Error('Product not found');
      }

      if (product.stock < quantity) {
        throw new Error('Insufficient stock available');
      }

      item.quantity = quantity;
      item.addedAt = new Date();
    }

    await cart.save();
    return cart;
  }

  /**
   * Remove item from cart
   * @param {string} userId - User ID
   * @param {string} itemId - Cart item ID
   * @returns {Promise<Object>} Updated cart
   */
  async removeFromCart(userId, itemId) {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      throw new Error('Cart not found');
    }

    cart.items.pull(itemId);
    await cart.save();
    return cart;
  }

  /**
   * Clear entire cart
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Empty cart
   */
  async clearCart(userId) {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return { userId, items: [], updatedAt: new Date() };
    }

    cart.items = [];
    await cart.save();
    return cart;
  }
}

module.exports = new CartService();