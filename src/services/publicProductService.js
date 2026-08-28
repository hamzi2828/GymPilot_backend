const Product = require('../models/product');

const publicProductService = {
  // Optimized "Shop Latest Products" - returns only essential fields for product cards
  async getShopLatestProducts(limit = 10) {
    try {
      const products = await Product.aggregate([
        { $match: { status: 'published', displayOn: { $ne: 'pos' } } },
        { $sort: { createdAt: -1 } },
        { $limit: parseInt(limit) },
        {
          $addFields: {
            // Get thumbnail from colorMedia if available, otherwise use thumbnailUrl
            thumbnail: {
              $cond: {
                if: { $and: [{ $ne: ['$colorMedia', null] }, { $gt: [{ $size: { $objectToArray: { $ifNull: ['$colorMedia', {}] } } }, 0] }] },
                then: {
                  $let: {
                    vars: {
                      firstColor: { $arrayElemAt: [{ $objectToArray: { $ifNull: ['$colorMedia', {}] } }, 0] }
                    },
                    in: '$$firstColor.v.thumbnailUrl'
                  }
                },
                else: '$thumbnailUrl'
              }
            },
            // Calculate if product is on sale
            isOnSale: {
              $cond: {
                if: {
                  $and: [
                    { $ne: ['$discountedPrice', null] },
                    { $gt: ['$discountedPrice', 0] },
                    { $lt: ['$discountedPrice', '$price'] }
                  ]
                },
                then: true,
                else: {
                  // Check if any variant has a discounted price
                  $cond: {
                    if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                    then: {
                      $anyElementTrue: {
                        $map: {
                          input: { $ifNull: ['$variants', []] },
                          as: 'v',
                          in: {
                            $and: [
                              { $ne: ['$$v.discountedPrice', null] },
                              { $gt: ['$$v.discountedPrice', 0] },
                              { $lt: ['$$v.discountedPrice', '$$v.price'] }
                            ]
                          }
                        }
                      }
                    },
                    else: false
                  }
                }
              }
            },
            // Get discounted price (from product or first variant)
            salePrice: {
              $cond: {
                if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }] },
                then: '$discountedPrice',
                else: {
                  // For variant products, get the first variant's discounted price
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
            // Get effective price (discounted or regular)
            effectivePrice: {
              $cond: {
                if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }] },
                then: '$discountedPrice',
                else: {
                  // For variant products, get the lowest variant price
                  $cond: {
                    if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                    then: {
                      $min: {
                        $map: {
                          input: { $ifNull: ['$variants', []] },
                          as: 'v',
                          in: {
                            $cond: {
                              if: { $and: [{ $ne: ['$$v.discountedPrice', null] }, { $gt: ['$$v.discountedPrice', 0] }] },
                              then: '$$v.discountedPrice',
                              else: '$$v.price'
                            }
                          }
                        }
                      }
                    },
                    else: '$price'
                  }
                }
              }
            },
            // Calculate discount percentage
            discountPercentage: {
              $cond: {
                if: {
                  $and: [
                    { $ne: ['$discountedPrice', null] },
                    { $gt: ['$discountedPrice', 0] },
                    { $lt: ['$discountedPrice', '$price'] }
                  ]
                },
                then: {
                  $round: [
                    { $multiply: [{ $divide: [{ $subtract: ['$price', '$discountedPrice'] }, '$price'] }, 100] },
                    0
                  ]
                },
                else: {
                  // Check first variant for discount
                  $cond: {
                    if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                    then: {
                      $let: {
                        vars: { firstVariant: { $arrayElemAt: [{ $ifNull: ['$variants', []] }, 0] } },
                        in: {
                          $cond: {
                            if: {
                              $and: [
                                { $ne: ['$$firstVariant.discountedPrice', null] },
                                { $gt: ['$$firstVariant.discountedPrice', 0] },
                                { $lt: ['$$firstVariant.discountedPrice', '$$firstVariant.price'] }
                              ]
                            },
                            then: {
                              $round: [
                                { $multiply: [{ $divide: [{ $subtract: ['$$firstVariant.price', '$$firstVariant.discountedPrice'] }, '$$firstVariant.price'] }, 100] },
                                0
                              ]
                            },
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
            // Check if in stock
            inStock: { $gt: ['$stock', 0] },
            // Get available colors for variant products
            availableColors: {
              $cond: {
                if: { $eq: ['$productType', 'variant'] },
                then: {
                  $reduce: {
                    input: { $ifNull: ['$variants', []] },
                    initialValue: [],
                    in: {
                      $cond: {
                        if: { $in: ['$$this.color', '$$value'] },
                        then: '$$value',
                        else: { $concatArrays: ['$$value', ['$$this.color']] }
                      }
                    }
                  }
                },
                else: []
              }
            }
          }
        },
        {
          $project: {
            _id: 1,
            name: 1,
            slug: 1,
            price: 1,
            salePrice: 1,
            effectivePrice: 1,
            isOnSale: 1,
            discountPercentage: 1,
            thumbnail: 1,
            inStock: 1,
            productType: 1,
            availableColors: 1,
            shortDescription: 1
          }
        }
      ]);

      return {
        success: true,
        data: products,
        count: products.length
      };
    } catch (error) {
      throw new Error(`Failed to fetch shop latest products: ${error.message}`);
    }
  },

  // Optimized "Shop Sale Products" - returns only essential fields
  async getShopSaleProducts(limit = 10) {
    try {
      const products = await Product.aggregate([
        {
          $match: {
            status: 'published', displayOn: { $ne: 'pos' },
            $or: [
              // Product-level discount
              {
                discountedPrice: { $exists: true, $ne: null, $gt: 0 },
                $expr: { $lt: ['$discountedPrice', '$price'] }
              },
              // Variant-level discount
              {
                'variants.discountedPrice': { $exists: true, $ne: null, $gt: 0 }
              }
            ]
          }
        },
        { $sort: { createdAt: -1 } },
        { $limit: parseInt(limit) },
        {
          $addFields: {
            thumbnail: {
              $cond: {
                if: { $and: [{ $ne: ['$colorMedia', null] }, { $gt: [{ $size: { $objectToArray: { $ifNull: ['$colorMedia', {}] } } }, 0] }] },
                then: {
                  $let: {
                    vars: {
                      firstColor: { $arrayElemAt: [{ $objectToArray: { $ifNull: ['$colorMedia', {}] } }, 0] }
                    },
                    in: '$$firstColor.v.thumbnailUrl'
                  }
                },
                else: '$thumbnailUrl'
              }
            },
            isOnSale: { $literal: true },
            // Get discounted price (from product or first variant)
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
            effectivePrice: {
              $cond: {
                if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }] },
                then: '$discountedPrice',
                else: {
                  $cond: {
                    if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                    then: {
                      $min: {
                        $map: {
                          input: { $ifNull: ['$variants', []] },
                          as: 'v',
                          in: {
                            $cond: {
                              if: { $and: [{ $ne: ['$$v.discountedPrice', null] }, { $gt: ['$$v.discountedPrice', 0] }] },
                              then: '$$v.discountedPrice',
                              else: '$$v.price'
                            }
                          }
                        }
                      }
                    },
                    else: '$price'
                  }
                }
              }
            },
            discountPercentage: {
              $cond: {
                if: {
                  $and: [
                    { $ne: ['$discountedPrice', null] },
                    { $gt: ['$discountedPrice', 0] },
                    { $lt: ['$discountedPrice', '$price'] }
                  ]
                },
                then: {
                  $round: [
                    { $multiply: [{ $divide: [{ $subtract: ['$price', '$discountedPrice'] }, '$price'] }, 100] },
                    0
                  ]
                },
                else: {
                  $cond: {
                    if: { $gt: [{ $size: { $ifNull: ['$variants', []] } }, 0] },
                    then: {
                      $let: {
                        vars: { firstVariant: { $arrayElemAt: [{ $ifNull: ['$variants', []] }, 0] } },
                        in: {
                          $cond: {
                            if: {
                              $and: [
                                { $ne: ['$$firstVariant.discountedPrice', null] },
                                { $gt: ['$$firstVariant.discountedPrice', 0] },
                                { $lt: ['$$firstVariant.discountedPrice', '$$firstVariant.price'] }
                              ]
                            },
                            then: {
                              $round: [
                                { $multiply: [{ $divide: [{ $subtract: ['$$firstVariant.price', '$$firstVariant.discountedPrice'] }, '$$firstVariant.price'] }, 100] },
                                0
                              ]
                            },
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
            inStock: { $gt: ['$stock', 0] },
            availableColors: {
              $cond: {
                if: { $eq: ['$productType', 'variant'] },
                then: {
                  $reduce: {
                    input: { $ifNull: ['$variants', []] },
                    initialValue: [],
                    in: {
                      $cond: {
                        if: { $in: ['$$this.color', '$$value'] },
                        then: '$$value',
                        else: { $concatArrays: ['$$value', ['$$this.color']] }
                      }
                    }
                  }
                },
                else: []
              }
            }
          }
        },
        {
          $project: {
            _id: 1,
            name: 1,
            slug: 1,
            price: 1,
            salePrice: 1,
            effectivePrice: 1,
            isOnSale: 1,
            discountPercentage: 1,
            thumbnail: 1,
            inStock: 1,
            productType: 1,
            availableColors: 1,
            shortDescription: 1
          }
        }
      ]);

      return {
        success: true,
        data: products,
        count: products.length
      };
    } catch (error) {
      throw new Error(`Failed to fetch shop sale products: ${error.message}`);
    }
  },

  async getLatestProducts(limit = 10) {
    try {
      const products = await Product.find({ status: 'published', displayOn: { $ne: 'pos' } })
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .select('-__v');
      
      return {
        success: true,
        data: products,
        count: products.length
      };
    } catch (error) {
      throw new Error(`Failed to fetch latest products: ${error.message}`);
    }
  },

  async getRandomProducts(limit = 10) {
    try {
      const products = await Product.aggregate([
        { $match: { status: 'published', displayOn: { $ne: 'pos' } } },
        { $sample: { size: parseInt(limit) } }
      ]);
      
      return {
        success: true,
        data: products,
        count: products.length
      };
    } catch (error) {
      throw new Error(`Failed to fetch random products: ${error.message}`);
    }
  },

  async getProductBySlug(slug) {
    try {
      const product = await Product.findOne({
        slug,
        status: 'published', displayOn: { $ne: 'pos' }
      }).select('-__v');

      if (!product) {
        throw new Error('Product not found or not published');
      }

      return {
        success: true,
        data: product
      };
    } catch (error) {
      throw new Error(`Failed to fetch product: ${error.message}`);
    }
  },

  async getProductsByCategory(category, limit = 20, page = 1, sortBy = 'price', sortOrder = 'asc') {
    try {
      const skip = (page - 1) * limit;

      // Handle slug format - convert dashes to spaces and title case
      const categoryName = category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      // Also try with apostrophe (e.g., "womens-collection" -> "Women's Collection")
      const categoryNameWithApostrophe = categoryName.replace(/(\w)s\s/g, "$1's ");

      // Also try with & symbol (e.g., "modset-accessories" -> "Modset & Accessories")
      const categoryNameWithAnd = categoryName.replace(/\s+/g, ' & ');

      // Create a flexible regex pattern that matches the slug parts.
      // Handle cases like "womens" matching "Women's" by making apostrophe and 's' optional.
      // CRITICAL: anchor each part at a word boundary (\b) so "mens" doesn't match
      // the "men" inside "women" — that bug was leaking Women's Collection items
      // into Men's Collection results (April 2026).
      const slugParts = category.split('-').filter(Boolean);
      // For each part, if it ends in 's', also match version without 's' or with apostrophe
      const flexiblePattern = slugParts.map(part => {
        // Remove trailing 's' for matching (womens -> women, then match women's or womens)
        const basePart = part.endsWith('s') ? part.slice(0, -1) : part;
        // Match the base word at a word boundary, optionally followed by apostrophe and/or 's'
        return `(?=.*\\b${basePart}['']?s?\\b)`;
      }).join('');

      // Query searches in categories array - matches any category path that contains the search term
      const categoryQuery = {
        $or: [
          { categories: { $elemMatch: { $regex: new RegExp(`^${category}$`, 'i') } } },
          { categories: { $elemMatch: { $regex: new RegExp(`^${categoryName}$`, 'i') } } },
          { categories: { $elemMatch: { $regex: new RegExp(`^${categoryNameWithApostrophe}$`, 'i') } } },
          { categories: { $elemMatch: { $regex: new RegExp(`^${categoryNameWithAnd}$`, 'i') } } },
          { categories: { $elemMatch: { $regex: new RegExp(flexiblePattern, 'i') } } },
          { categories: { $elemMatch: { $regex: new RegExp(`^${categoryName}( >|$)`, 'i') } } },
          { categories: { $elemMatch: { $regex: new RegExp(`^${categoryNameWithApostrophe}( >|$)`, 'i') } } }, // Match with apostrophe at start of path
          { categories: { $elemMatch: { $regex: new RegExp(`> ${categoryName}( >|$)`, 'i') } } },
          { categories: { $elemMatch: { $regex: new RegExp(`> ${categoryNameWithApostrophe}( >|$)`, 'i') } } } // Match with apostrophe in middle/end of path
        ],
        status: 'published', displayOn: { $ne: 'pos' }
      };

      let products;

      // For price sorting, use aggregation to sort by effective price (discountedPrice or price)
      if (sortBy === 'price') {
        products = await Product.aggregate([
          { $match: categoryQuery },
          {
            $addFields: {
              effectivePrice: {
                $cond: {
                  if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }] },
                  then: '$discountedPrice',
                  else: '$price'
                }
              }
            }
          },
          { $sort: { effectivePrice: sortOrder === 'asc' ? 1 : -1 } },
          { $skip: skip },
          { $limit: parseInt(limit) },
          { $project: { effectivePrice: 0 } }
        ]);
      } else {
        // For other sorts (name, etc.), use regular find
        const sortOptions = {};
        sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

        products = await Product.find(categoryQuery)
          .sort(sortOptions)
          .limit(parseInt(limit))
          .skip(skip)
          .select('-__v');
      }
      
      const total = await Product.countDocuments(categoryQuery);
      
      return {
        success: true,
        data: products,
        count: products.length,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      throw new Error(`Failed to fetch products by category: ${error.message}`);
    }
  },

  async getFeaturedProducts(limit = 10) {
    try {
      const products = await Product.find({ 
        status: 'published', displayOn: { $ne: 'pos' },
        isFeatured: true 
      })
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .select('-__v');
      
      return {
        success: true,
        data: products,
        count: products.length
      };
    } catch (error) {
      throw new Error(`Failed to fetch featured products: ${error.message}`);
    }
  },

  async searchProducts(query, limit = 20, page = 1) {
    try {
      const skip = (page - 1) * limit;
      const searchRegex = new RegExp(query, 'i');
      
      const searchCriteria = {
        status: 'published', displayOn: { $ne: 'pos' },
        $or: [
          { name: searchRegex },
          { description: searchRegex },
          { category: searchRegex }
        ]
      };
      
      const products = await Product.find(searchCriteria)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(skip)
        .select('-__v');
      
      const total = await Product.countDocuments(searchCriteria);
      
      return {
        success: true,
        data: products,
        count: products.length,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      throw new Error(`Failed to search products: ${error.message}`);
    }
  },

  async getSaleProducts(limit = 50, page = 1, sortBy = 'price', sortOrder = 'asc') {
    try {
      const skip = (page - 1) * limit;

      // Products on sale: product-level discount, variant-level discount, or "Sale" category
      const saleQuery = {
        status: 'published', displayOn: { $ne: 'pos' },
        $or: [
          // Product-level discount
          {
            discountedPrice: { $exists: true, $ne: null, $gt: 0 },
            $expr: { $lt: ['$discountedPrice', '$price'] }
          },
          // Variant-level discount
          {
            'variants.discountedPrice': { $exists: true, $gt: 0 }
          },
          // "Sale" category
          {
            categories: 'Sale'
          }
        ]
      };

      let products;

      // Use aggregation for all queries to handle $or with $expr properly
      const matchStage = {
        $match: {
          status: 'published', displayOn: { $ne: 'pos' },
          $or: [
            {
              discountedPrice: { $exists: true, $ne: null, $gt: 0 },
              $expr: { $lt: ['$discountedPrice', '$price'] }
            },
            {
              'variants.discountedPrice': { $exists: true, $gt: 0 }
            },
            {
              categories: 'Sale'
            }
          ]
        }
      };

      if (sortBy === 'price') {
        products = await Product.aggregate([
          matchStage,
          {
            $addFields: {
              effectivePrice: {
                $cond: {
                  if: { $and: [{ $gt: ['$discountedPrice', 0] }, { $lt: ['$discountedPrice', '$price'] }] },
                  then: '$discountedPrice',
                  else: {
                    $cond: {
                      if: { $and: [{ $isArray: '$variants' }, { $gt: [{ $size: '$variants' }, 0] }] },
                      then: { $min: '$variants.discountedPrice' },
                      else: '$price'
                    }
                  }
                }
              }
            }
          },
          { $sort: { effectivePrice: sortOrder === 'asc' ? 1 : -1 } },
          { $skip: skip },
          { $limit: parseInt(limit) }
        ]);
      } else {
        const sortStage = {};
        sortStage[sortBy] = sortOrder === 'asc' ? 1 : -1;

        products = await Product.aggregate([
          matchStage,
          { $sort: sortStage },
          { $skip: skip },
          { $limit: parseInt(limit) }
        ]);
      }

      // Count total using aggregation to handle $expr in $or
      const countResult = await Product.aggregate([
        matchStage,
        { $count: 'total' }
      ]);
      const total = countResult.length > 0 ? countResult[0].total : 0;

      return {
        success: true,
        data: products,
        count: products.length,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      throw new Error(`Failed to fetch sale products: ${error.message}`);
    }
  },

  async getAllPublishedProducts(limit = 50, page = 1, sortBy = 'price', sortOrder = 'asc') {
    try {
      const skip = (page - 1) * limit;

      let products;

      // For price sorting, use aggregation to sort by effective price (discountedPrice or price)
      if (sortBy === 'price') {
        products = await Product.aggregate([
          { $match: { status: 'published', displayOn: { $ne: 'pos' } } },
          {
            $addFields: {
              effectivePrice: {
                $cond: {
                  if: { $and: [{ $ne: ['$discountedPrice', null] }, { $gt: ['$discountedPrice', 0] }] },
                  then: '$discountedPrice',
                  else: '$price'
                }
              }
            }
          },
          { $sort: { effectivePrice: sortOrder === 'asc' ? 1 : -1 } },
          { $skip: skip },
          { $limit: parseInt(limit) },
          { $project: { effectivePrice: 0 } }
        ]);
      } else {
        // For other sorts (name, etc.), use regular find
        const sortOptions = {};
        sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

        products = await Product.find({ status: 'published', displayOn: { $ne: 'pos' } })
          .sort(sortOptions)
          .limit(parseInt(limit))
          .skip(skip)
          .select('-__v');
      }

      const total = await Product.countDocuments({ status: 'published', displayOn: { $ne: 'pos' } });

      return {
        success: true,
        data: products,
        count: products.length,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      throw new Error(`Failed to fetch all products: ${error.message}`);
    }
  }
};

module.exports = publicProductService;