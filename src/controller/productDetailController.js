// src/controller/productDetailController.js

const Product = require('../models/product');
const Category = require('../models/category');
const Guideline = require('../models/guideline');
const Measurement = require('../models/measurement');
const SizeGuide = require('../models/sizeGuide');
const mongoose = require('mongoose');

// Get product detail by slug (public endpoint - no auth required)
const getProductDetail = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOne({ slug, status: 'published', displayOn: { $ne: 'pos' } }).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Look up category to get shipping info and measurements
    let categoryShipping = null;
    let categoryMeasurements = [];
    let categoryId = null;
    // Use first category from categories array (or legacy category field for backward compatibility)
    const primaryCategory = product.categories?.[0] || product.category;
    if (primaryCategory) {
      const category = await Category.findOne({ name: primaryCategory })
        .populate({
          path: 'measurements',
          match: { active: true },
          options: { sort: { sortOrder: 1 } }
        })
        .lean();
      if (category) {
        categoryId = category._id;
        categoryShipping = {
          shippingCost: category.shippingCost || 0,
          estimatedDays: category.estimatedDays || ''
        };
        // Include category measurements
        categoryMeasurements = (category.measurements || []).map(m => ({
          id: m._id,
          name: m.name,
          slug: m.slug,
          unit: m.unit || 'inches',
          placeholder: m.placeholder || '',
          description: m.description || '',
          isRequired: m.isRequired || false,
          sortOrder: m.sortOrder || 0
        }));
      }
    }

    // Look up guideline to get imageUrl if guidelineId exists (legacy support)
    let guidelineImageUrl = null;
    if (product.guidelineId) {
      const guideline = await Guideline.findById(product.guidelineId).lean();
      if (guideline && guideline.active) {
        guidelineImageUrl = guideline.imageUrl;
      }
    }

    // Fetch all active guidelines if showGuidelines is enabled
    let guidelines = [];
    if (product.showGuidelines) {
      const activeGuidelines = await Guideline.find({ active: true }).sort({ type: 1, order: 1 }).lean();
      guidelines = activeGuidelines.map(g => ({
        id: g._id,
        name: g.name,
        slug: g.slug,
        type: g.type,
        imageUrl: g.imageUrl,
        images: g.images || []
      }));
    }

    // Look up predefined size guide if sizeGuideType is 'predefined' and sizeGuideId exists
    let sizeGuideImageUrl = null;
    if (product.sizeGuideType === 'predefined' && product.sizeGuideId) {
      const sizeGuide = await SizeGuide.findById(product.sizeGuideId).lean();
      if (sizeGuide && sizeGuide.active) {
        sizeGuideImageUrl = sizeGuide.imageUrl;
      }
    }

    // Fetch full related products data
    let relatedProductsData = [];
    if (product.relatedProducts && product.relatedProducts.length > 0) {
      const relatedProducts = await Product.find({
        _id: { $in: product.relatedProducts },
        status: 'published', displayOn: { $ne: 'pos' }
      })
        .select('_id name slug price discountedPrice thumbnailUrl colorMedia productType variants stock categories')
        .lean();

      // Transform related products for display
      relatedProductsData = relatedProducts.map(p => ({
        _id: p._id,
        name: p.name,
        slug: p.slug,
        price: p.price,
        discountedPrice: p.discountedPrice,
        thumbnailUrl: p.thumbnailUrl,
        colorMedia: p.colorMedia || {},
        productType: p.productType,
        variants: p.variants || [],
        stock: p.stock || 0,
        inStock: (p.stock || 0) > 0,
        categories: p.categories || []
      }));
    }

    // Transform the product data for frontend consumption
    const transformedProduct = {
      _id: product._id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      shortDescription: product.shortDescription,
      price: product.price,
      discountedPrice: product.discountedPrice,
      categories: product.categories || [],
      category: product.categories?.[0] || product.category || '', // Legacy support
      brand: product.brand,
      sku: product.sku,
      thumbnailUrl: product.thumbnailUrl,
      bannerUrls: product.bannerUrls || [],
      colorMedia: product.colorMedia || {},
      variants: product.variants || [],
      tags: product.tags || [],
      features: product.features || [],
      specifications: product.specifications || {},
      status: product.status,
      inStock: product.inStock,
      stockQuantity: product.stock || 0,
      weight: product.weight,
      dimensions: product.dimensions,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      // Preorder fields
      preorderEnabled: product.preorderEnabled || false,
      preorderMessage: product.preorderMessage || '',
      // Customization field
      customizesAllowed: product.customizesAllowed || false,
      guidelineId: product.guidelineId || null,
      guidelineImageUrl: guidelineImageUrl,
      // Guidelines
      showGuidelines: product.showGuidelines || false,
      guidelines: guidelines,
      // Category info
      categoryId: categoryId,
      categoryShipping,
      categoryMeasurements,
      // Size guide
      sizeGuideType: product.sizeGuideType || 'predefined',
      sizeGuideImageUrl: product.sizeGuideType === 'custom' ? product.customSizeGuideUrl : sizeGuideImageUrl,
      // Related products with full details
      relatedProducts: relatedProductsData
    };
    
    res.status(200).json({
      success: true,
      message: 'Product retrieved successfully',
      product: transformedProduct
    });
    
  } catch (error) {
    console.error('Error fetching product detail:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product details'
    });
  }
};

// Get related products - first from relatedProducts field, then fall back to category-based (public endpoint)
const getRelatedProducts = async (req, res) => {
  try {
    const { slug } = req.params;
    const limit = parseInt(req.query.limit) || 4;

    // Get the current product by slug to find related ones
    const currentProduct = await Product.findOne({ slug }).lean();

    if (!currentProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const productId = currentProduct._id.toString();
    let relatedProducts = [];

    // First, check if product has manually selected related products
    if (currentProduct.relatedProducts && currentProduct.relatedProducts.length > 0) {
      // Fetch the manually selected related products
      relatedProducts = await Product.find({
        _id: { $in: currentProduct.relatedProducts },
        status: 'published', displayOn: { $ne: 'pos' }
      })
        .select('_id name slug price discountedPrice thumbnailUrl categories brand stock colorMedia productType variants')
        .limit(limit)
        .lean();

      // Add computed fields
      relatedProducts = relatedProducts.map(product => ({
        ...product,
        inStock: product.stock > 0,
        stockQuantity: product.stock
      }));
    }

    // If no manual related products or not enough, fall back to category-based
    if (relatedProducts.length < limit) {
      const currentCategories = currentProduct.categories || [];
      const existingIds = relatedProducts.map(p => p._id.toString());
      existingIds.push(productId); // Also exclude current product

      const remainingLimit = limit - relatedProducts.length;

      const categoryRelatedQuery = {
        _id: { $nin: existingIds.map(id => new mongoose.Types.ObjectId(id)) },
        status: 'published', displayOn: { $ne: 'pos' },
        $or: [
          { categories: { $elemMatch: { $in: currentCategories } } },
          { tags: { $in: currentProduct.tags || [] } }
        ]
      };

      const categoryRelated = await Product.find(categoryRelatedQuery)
        .select('_id name slug price discountedPrice thumbnailUrl categories brand stock colorMedia productType variants')
        .limit(remainingLimit)
        .lean();

      // Add computed fields and combine
      const categoryRelatedWithStock = categoryRelated.map(product => ({
        ...product,
        inStock: product.stock > 0,
        stockQuantity: product.stock
      }));

      relatedProducts = [...relatedProducts, ...categoryRelatedWithStock];
    }

    res.status(200).json({
      success: true,
      message: 'Related products retrieved successfully',
      products: relatedProducts,
      total: relatedProducts.length
    });

  } catch (error) {
    console.error('Error fetching related products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch related products'
    });
  }
};

// Get products by category (public endpoint)
const getProductsByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const limit = parseInt(req.query.limit) || 8;
    const excludeId = req.query.exclude;
    
    // Handle slug format - convert dashes to spaces and title case
    const categoryName = category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    const query = {
      categories: { $elemMatch: { $regex: new RegExp(category, 'i') } }, // Case-insensitive match in categories array
      status: 'published', displayOn: { $ne: 'pos' }
    };
    
    if (excludeId && mongoose.Types.ObjectId.isValid(excludeId)) {
      query._id = { $ne: excludeId };
    }
    
    const products = await Product.find(query)
      .select('_id name slug price discountedPrice thumbnailUrl categories brand stock featured colorMedia productType variants')
      .limit(limit)
      .sort({ createdAt: -1 })
      .lean();
    
    // Add inStock computed field for frontend compatibility
    const productsWithStock = products.map(product => ({
      ...product,
      inStock: product.stock > 0,
      stockQuantity: product.stock
    }));
    
    const total = await Product.countDocuments(query);
    
    res.status(200).json({
      success: true,
      message: 'Category products retrieved successfully',
      products: productsWithStock,
      total
    });
    
  } catch (error) {
    console.error('Error fetching category products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products'
    });
  }
};

// Search products with filters (public endpoint)
const searchProducts = async (req, res) => {
  try {
    const {
      q = '',
      category,
      minPrice,
      maxPrice,
      brand,
      inStock,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 12
    } = req.query;
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    
    // Build search query
    const query = {
      status: 'published', displayOn: { $ne: 'pos' }
    };
    
    // Text search
    if (q && q.trim()) {
      query.$text = { $search: q.trim() };
    }
    
    // Category filter (searches in categories array)
    if (category) {
      query.categories = { $elemMatch: { $regex: new RegExp(category, 'i') } };
    }
    
    // Price range filter
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = parseFloat(minPrice);
      if (maxPrice) query.price.$lte = parseFloat(maxPrice);
    }
    
    // Brand filter
    if (brand) {
      query.brand = { $regex: new RegExp(brand, 'i') };
    }
    
    // Stock filter
    if (inStock !== undefined) {
      query.inStock = inStock === 'true';
    }
    
    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;
    
    // Execute search
    const products = await Product.find(query)
      .select('_id name slug price discountedPrice thumbnailUrl categories brand inStock stockQuantity tags')
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum)
      .lean();
    
    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / limitNum);
    
    res.status(200).json({
      success: true,
      message: 'Products retrieved successfully',
      products,
      total,
      totalPages,
      currentPage: pageNum,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1
    });
    
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search products'
    });
  }
};

// Get featured/popular products (public endpoint) - OPTIMIZED
const getFeaturedProducts = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;

    // Use aggregation for optimized response with computed fields
    const featuredProducts = await Product.aggregate([
      {
        $match: {
          status: 'published', displayOn: { $ne: 'pos' },
          featured: true,
          stock: { $gt: 0 }
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
      {
        $addFields: {
          // Get thumbnail from colorMedia if available, otherwise use thumbnailUrl
          thumbnail: {
            $cond: {
              if: { $and: [{ $ne: ['$colorMedia', null] }, { $gt: [{ $size: { $objectToArray: { $ifNull: ['$colorMedia', {}] } } }, 0] }] },
              then: {
                $let: {
                  vars: { firstColor: { $arrayElemAt: [{ $objectToArray: { $ifNull: ['$colorMedia', {}] } }, 0] } },
                  in: '$$firstColor.v.thumbnailUrl'
                }
              },
              else: '$thumbnailUrl'
            }
          },
          // Get sale price from product or first variant
          salePrice: {
            $cond: {
              if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }] },
              then: '$discountedPrice',
              else: {
                $cond: {
                  if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                  then: {
                    $let: {
                      vars: { firstVariant: { $arrayElemAt: [{ $ifNull: ['$variants', []] }, 0] } },
                      in: {
                        $cond: {
                          if: { $and: [{ $ne: ['$$firstVariant.discountedPrice', null] }, { $gt: ['$$firstVariant.discountedPrice', 0] }] },
                          then: '$$firstVariant.discountedPrice',
                          else: null
                        }
                      }
                    }
                  },
                  else: null
                }
              }
            }
          },
          // Calculate if on sale
          isOnSale: {
            $cond: {
              if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }, { $lt: ['$discountedPrice', '$price'] }] },
              then: true,
              else: {
                $cond: {
                  if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                  then: {
                    $anyElementTrue: {
                      $map: {
                        input: { $ifNull: ['$variants', []] },
                        as: 'v',
                        in: { $and: [{ $ne: ['$$v.discountedPrice', null] }, { $gt: ['$$v.discountedPrice', 0] }, { $lt: ['$$v.discountedPrice', '$$v.price'] }] }
                      }
                    }
                  },
                  else: false
                }
              }
            }
          },
          // Calculate discount percentage
          discountPercentage: {
            $cond: {
              if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }, { $lt: ['$discountedPrice', '$price'] }] },
              then: { $round: [{ $multiply: [{ $divide: [{ $subtract: ['$price', '$discountedPrice'] }, '$price'] }, 100] }, 0] },
              else: {
                $cond: {
                  if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                  then: {
                    $let: {
                      vars: { firstVariant: { $arrayElemAt: [{ $ifNull: ['$variants', []] }, 0] } },
                      in: {
                        $cond: {
                          if: { $and: [{ $ne: ['$$firstVariant.discountedPrice', null] }, { $gt: ['$$firstVariant.discountedPrice', 0] }, { $lt: ['$$firstVariant.discountedPrice', '$$firstVariant.price'] }] },
                          then: { $round: [{ $multiply: [{ $divide: [{ $subtract: ['$$firstVariant.price', '$$firstVariant.discountedPrice'] }, '$$firstVariant.price'] }, 100] }, 0] },
                          else: 0
                        }
                      }
                    }
                  },
                  else: 0
                }
              }
            }
          },
          inStock: { $gt: ['$stock', 0] }
        }
      },
      {
        $project: {
          _id: 1,
          name: 1,
          slug: 1,
          price: 1,
          salePrice: 1,
          isOnSale: 1,
          discountPercentage: 1,
          thumbnail: 1,
          inStock: 1,
          stock: 1
        }
      }
    ]);

    res.status(200).json({
      success: true,
      message: 'Featured products retrieved successfully',
      products: featuredProducts,
      total: featuredProducts.length
    });

  } catch (error) {
    console.error('Error fetching featured products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch featured products'
    });
  }
};

// Get products with highest ratings (public endpoint)
const getTopRatedProducts = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;
    
    // For now, we'll sort by a combination of factors
    // In future, you can integrate with a reviews system
    const products = await Product.find({
      status: 'published', displayOn: { $ne: 'pos' },
      inStock: true
    })
      .select('_id name slug price discountedPrice thumbnailUrl categories brand inStock stockQuantity')
      .sort({ stockQuantity: -1, createdAt: -1 }) // Sort by stock and recency for now
      .limit(limit)
      .lean();
    
    res.status(200).json({
      success: true,
      message: 'Top rated products retrieved successfully',
      products,
      total: products.length
    });
    
  } catch (error) {
    console.error('Error fetching top rated products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch top rated products'
    });
  }
};

// Get recent purchases for a product (for social proof notifications)
const getRecentPurchases = async (req, res) => {
  try {
    const { slug } = req.params;
    const limit = parseInt(req.query.limit) || 5;

    const product = await Product.findOne({ slug }).select('_id').lean();
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    const productId = product._id;

    const Order = require('../models/order');

    // Find recent orders containing this product
    const recentOrders = await Order.find({
      'items.product': productId,
      orderStatus: { $in: ['submitted', 'processing', 'shipped', 'completed'] },
      paymentStatus: { $in: ['completed', 'processing'] }
    })
      .select('shippingAddress.city shippingAddress.fullName createdAt items')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Transform to only show necessary info (privacy-safe)
    const purchases = recentOrders.map(order => {
      // Get first name only for privacy
      const fullName = order.shippingAddress?.fullName || '';
      const firstName = fullName.split(' ')[0] || 'Someone';
      // Mask name: show first 2 chars + ***
      const maskedName = firstName.length > 2
        ? firstName.substring(0, 2) + '***'
        : firstName + '***';

      return {
        city: order.shippingAddress?.city || 'Pakistan',
        name: maskedName,
        timeAgo: getTimeAgo(order.createdAt)
      };
    });

    res.status(200).json({
      success: true,
      purchases,
      total: purchases.length
    });

  } catch (error) {
    console.error('Error fetching recent purchases:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent purchases'
    });
  }
};

// Helper function to get human-readable time ago
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return 'recently';
}

// Get product categories with count (public endpoint)
const getProductCategories = async (req, res) => {
  try {
    const categories = await Product.aggregate([
      {
        $match: { status: 'published', displayOn: { $ne: 'pos' } }
      },
      {
        $unwind: '$categories' // Unwind the categories array
      },
      {
        $group: {
          _id: '$categories',
          count: { $sum: 1 },
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' },
          sampleImage: { $first: '$thumbnailUrl' }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    res.status(200).json({
      success: true,
      message: 'Product categories retrieved successfully',
      categories: categories.map(cat => ({
        name: cat._id,
        count: cat.count,
        priceRange: {
          min: cat.minPrice,
          max: cat.maxPrice
        },
        image: cat.sampleImage
      }))
    });
    
  } catch (error) {
    console.error('Error fetching product categories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product categories'
    });
  }
};

module.exports = {
  getProductDetail,
  getRelatedProducts,
  getProductsByCategory,
  searchProducts,
  getFeaturedProducts,
  getTopRatedProducts,
  getProductCategories,
  getRecentPurchases
};