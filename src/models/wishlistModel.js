const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  products: [{
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Ensure one wishlist per user
wishlistSchema.index({ userId: 1 }, { unique: true });

// Ensure unique products in wishlist
wishlistSchema.index({ userId: 1, 'products.productId': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Wishlist', wishlistSchema);