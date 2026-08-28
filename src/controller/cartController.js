const cartService = require('../services/cartService');

const cartController = {
  // Add item to cart
  async addToCart(req, res) {
    try {
      console.log('🛒 Backend: Add to cart request received');
      console.log('- Request body:', req.body);
      console.log('- User from auth middleware:', req.user);

      const { productId, quantity = 1, variant, customSizes, isCustomized } = req.body;
      const userId = req.user?.id;

      console.log('- Product ID:', productId);
      console.log('- User ID:', userId);
      console.log('- Quantity:', quantity);
      console.log('- Custom Sizes:', customSizes);
      console.log('- Is Customized:', isCustomized);

      if (!userId) {
        console.log('❌ Backend: User not authenticated');
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      if (!productId) {
        return res.status(400).json({
          success: false,
          error: 'Product ID is required'
        });
      }

      // Use cart service to add item (with custom sizes if provided)
      const cart = await cartService.addToCart(userId, productId, quantity, variant, customSizes, isCustomized);

      // Get cart with populated products and optimized variant data
      const populatedCart = await cartService.getCartWithProducts(userId);

      res.status(200).json({
        success: true,
        message: 'Item added to cart successfully',
        data: populatedCart
      });

    } catch (error) {
      console.error('Add to cart error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to add item to cart'
      });
    }
  },

  // Get user's cart
  async getCart(req, res) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      // Use cart service to get cart with optimized variant data
      const cart = await cartService.getCartWithProducts(userId);

      res.status(200).json({
        success: true,
        data: cart
      });

    } catch (error) {
      console.error('Get cart error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get cart'
      });
    }
  },

  // Update cart item quantity
  async updateCartItem(req, res) {
    try {
      const { itemId } = req.params;
      const { quantity } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      if (quantity === undefined || quantity < 0) {
        return res.status(400).json({
          success: false,
          error: 'Valid quantity is required'
        });
      }

      // Use cart service to update item
      await cartService.updateCartItem(userId, itemId, quantity);

      // Get updated cart with optimized variant data
      const cart = await cartService.getCartWithProducts(userId);

      res.status(200).json({
        success: true,
        message: 'Cart item updated successfully',
        data: cart
      });

    } catch (error) {
      console.error('Update cart item error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update cart item'
      });
    }
  },

  // Remove item from cart
  async removeFromCart(req, res) {
    try {
      const { itemId } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      // Use cart service to remove item
      await cartService.removeFromCart(userId, itemId);

      // Get updated cart with optimized variant data
      const cart = await cartService.getCartWithProducts(userId);

      res.status(200).json({
        success: true,
        message: 'Item removed from cart successfully',
        data: cart
      });

    } catch (error) {
      console.error('Remove from cart error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to remove item from cart'
      });
    }
  },

  // Clear entire cart
  async clearCart(req, res) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      // Use cart service to clear cart
      const cart = await cartService.clearCart(userId);

      res.status(200).json({
        success: true,
        message: 'Cart cleared successfully',
        data: cart
      });

    } catch (error) {
      console.error('Clear cart error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to clear cart'
      });
    }
  },

  // Merge guest cart with user's cart after login
  async mergeGuestCart(req, res) {
    try {
      console.log('🛒 Backend: Merge guest cart request received');
      console.log('- Request body:', req.body);
      console.log('- User from auth middleware:', req.user);

      const { guestCartItems } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        console.log('❌ Backend: User not authenticated');
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      if (!guestCartItems || !Array.isArray(guestCartItems) || guestCartItems.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'No items to merge',
          data: await cartService.getCartWithProducts(userId)
        });
      }

      console.log(`📦 Merging ${guestCartItems.length} guest cart items for user ${userId}`);

      // Add each guest cart item to the user's cart
      for (const item of guestCartItems) {
        try {
          await cartService.addToCart(
            userId,
            item.productId,
            item.quantity,
            item.variant || null,
            item.customSizes || null,
            item.isCustomized || false
          );
          console.log(`✅ Added product ${item.productId} to cart`);
        } catch (itemError) {
          console.error(`❌ Failed to add product ${item.productId}:`, itemError.message);
          // Continue with other items even if one fails
        }
      }

      // Get the merged cart
      const mergedCart = await cartService.getCartWithProducts(userId);

      res.status(200).json({
        success: true,
        message: `Merged ${guestCartItems.length} items into your cart`,
        data: mergedCart
      });

    } catch (error) {
      console.error('Merge guest cart error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to merge guest cart'
      });
    }
  }
};

module.exports = cartController;