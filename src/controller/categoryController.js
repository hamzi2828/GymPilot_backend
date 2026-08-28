// src/controller/categoryController.js
const Category = require('../models/category');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Import blob upload helper if using Vercel Blob
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

const categoryController = {
  // GET /categories - list all categories
  listCategories: async (req, res) => {
    try {
      const { parentOnly, flat } = req.query;

      let query = {};
      // If parentOnly=true, only return top-level categories (no parent)
      if (parentOnly === 'true') {
        query.parentId = null;
      }

      const categories = await Category.find(query)
        .populate('parentId', 'name slug')
        .sort({ parentId: 1, name: 1 });

      // If flat=false, return hierarchical structure
      if (flat === 'false') {
        const parentCategories = categories.filter(c => !c.parentId);
        const childCategories = categories.filter(c => c.parentId);

        const hierarchical = parentCategories.map(parent => ({
          ...parent.toObject(),
          children: childCategories.filter(child =>
            child.parentId && child.parentId._id.toString() === parent._id.toString()
          ),
        }));

        return res.status(200).json({ message: 'Categories fetched successfully', data: hierarchical });
      }

      return res.status(200).json({ message: 'Categories fetched successfully', data: categories });
    } catch (error) {
      console.error('List categories error:', error);
      return res.status(400).json({ message: 'Error fetching categories', error: error.message });
    }
  },
  listFeaturedCategoriesWithProducts: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 6;
      const Product = require('../models/product');

      // Get featured categories that are active
      const categories = await Category.find({
        featured: true,
        active: true
      }).limit(limit).sort({ createdAt: -1 });

      // For each category, get some products
      // Category can be stored as "Bottoms" or "Bottoms > Jeans > orginal"
      // We need to match products where category starts with or contains this category name
      const categoriesWithProducts = await Promise.all(
        categories.map(async (category) => {
          // Escape special regex characters in category name
          const escapedName = category.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match: exact "CategoryName" OR starts with "CategoryName > " OR contains " > CategoryName > " OR ends with " > CategoryName"
          const categoryRegex = new RegExp(`^${escapedName}$|^${escapedName} > | > ${escapedName} > | > ${escapedName}$`, 'i');

          const products = await Product.find({
            categories: categoryRegex,
            status: 'published',
            displayOn: { $ne: 'pos' },
            stock: { $gt: 0 }
          }).limit(6); // Get 6 products per category

          return {
            ...category.toObject(),
            products: products
          };
        })
      );

      return res.status(200).json({
        message: 'Featured categories with products fetched successfully',
        data: categoriesWithProducts
      });
    } catch (error) {
      console.error('List featured categories with products error:', error);
      return res.status(400).json({ message: 'Error fetching featured categories with products', error: error.message });
    }
  },

  // OPTIMIZED: Featured categories with minimal product data for homepage
  listFeaturedCategoriesOptimized: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 6;
      const productsPerCategory = parseInt(req.query.productsLimit) || 6;
      const Product = require('../models/product');

      // Get featured categories that are active (only needed fields)
      const categories = await Category.find({
        featured: true,
        active: true
      })
        .select('_id name slug thumbnailUrl bannerUrl')
        .limit(limit)
        .sort({ createdAt: -1 });

      // For each category, get optimized product data using aggregation
      const categoriesWithProducts = await Promise.all(
        categories.map(async (category) => {
          const escapedName = category.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const categoryRegex = new RegExp(`^${escapedName}$|^${escapedName} > | > ${escapedName} > | > ${escapedName}$`, 'i');

          const products = await Product.aggregate([
            {
              $match: {
                categories: categoryRegex,
                status: 'published',
                displayOn: { $ne: 'pos' },
                stock: { $gt: 0 }
              }
            },
            { $limit: productsPerCategory },
            {
              $addFields: {
                // Get thumbnail from colorMedia if available
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

          return {
            _id: category._id,
            name: category.name,
            slug: category.slug,
            thumbnailUrl: category.thumbnailUrl,
            bannerUrl: category.bannerUrl,
            products: products
          };
        })
      );

      return res.status(200).json({
        success: true,
        data: categoriesWithProducts,
        count: categoriesWithProducts.length
      });
    } catch (error) {
      console.error('List featured categories optimized error:', error);
      return res.status(400).json({ success: false, message: 'Error fetching featured categories', error: error.message });
    }
  },

  // POST /categories - create a new category
  createCategory: async (req, res) => {
    try {
      let {
        name,
        slug,
        description = '',
        active = true,
        featured = false,
        showInCollections = false,
        parentId = null,
        shippingCost = 0,
        seoIntroTitle = '',
        seoIntroBody = '',
        seoFooterBody = '',
        seoFaqs = [],
        metaTitle = '',
        metaDescription = '',
        metaKeywords = '',
      } = req.body || {};

      if (!name || !slug) {
        return res.status(400).json({ message: 'name and slug are required' });
      }

      name = String(name).trim();
      slug = String(slug).trim().toLowerCase();
      description = String(description || '').trim();
      active = active === 'true' || active === true;
      featured = featured === 'true' || featured === true;
      showInCollections = showInCollections === 'true' || showInCollections === true;

      // Handle parentId - convert empty string or 'null' to actual null
      if (parentId === '' || parentId === 'null' || parentId === 'undefined') {
        parentId = null;
      }

      // Validate parentId if provided
      if (parentId) {
        const parentExists = await Category.findById(parentId);
        if (!parentExists) {
          return res.status(400).json({ message: 'Parent category not found' });
        }
      }

      // Handle file uploads
      const thumbnailFile = req.files?.thumbnail?.[0];
      const bannerFile = req.files?.banner?.[0];

      let thumbnailUrl = null;
      let bannerUrl = null;

      if (USE_BLOB_STORAGE && blobUpload) {
        // Upload to Vercel Blob
        if (thumbnailFile) {
          thumbnailUrl = await blobUpload.uploadToBlob(
            thumbnailFile.buffer,
            thumbnailFile.originalname,
            thumbnailFile.mimetype,
            'categories/thumbnails'
          );
        }
        if (bannerFile) {
          bannerUrl = await blobUpload.uploadToBlob(
            bannerFile.buffer,
            bannerFile.originalname,
            bannerFile.mimetype,
            'categories/banners'
          );
        }
      } else {
        // Local storage
        thumbnailUrl = thumbnailFile ? `/uploads/${thumbnailFile.filename}` : null;
        bannerUrl = bannerFile ? `/uploads/${bannerFile.filename}` : null;
      }

      // Parse shippingCost as number
      const parsedShippingCost = parseFloat(shippingCost) || 0;

      // Normalize seoFaqs: accept JSON string from multipart forms, drop empty rows.
      let parsedFaqs = seoFaqs;
      if (typeof parsedFaqs === 'string') {
        try { parsedFaqs = JSON.parse(parsedFaqs); } catch { parsedFaqs = []; }
      }
      if (!Array.isArray(parsedFaqs)) parsedFaqs = [];
      parsedFaqs = parsedFaqs
        .map((f) => ({
          question: String(f?.question || '').trim(),
          answer: String(f?.answer || '').trim(),
        }))
        .filter((f) => f.question && f.answer);

      const categoryData = {
        name,
        slug,
        description,
        active,
        featured,
        showInCollections,
        thumbnailUrl,
        bannerUrl,
        parentId,
        shippingCost: parsedShippingCost,
        seoIntroTitle: String(seoIntroTitle || '').trim(),
        seoIntroBody: String(seoIntroBody || ''),
        seoFooterBody: String(seoFooterBody || ''),
        seoFaqs: parsedFaqs,
        metaTitle: String(metaTitle || '').trim(),
        metaDescription: String(metaDescription || '').trim(),
        metaKeywords: String(metaKeywords || '').trim(),
      };

      const created = await Category.create(categoryData);
      return res.status(201).json({ message: 'Category created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Create category error:', error);
      return res.status(400).json({ message: 'Error creating category', error: error.message });
    }
  },

  // PUT /categories/:id - update a category
  updateCategory: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
      if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();
      if (typeof payload.description !== 'undefined') updates.description = String(payload.description || '').trim();
      if (typeof payload.active !== 'undefined') updates.active = payload.active === 'true' || payload.active === true;
      if (typeof payload.featured !== 'undefined') updates.featured = payload.featured === 'true' || payload.featured === true;
      if (typeof payload.showInCollections !== 'undefined') updates.showInCollections = payload.showInCollections === 'true' || payload.showInCollections === true;
      if (typeof payload.shippingCost !== 'undefined') updates.shippingCost = parseFloat(payload.shippingCost) || 0;
      if (typeof payload.estimatedDays !== 'undefined') updates.estimatedDays = String(payload.estimatedDays || '').trim();

      // SEO content fields — accept empty string to clear.
      if (typeof payload.seoIntroTitle !== 'undefined') updates.seoIntroTitle = String(payload.seoIntroTitle || '').trim();
      if (typeof payload.seoIntroBody !== 'undefined') updates.seoIntroBody = String(payload.seoIntroBody || '');
      if (typeof payload.seoFooterBody !== 'undefined') updates.seoFooterBody = String(payload.seoFooterBody || '');
      if (typeof payload.metaTitle !== 'undefined') updates.metaTitle = String(payload.metaTitle || '').trim();
      if (typeof payload.metaDescription !== 'undefined') updates.metaDescription = String(payload.metaDescription || '').trim();
      if (typeof payload.metaKeywords !== 'undefined') updates.metaKeywords = String(payload.metaKeywords || '').trim();
      if (typeof payload.seoFaqs !== 'undefined') {
        let faqs = payload.seoFaqs;
        if (typeof faqs === 'string') {
          try { faqs = JSON.parse(faqs); } catch { faqs = []; }
        }
        if (!Array.isArray(faqs)) faqs = [];
        updates.seoFaqs = faqs
          .map((f) => ({
            question: String(f?.question || '').trim(),
            answer: String(f?.answer || '').trim(),
          }))
          .filter((f) => f.question && f.answer);
      }

      // Handle parentId update
      if (typeof payload.parentId !== 'undefined') {
        let parentId = payload.parentId;
        if (parentId === '' || parentId === 'null' || parentId === 'undefined') {
          updates.parentId = null;
        } else if (parentId) {
          // Prevent setting self as parent
          if (parentId === id) {
            return res.status(400).json({ message: 'Category cannot be its own parent' });
          }
          // Validate parent exists
          const parentExists = await Category.findById(parentId);
          if (!parentExists) {
            return res.status(400).json({ message: 'Parent category not found' });
          }
          updates.parentId = parentId;
        }
      }

      // Handle file uploads
      const thumbnailFile = req.files?.thumbnail?.[0];
      const bannerFile = req.files?.banner?.[0];
      const sizeChartRegularCmFile = req.files?.sizeChartRegularCm?.[0];
      const sizeChartRegularInchFile = req.files?.sizeChartRegularInch?.[0];
      const sizeChartRelaxedCmFile = req.files?.sizeChartRelaxedCm?.[0];
      const sizeChartRelaxedInchFile = req.files?.sizeChartRelaxedInch?.[0];
      const measuringTipImageFile = req.files?.measuringTipImage?.[0];

      // Handle size guide image removals (empty string = remove)
      if (payload.sizeChartRegularCm === '' || payload.sizeChartRegularCm === 'null') {
        updates.sizeChartRegularCm = null;
      }
      if (payload.sizeChartRegularInch === '' || payload.sizeChartRegularInch === 'null') {
        updates.sizeChartRegularInch = null;
      }
      if (payload.sizeChartRelaxedCm === '' || payload.sizeChartRelaxedCm === 'null') {
        updates.sizeChartRelaxedCm = null;
      }
      if (payload.sizeChartRelaxedInch === '' || payload.sizeChartRelaxedInch === 'null') {
        updates.sizeChartRelaxedInch = null;
      }
      if (payload.measuringTipImage === '' || payload.measuringTipImage === 'null') {
        updates.measuringTipImage = null;
      }

      if (USE_BLOB_STORAGE && blobUpload) {
        // Upload to Vercel Blob
        if (thumbnailFile) {
          updates.thumbnailUrl = await blobUpload.uploadToBlob(
            thumbnailFile.buffer,
            thumbnailFile.originalname,
            thumbnailFile.mimetype,
            'categories/thumbnails'
          );
        }
        if (bannerFile) {
          updates.bannerUrl = await blobUpload.uploadToBlob(
            bannerFile.buffer,
            bannerFile.originalname,
            bannerFile.mimetype,
            'categories/banners'
          );
        }
        if (sizeChartRegularCmFile) {
          updates.sizeChartRegularCm = await blobUpload.uploadToBlob(
            sizeChartRegularCmFile.buffer,
            sizeChartRegularCmFile.originalname,
            sizeChartRegularCmFile.mimetype,
            'categories/size-guides'
          );
        }
        if (sizeChartRegularInchFile) {
          updates.sizeChartRegularInch = await blobUpload.uploadToBlob(
            sizeChartRegularInchFile.buffer,
            sizeChartRegularInchFile.originalname,
            sizeChartRegularInchFile.mimetype,
            'categories/size-guides'
          );
        }
        if (sizeChartRelaxedCmFile) {
          updates.sizeChartRelaxedCm = await blobUpload.uploadToBlob(
            sizeChartRelaxedCmFile.buffer,
            sizeChartRelaxedCmFile.originalname,
            sizeChartRelaxedCmFile.mimetype,
            'categories/size-guides'
          );
        }
        if (sizeChartRelaxedInchFile) {
          updates.sizeChartRelaxedInch = await blobUpload.uploadToBlob(
            sizeChartRelaxedInchFile.buffer,
            sizeChartRelaxedInchFile.originalname,
            sizeChartRelaxedInchFile.mimetype,
            'categories/size-guides'
          );
        }
        if (measuringTipImageFile) {
          updates.measuringTipImage = await blobUpload.uploadToBlob(
            measuringTipImageFile.buffer,
            measuringTipImageFile.originalname,
            measuringTipImageFile.mimetype,
            'categories/measuring-tips'
          );
        }
      } else {
        // Local storage
        if (thumbnailFile) {
          updates.thumbnailUrl = `/uploads/${thumbnailFile.filename}`;
        }
        if (bannerFile) {
          updates.bannerUrl = `/uploads/${bannerFile.filename}`;
        }
        if (sizeChartRegularCmFile) {
          updates.sizeChartRegularCm = `/uploads/${sizeChartRegularCmFile.filename}`;
        }
        if (sizeChartRegularInchFile) {
          updates.sizeChartRegularInch = `/uploads/${sizeChartRegularInchFile.filename}`;
        }
        if (sizeChartRelaxedCmFile) {
          updates.sizeChartRelaxedCm = `/uploads/${sizeChartRelaxedCmFile.filename}`;
        }
        if (sizeChartRelaxedInchFile) {
          updates.sizeChartRelaxedInch = `/uploads/${sizeChartRelaxedInchFile.filename}`;
        }
        if (measuringTipImageFile) {
          updates.measuringTipImage = `/uploads/${measuringTipImageFile.filename}`;
        }
      }

      const updated = await Category.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ message: 'Category not found' });
      }

      return res.status(200).json({ message: 'Category updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Update category error:', error);
      return res.status(400).json({ message: 'Error updating category', error: error.message });
    }
  },

  // GET /categories/tree - get categories as nested tree structure
  getCategoryTree: async (req, res) => {
    try {
      const categories = await Category.find()
        .populate('parentId', 'name slug')
        .sort({ name: 1 });

      // Build tree structure recursively
      const buildTree = (parentId = null) => {
        return categories
          .filter(cat => {
            const catParentId = cat.parentId?._id?.toString() || cat.parentId?.toString() || null;
            return catParentId === parentId;
          })
          .map(cat => ({
            ...cat.toObject(),
            children: buildTree(cat._id.toString()),
          }));
      };

      const tree = buildTree(null);
      return res.status(200).json({ message: 'Category tree fetched successfully', data: tree });
    } catch (error) {
      console.error('Get category tree error:', error);
      return res.status(400).json({ message: 'Error fetching category tree', error: error.message });
    }
  },

  // DELETE /categories/:id - delete a category
  deleteCategory: async (req, res) => {
    try {
      const { id } = req.params;

      // Check if category has children
      const childCount = await Category.countDocuments({ parentId: id });
      if (childCount > 0) {
        // Option 1: Move children to top-level (set parentId to null)
        await Category.updateMany({ parentId: id }, { $set: { parentId: null } });
      }

      const deleted = await Category.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Category not found' });
      }
      return res.status(200).json({
        message: 'Category deleted successfully',
        id,
        childrenMoved: childCount,
      });
    } catch (error) {
      console.error('Delete category error:', error);
      return res.status(400).json({ message: 'Error deleting category', error: error.message });
    }
  },
};

module.exports = categoryController;
