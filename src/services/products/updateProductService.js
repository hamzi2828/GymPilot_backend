// updateProductService.js
const path = require('path');
const crypto = require('crypto');
const Product = require('../../models/product');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Helper function to convert uploaded filename to public path (for local storage)
const toPublicPath = (filename) => {
  if (!filename) return null;
  return `/uploads/${filename}`;
};

// Helper function to normalize URLs (fix malformed URLs like /https://...)
const normalizeUrl = (url) => {
  if (!url) return url;
  // If URL starts with /http, remove the leading slash
  if (url.startsWith('/http')) {
    return url.substring(1);
  }
  return url;
};

// Import blob upload helper if using Vercel Blob
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

// Generate unique variant ID
const generateVariantId = (productName, color, size) => {
  // Create a readable but unique ID format: PRODUCT_COLOR_SIZE_RANDOM
  const productCode = productName.split(' ').map(word => word.charAt(0)).join('').toUpperCase();
  const colorCode = color.substring(0, 3).toUpperCase();
  const sizeCode = size.charAt(0).toUpperCase();
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();

  return `${productCode}-${colorCode}-${sizeCode}-${randomSuffix}`;
};

// Generate SKU for variant
const generateVariantSKU = (productName, color, size, index) => {
  const productCode = productName.split(' ').map(word => word.charAt(0)).join('').toUpperCase();
  const colorCode = color.substring(0, 3).toUpperCase();
  const sizeCode = size.charAt(0).toUpperCase();
  const variantNumber = String(index + 1).padStart(2, '0');

  return `${productCode}-${colorCode}-${sizeCode}-${variantNumber}`;
};

const updateProductService = {
  /**
   * Update a product with new data and files
   * @param {string} id - Product ID
   * @param {Object} payload - Request body data
   * @param {Object} files - Uploaded files
   * @returns {Promise<Object>} Updated product
   */
  updateProduct: async (id, payload, files) => {
    // Initialize colorMedia from payload
    let colorMedia = null;

    // Parse colorMedia if it's a string
    if (typeof payload.colorMedia === 'string') {
      try {
        colorMedia = JSON.parse(payload.colorMedia);
        console.log('Parsed colorMedia:', colorMedia);
      } catch (error) {
        console.error('Failed to parse colorMedia JSON:', error);
        colorMedia = null;
      }
    } else if (payload.colorMedia && typeof payload.colorMedia === 'object') {
      colorMedia = payload.colorMedia;
    }

    // Process files - use Vercel Blob or local storage
    let blobThumbnailUrl = null;
    let blobBannerUrls = [];
    let blobCustomSizeGuideUrl = null;

    if (USE_BLOB_STORAGE && blobUpload) {
      // Upload to Vercel Blob
      console.log('Using Vercel Blob storage for update...');
      const blobResult = await blobUpload.processProductFiles(files);

      if (blobResult.thumbnailUrl) {
        blobThumbnailUrl = blobResult.thumbnailUrl;
      }
      if (blobResult.bannerUrls.length) {
        blobBannerUrls = blobResult.bannerUrls;
      }
      if (Object.keys(blobResult.colorMedia).length) {
        if (!colorMedia) colorMedia = {};
        colorMedia = { ...colorMedia, ...blobResult.colorMedia };
      }
      if (blobResult.customSizeGuideUrl) {
        blobCustomSizeGuideUrl = blobResult.customSizeGuideUrl;
      }
    } else {
      // Local storage - Process new color-specific media files
      if (files.colorThumbnail || files.colorBanner) {
        console.log('Processing color-specific files...');

        // Initialize colorMedia if not already present
        if (!colorMedia) colorMedia = {};

        // Process color thumbnails
        if (files.colorThumbnail) {
          const thumbFiles = Array.isArray(files.colorThumbnail) ? files.colorThumbnail : [files.colorThumbnail];
          thumbFiles.forEach(file => {
            // Extract color from filename (format: color_originalname.ext)
            const colorMatch = file.originalname.match(/^([^_]+)_/);
            if (colorMatch) {
              const color = colorMatch[1];
              if (!colorMedia[color]) colorMedia[color] = { bannerUrls: [] };
              colorMedia[color].thumbnailUrl = toPublicPath(file.filename);
              console.log(`Added thumbnail for color ${color}: ${file.filename}`);
            }
          });
        }

        // Process color banners
        if (files.colorBanner) {
          const bannerFiles = Array.isArray(files.colorBanner) ? files.colorBanner : [files.colorBanner];
          bannerFiles.forEach(file => {
            // Extract color from filename
            const colorMatch = file.originalname.match(/^([^_]+)_/);
            if (colorMatch) {
              const color = colorMatch[1];
              if (!colorMedia[color]) colorMedia[color] = { bannerUrls: [] };
              if (!colorMedia[color].bannerUrls) colorMedia[color].bannerUrls = [];

              // Add new banner URL to existing banners
              const newBannerUrl = toPublicPath(file.filename);
              colorMedia[color].bannerUrls.push(newBannerUrl);
              console.log(`Added banner for color ${color}: ${file.filename}`);
            }
          });
        }
      }
    }
    
    // Process existingColorThumbnails and existingColorBanners
    // These come as arrays of JSON strings, so we need to parse them
    if (payload.existingColorThumbnails && !colorMedia) {
      colorMedia = {};
    }
    
    if (payload.existingColorThumbnails) {
      const thumbsArray = Array.isArray(payload.existingColorThumbnails) 
        ? payload.existingColorThumbnails 
        : [payload.existingColorThumbnails];
        
      thumbsArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.url) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            // Only set if we don't have a new thumbnail for this color
            if (!colorMedia[parsed.color].thumbnailUrl) {
              colorMedia[parsed.color].thumbnailUrl = parsed.url;
            }
          }
        } catch (e) {
          console.error('Error parsing existingColorThumbnails item:', e);
        }
      });
    }
    
    if (payload.existingColorBanners) {
      const bannersArray = Array.isArray(payload.existingColorBanners) 
        ? payload.existingColorBanners 
        : [payload.existingColorBanners];
        
      bannersArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.urls) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            // Merge existing banners with any new ones (put existing first)
            const existingBanners = parsed.urls || [];
            const newBanners = colorMedia[parsed.color].bannerUrls || [];
            // Filter out existing URLs to avoid duplicates
            const existingUrls = existingBanners.filter(url => !newBanners.includes(url));
            colorMedia[parsed.color].bannerUrls = [...existingUrls, ...newBanners].slice(0, 5);
          }
        } catch (e) {
          console.error('Error parsing existingColorBanners item:', e);
        }
      });
    }

    // Build updates object
    const updates = {};
    
    if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
    if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();

    // Handle categories array
    if (typeof payload.categories !== 'undefined') {
      let categories = payload.categories;
      // Parse if string
      if (typeof categories === 'string') {
        try {
          categories = JSON.parse(categories);
        } catch (e) {
          categories = [categories];
        }
      }
      if (Array.isArray(categories)) {
        updates.categories = categories.map(c => String(c).trim()).filter(c => c);
      }
    } else if (typeof payload.category !== 'undefined') {
      // Backward compatibility: if only category is provided, convert to categories array
      updates.categories = [String(payload.category).trim()];
    }
    if (typeof payload.price !== 'undefined') updates.price = Number(payload.price);
    if (typeof payload.websitePrice !== 'undefined') {
      // Only set websitePrice if displayOn is 'both', otherwise clear it
      const displayOn = payload.displayOn || 'both';
      if (displayOn === 'both' && payload.websitePrice !== null && payload.websitePrice !== '') {
        updates.websitePrice = Number(payload.websitePrice);
      } else {
        updates.websitePrice = undefined;
      }
    }
    if (typeof payload.discountedPrice !== 'undefined') {
      updates.discountedPrice = payload.discountedPrice === null ? undefined : Number(payload.discountedPrice);
    }
    if (typeof payload.websiteDiscountedPrice !== 'undefined') {
      // Only set websiteDiscountedPrice if displayOn is 'both', otherwise clear it
      const displayOn = payload.displayOn || 'both';
      if (displayOn === 'both' && payload.websiteDiscountedPrice !== null && payload.websiteDiscountedPrice !== '') {
        updates.websiteDiscountedPrice = Number(payload.websiteDiscountedPrice);
      } else {
        updates.websiteDiscountedPrice = undefined;
      }
    }
    if (typeof payload.stock !== 'undefined') updates.stock = Number(payload.stock);
    if (typeof payload.status !== 'undefined') updates.status = String(payload.status);
    if (typeof payload.featured !== 'undefined') updates.featured = payload.featured === 'true' || payload.featured === true;
    
    // Handle description fields
    if (typeof payload.description !== 'undefined') {
      updates.description = payload.description ? String(payload.description).trim() : null;
    }
    if (typeof payload.shortDescription !== 'undefined') {
      updates.shortDescription = payload.shortDescription ? String(payload.shortDescription).trim() : null;
    }
    if (typeof payload.features !== 'undefined') {
      updates.features = payload.features ? String(payload.features).trim() : null;
    }

    // Handle SEO fields
    if (typeof payload.metaTitle !== 'undefined') {
      updates.metaTitle = payload.metaTitle ? String(payload.metaTitle).trim() : null;
    }
    if (typeof payload.metaDescription !== 'undefined') {
      updates.metaDescription = payload.metaDescription ? String(payload.metaDescription).trim() : null;
    }
    if (typeof payload.metaKeywords !== 'undefined') {
      updates.metaKeywords = payload.metaKeywords ? String(payload.metaKeywords).trim() : null;
    }
    if (typeof payload.metaSchema !== 'undefined') {
      updates.metaSchema = payload.metaSchema ? String(payload.metaSchema).trim() : null;
    }

    // Handle preorder fields
    if (typeof payload.preorderEnabled !== 'undefined') {
      updates.preorderEnabled = payload.preorderEnabled === 'true' || payload.preorderEnabled === true;
    }
    if (typeof payload.preorderMessage !== 'undefined') {
      updates.preorderMessage = payload.preorderMessage ? String(payload.preorderMessage).trim() : '';
    }

    // Handle customization field
    if (typeof payload.customizesAllowed !== 'undefined') {
      updates.customizesAllowed = payload.customizesAllowed === 'true' || payload.customizesAllowed === true;
    }

    // Handle guidelineId field
    if (typeof payload.guidelineId !== 'undefined') {
      updates.guidelineId = payload.guidelineId && payload.guidelineId !== 'null' && payload.guidelineId !== '' ? payload.guidelineId : null;
    }

    // Handle fabricId field
    if (typeof payload.fabricId !== 'undefined') {
      updates.fabricId = payload.fabricId && payload.fabricId !== 'null' && payload.fabricId !== '' ? payload.fabricId : null;
    }

    // Handle sizeGuideType field
    if (typeof payload.sizeGuideType !== 'undefined') {
      updates.sizeGuideType = ['predefined', 'custom'].includes(payload.sizeGuideType) ? payload.sizeGuideType : 'predefined';
    }

    // Handle sizeGuideId field (only for predefined type)
    if (typeof payload.sizeGuideId !== 'undefined') {
      const sizeGuideType = payload.sizeGuideType || 'predefined';
      if (sizeGuideType === 'predefined') {
        updates.sizeGuideId = payload.sizeGuideId && payload.sizeGuideId !== 'null' && payload.sizeGuideId !== '' ? payload.sizeGuideId : null;
      } else {
        updates.sizeGuideId = null;
      }
    }

    // Handle custom size guide image
    if (blobCustomSizeGuideUrl) {
      // Vercel Blob storage - use uploaded URL
      updates.customSizeGuideUrl = blobCustomSizeGuideUrl;
    } else if (files.customSizeGuideImage) {
      // Local storage - use local path
      const customSizeGuideFile = Array.isArray(files.customSizeGuideImage)
        ? files.customSizeGuideImage[0]
        : files.customSizeGuideImage;
      if (customSizeGuideFile) {
        updates.customSizeGuideUrl = toPublicPath(customSizeGuideFile.filename);
      }
    } else if (typeof payload.customSizeGuideUrl !== 'undefined') {
      const sizeGuideType = payload.sizeGuideType || 'predefined';
      if (sizeGuideType === 'custom' && payload.customSizeGuideUrl) {
        updates.customSizeGuideUrl = String(payload.customSizeGuideUrl).trim();
      } else {
        updates.customSizeGuideUrl = null;
      }
    }

    // Handle showGuidelines field
    if (typeof payload.showGuidelines !== 'undefined') {
      updates.showGuidelines = payload.showGuidelines === 'true' || payload.showGuidelines === true;
    }

    // Handle styleNumber for single products
    if (typeof payload.styleNumber !== 'undefined') {
      // Only set styleNumber for single products
      const productType = payload.productType || 'single';
      if (productType !== 'variant') {
        updates.styleNumber = payload.styleNumber ? String(payload.styleNumber).trim() : null;
      }
    }

    // Handle dimension fields (L x W x H)
    if (typeof payload.dimensionLength !== 'undefined') {
      updates.dimensionLength = payload.dimensionLength ? String(payload.dimensionLength).trim() : null;
    }
    if (typeof payload.dimensionWidth !== 'undefined') {
      updates.dimensionWidth = payload.dimensionWidth ? String(payload.dimensionWidth).trim() : null;
    }
    if (typeof payload.dimensionHeight !== 'undefined') {
      updates.dimensionHeight = payload.dimensionHeight ? String(payload.dimensionHeight).trim() : null;
    }

    // Handle weight field
    if (typeof payload.weight !== 'undefined') {
      updates.weight = payload.weight ? String(payload.weight).trim() : null;
    }

    // Handle stockType field
    if (typeof payload.stockType !== 'undefined') {
      updates.stockType = ['ready_to_ship', 'made_to_order'].includes(payload.stockType)
        ? payload.stockType
        : 'ready_to_ship';
    }

    // Handle relatedProducts field
    if (typeof payload.relatedProducts !== 'undefined') {
      let relatedProducts = payload.relatedProducts;
      if (typeof relatedProducts === 'string') {
        try {
          relatedProducts = JSON.parse(relatedProducts);
        } catch (e) {
          relatedProducts = [];
        }
      }
      updates.relatedProducts = Array.isArray(relatedProducts) ? relatedProducts : [];
    }

    // Handle thumbnail - check for new upload or existing
    if (USE_BLOB_STORAGE && blobThumbnailUrl) {
      updates.thumbnailUrl = blobThumbnailUrl;
    } else if (files.thumbnail && files.thumbnail[0]) {
      updates.thumbnailUrl = toPublicPath(files.thumbnail[0].filename);
    } else if (payload.existingThumbnail) {
      updates.thumbnailUrl = normalizeUrl(payload.existingThumbnail);
    } else if (typeof payload.thumbnailUrl !== 'undefined') {
      updates.thumbnailUrl = payload.thumbnailUrl ? normalizeUrl(String(payload.thumbnailUrl).trim()) : null;
    }

    // Handle banner images
    if (USE_BLOB_STORAGE && blobBannerUrls.length > 0) {
      let existingBanners = [];
      if (payload.existingBanners) {
        try {
          existingBanners = JSON.parse(payload.existingBanners);
          if (!Array.isArray(existingBanners)) existingBanners = [];
          existingBanners = existingBanners.map(u => normalizeUrl(String(u)));
        } catch (e) {
          console.error('Error parsing existingBanners:', e);
        }
      }
      updates.bannerUrls = [...existingBanners, ...blobBannerUrls].slice(0, 5);
    } else if (files.banners && files.banners.length > 0) {
      const uploadedBanners = files.banners.map(f => toPublicPath(f.filename));

      let existingBanners = [];
      if (payload.existingBanners) {
        try {
          existingBanners = JSON.parse(payload.existingBanners);
          if (!Array.isArray(existingBanners)) existingBanners = [];
          existingBanners = existingBanners.map(u => normalizeUrl(String(u)));
        } catch (e) {
          console.error('Error parsing existingBanners:', e);
        }
      }

      updates.bannerUrls = [...existingBanners, ...uploadedBanners].slice(0, 5);
    } else if (payload.existingBanners) {
      try {
        updates.bannerUrls = JSON.parse(payload.existingBanners);
        if (!Array.isArray(updates.bannerUrls)) updates.bannerUrls = [];
        updates.bannerUrls = updates.bannerUrls.slice(0, 5).map(u => normalizeUrl(String(u)));
      } catch (e) {
        console.error('Error parsing existingBanners:', e);
        updates.bannerUrls = [];
      }
    } else if (typeof payload.bannerUrls !== 'undefined') {
      updates.bannerUrls = Array.isArray(payload.bannerUrls)
        ? payload.bannerUrls.slice(0, 5).map((u) => normalizeUrl(String(u)))
        : [];
    }
    
    if (typeof payload.productType !== 'undefined') {
      updates.productType = payload.productType === 'variant' ? 'variant' : 'single';
    }

    if (typeof payload.displayOn !== 'undefined') {
      updates.displayOn = ['website', 'pos', 'both'].includes(payload.displayOn) ? payload.displayOn : 'both';
    }
    
    // Parse variants if it's a string
    if (typeof payload.variants === 'string') {
      try {
        updates.variants = JSON.parse(payload.variants);
        console.log('Parsed variants:', updates.variants);
      } catch (error) {
        console.error('Failed to parse variants JSON:', error);
        updates.variants = [];
      }
    } else if (Array.isArray(payload.variants)) {
      updates.variants = payload.variants;
    }

    // Process variants to ensure they have variantId and sku
    if (Array.isArray(updates.variants) && updates.variants.length > 0) {
      const productName = updates.name || payload.name || 'Product';

      updates.variants = updates.variants.map((variant, index) => {
        // Generate variantId if missing
        if (!variant.variantId) {
          variant.variantId = generateVariantId(productName, variant.color, variant.size);
        }

        // Generate SKU if missing
        if (!variant.sku) {
          variant.sku = generateVariantSKU(productName, variant.color, variant.size, index);
        }

        // Ensure numeric fields are numbers
        variant.price = Number(variant.price) || 0;
        variant.stock = Number(variant.stock) || 0;

        // Parse websitePrice - handle both number and string values
        if (variant.websitePrice !== undefined && variant.websitePrice !== null && variant.websitePrice !== '') {
          const parsed = Number(variant.websitePrice);
          variant.websitePrice = (!isNaN(parsed) && parsed > 0) ? parsed : undefined;
        } else {
          variant.websitePrice = undefined;
        }

        // Parse discountedPrice - handle both number and string values
        if (variant.discountedPrice !== undefined && variant.discountedPrice !== null && variant.discountedPrice !== '') {
          const parsed = Number(variant.discountedPrice);
          variant.discountedPrice = (!isNaN(parsed) && parsed > 0) ? parsed : undefined;
        } else {
          variant.discountedPrice = undefined;
        }

        // Parse websiteDiscountedPrice - handle both number and string values
        if (variant.websiteDiscountedPrice !== undefined && variant.websiteDiscountedPrice !== null && variant.websiteDiscountedPrice !== '') {
          const parsed = Number(variant.websiteDiscountedPrice);
          variant.websiteDiscountedPrice = (!isNaN(parsed) && parsed > 0) ? parsed : undefined;
        } else {
          variant.websiteDiscountedPrice = undefined;
        }

        // Handle styleNumber for variants
        if (variant.styleNumber !== undefined && variant.styleNumber !== null && variant.styleNumber !== '') {
          variant.styleNumber = String(variant.styleNumber).trim();
        } else {
          variant.styleNumber = undefined;
        }

        return variant;
      });

      console.log('Processed variants with variantId:', updates.variants);
    }
    
    // Handle colorMedia for MongoDB Map type
    if (colorMedia && typeof colorMedia === 'object' && Object.keys(colorMedia).length > 0) {
      console.log('Creating MongoDB Map from colorMedia object');
      try {
        // Convert to Map format that MongoDB expects
        const colorMediaMap = new Map();
        
        Object.entries(colorMedia).forEach(([key, value]) => {
          console.log(`Adding to Map - key: ${key}, value:`, value);
          colorMediaMap.set(key, value);
        });
        
        console.log('Final Map size:', colorMediaMap.size);
        updates.colorMedia = colorMediaMap;
      } catch (error) {
        console.error('Error creating MongoDB Map:', error);
      }
    }
    
    console.log('Final updates object:', {
      ...updates,
      colorMedia: updates.colorMedia ? `Map with ${updates.colorMedia.size} entries` : 'not set'
    });

    // Update the product in database
    const updated = await Product.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!updated) {
      throw new Error('Product not found');
    }

    return updated;
  }
};

module.exports = updateProductService;