// createProductService.js
const Product = require('../../models/product');
const crypto = require('crypto');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Helper function to convert uploaded filename to public path (for local storage)
const toPublicPath = (filename) => {
  if (!filename) return null;
  return `/uploads/${filename}`;
};

// Import blob upload helper if using Vercel Blob
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

// Helper function to parse JSON if string or return original value
const parseMaybeJSON = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
};

// Helper function to check if value is a valid number
const isNumber = (value) => {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
};

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

// Process color-specific media files
const processColorMedia = (files, existingColorMedia = {}) => {
  const colorMedia = typeof existingColorMedia === 'object' ? existingColorMedia : {};
  
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
      }
    });
  }
  
  return colorMedia;
};

const createProductService = {
  /**
   * Create a new product with the provided data and files
   * @param {Object} payload - Request body data
   * @param {Object} files - Uploaded files
   * @returns {Promise<Object>} Created product
   */
  createProduct: async (payload, files) => {
    let {
      name,
      slug,
      category,
      categories,
      price,
      discountedPrice,
      stock,
      status = 'draft',
      thumbnailUrl,
      bannerUrls = [],
      productType = 'single',
      variants = [],
      colorMedia,
      description,
      shortDescription,
      features,
      metaTitle,
      metaDescription,
      metaKeywords,
      metaSchema,
      displayOn = 'both',
      websitePrice,
      websiteDiscountedPrice,
      preorderEnabled,
      preorderMessage,
      customizesAllowed,
      guidelineId,
      showGuidelines,
      fabricId,
      sizeGuideId,
      sizeGuideType,
      customSizeGuideUrl,
      styleNumber,
      dimensionLength,
      dimensionWidth,
      dimensionHeight,
      weight,
      stockType,
      relatedProducts,
    } = payload;

    // Parse fields that might come as JSON strings via multipart/form-data
    bannerUrls = parseMaybeJSON(bannerUrls) || [];
    variants = parseMaybeJSON(variants) || [];
    colorMedia = parseMaybeJSON(colorMedia);
    categories = parseMaybeJSON(categories) || [];
    let parsedRelatedProducts = parseMaybeJSON(relatedProducts) || [];

    // Process files - use Vercel Blob or local storage
    if (USE_BLOB_STORAGE && blobUpload) {
      // Upload to Vercel Blob
      console.log('Using Vercel Blob storage...');
      const blobResult = await blobUpload.processProductFiles(files);

      if (blobResult.thumbnailUrl) {
        thumbnailUrl = blobResult.thumbnailUrl;
      }
      if (blobResult.bannerUrls.length) {
        bannerUrls = [...blobResult.bannerUrls, ...bannerUrls];
      }
      if (Object.keys(blobResult.colorMedia).length) {
        colorMedia = { ...colorMedia, ...blobResult.colorMedia };
      }
      if (blobResult.customSizeGuideUrl) {
        customSizeGuideUrl = blobResult.customSizeGuideUrl;
      }
    } else {
      // Local storage processing
      const thumbFile = Array.isArray(files?.thumbnail) ? files.thumbnail[0] : undefined;
      const bannerFiles = Array.isArray(files?.banners) ? files.banners : [];

      // Process color-specific media files if present
      if (files.colorThumbnail || files.colorBanner || payload.existingColorThumbnails || payload.existingColorBanners) {
        console.log('Files received:', Object.keys(files));
        console.log('Processing color media...');
        colorMedia = processColorMedia(files, colorMedia);
      }

      if (thumbFile) {
        thumbnailUrl = toPublicPath(thumbFile.filename);
      }
      if (bannerFiles.length) {
        const uploadedBanners = bannerFiles.map((f) => toPublicPath(f.filename));
        if (Array.isArray(bannerUrls) && bannerUrls.length) {
          bannerUrls = [...uploadedBanners, ...bannerUrls];
        } else {
          bannerUrls = uploadedBanners;
        }
      }

      // Process custom size guide image
      if (files.customSizeGuideImage) {
        const customSizeGuideFile = Array.isArray(files.customSizeGuideImage)
          ? files.customSizeGuideImage[0]
          : files.customSizeGuideImage;
        if (customSizeGuideFile) {
          customSizeGuideUrl = toPublicPath(customSizeGuideFile.filename);
        }
      }
    }

    // Handle existing color thumbnails (for edit scenarios)
    if (payload.existingColorThumbnails) {
      const thumbsArray = Array.isArray(payload.existingColorThumbnails)
        ? payload.existingColorThumbnails
        : [payload.existingColorThumbnails];

      thumbsArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.url) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            if (!colorMedia[parsed.color].thumbnailUrl) {
              colorMedia[parsed.color].thumbnailUrl = parsed.url;
            }
          }
        } catch (e) {
          console.error('Error parsing existingColorThumbnails item:', e);
        }
      });
    }

    // Handle existing color banners (for edit scenarios)
    if (payload.existingColorBanners) {
      const bannersArray = Array.isArray(payload.existingColorBanners)
        ? payload.existingColorBanners
        : [payload.existingColorBanners];

      bannersArray.forEach(item => {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.color && parsed.urls) {
            if (!colorMedia[parsed.color]) colorMedia[parsed.color] = { bannerUrls: [] };
            const existingBanners = parsed.urls || [];
            const newBanners = colorMedia[parsed.color].bannerUrls || [];
            const existingUrls = existingBanners.filter(url => !newBanners.includes(url));
            colorMedia[parsed.color].bannerUrls = [...existingUrls, ...newBanners].slice(0, 10);
          }
        } catch (e) {
          console.error('Error parsing existingColorBanners item:', e);
        }
      });
    }

    console.log('Final processed colorMedia:', colorMedia);

    // Coerce numeric fields when coming from multipart strings
    if (typeof price === 'string' && price !== '') price = Number(price);
    if (typeof websitePrice === 'string' && websitePrice !== '') websitePrice = Number(websitePrice);
    if (typeof discountedPrice === 'string' && discountedPrice !== '') discountedPrice = Number(discountedPrice);
    if (typeof websiteDiscountedPrice === 'string' && websiteDiscountedPrice !== '') websiteDiscountedPrice = Number(websiteDiscountedPrice);
    if (typeof stock === 'string' && stock !== '') stock = Number(stock);
    
    // Handle categories array
    if (!Array.isArray(categories)) {
      categories = [];
    }
    categories = categories.map(c => String(c).trim()).filter(c => c);

    // Backward compatibility: if only category is provided, convert to categories array
    if (category && categories.length === 0) {
      categories = [String(category).trim()];
    }

    if (!name || !slug || categories.length === 0) {
      throw new Error('name, slug and at least one category are required');
    }

    name = String(name).trim();
    slug = String(slug).trim().toLowerCase();
    status = ['published', 'draft', 'out_of_stock'].includes(status) ? status : 'draft';

    if (productType === 'variant') {
      if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error('At least one variant is required for variant products');
      }
      
      // Basic validation and ID generation for variants
      variants = variants.map((v, index) => {
        const color = String(v.color || '').trim();
        const size = String(v.size || '').trim();

        // Parse discountedPrice - handle both number and string values
        let discountedPrice = undefined;
        if (v.discountedPrice !== undefined && v.discountedPrice !== null && v.discountedPrice !== '') {
          const parsed = Number(v.discountedPrice);
          if (!isNaN(parsed) && parsed > 0) {
            discountedPrice = parsed;
          }
        }

        // Parse websitePrice - handle both number and string values
        let websitePrice = undefined;
        if (v.websitePrice !== undefined && v.websitePrice !== null && v.websitePrice !== '') {
          const parsed = Number(v.websitePrice);
          if (!isNaN(parsed) && parsed > 0) {
            websitePrice = parsed;
          }
        }

        // Parse websiteDiscountedPrice - handle both number and string values
        let websiteDiscountedPrice = undefined;
        if (v.websiteDiscountedPrice !== undefined && v.websiteDiscountedPrice !== null && v.websiteDiscountedPrice !== '') {
          const parsed = Number(v.websiteDiscountedPrice);
          if (!isNaN(parsed) && parsed > 0) {
            websiteDiscountedPrice = parsed;
          }
        }

        return {
          variantId: v.variantId || generateVariantId(name, color, size), // Generate if not provided
          color,
          size,
          price: Number(v.price || 0),
          websitePrice,
          stock: Number(v.stock || 0),
          sku: v.sku ? String(v.sku).trim() : generateVariantSKU(name, color, size, index), // Generate SKU if not provided
          discountedPrice,
          websiteDiscountedPrice,
          styleNumber: v.styleNumber ? String(v.styleNumber).trim() : undefined,
        };
      });

      for (const v of variants) {
        if (!v.color || !v.size) {
          throw new Error('Each variant must include color and size');
        }
        if (!isNumber(v.price) || v.price < 0) {
          throw new Error('Variant price must be a non-negative number');
        }
        if (!Number.isInteger(v.stock) || v.stock < 0) {
          throw new Error('Variant stock must be a non-negative integer');
        }
      }

      // Derive stock and base price if not provided
      const derivedStock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
      const basePrice = isNumber(price) ? price : variants[0]?.price || 0;
      stock = derivedStock;
      price = basePrice;
      
    } else {
      // single product validations
      if (!isNumber(price) || price < 0) {
        throw new Error('price must be a non-negative number');
      }
      if (!Number.isInteger(stock) || stock < 0) {
        throw new Error('stock must be a non-negative integer');
      }
    }

    // Enforce banner length on server as well
    if (Array.isArray(bannerUrls) && bannerUrls.length > 5) {
      bannerUrls = bannerUrls.slice(0, 5);
    }

    const doc = {
      name,
      slug,
      categories,
      price,
      websitePrice: (displayOn === 'both' && isNumber(websitePrice)) ? websitePrice : undefined,
      discountedPrice: isNumber(discountedPrice) ? discountedPrice : undefined,
      websiteDiscountedPrice: (displayOn === 'both' && isNumber(websiteDiscountedPrice)) ? websiteDiscountedPrice : undefined,
      stock,
      status,
      thumbnailUrl: thumbnailUrl ? String(thumbnailUrl).trim() : undefined,
      bannerUrls: Array.isArray(bannerUrls) ? bannerUrls.map((u) => String(u)) : [],
      productType: productType === 'variant' ? 'variant' : 'single',
      displayOn: ['website', 'pos', 'both'].includes(displayOn) ? displayOn : 'both',
      variants: Array.isArray(variants) ? variants : [],
      description: description ? String(description).trim() : undefined,
      shortDescription: shortDescription ? String(shortDescription).trim() : undefined,
      features: features ? String(features).trim() : undefined,
      metaTitle: metaTitle ? String(metaTitle).trim() : undefined,
      metaDescription: metaDescription ? String(metaDescription).trim() : undefined,
      metaKeywords: metaKeywords ? String(metaKeywords).trim() : undefined,
      metaSchema: metaSchema ? String(metaSchema).trim() : undefined,
      preorderEnabled: preorderEnabled === 'true' || preorderEnabled === true,
      preorderMessage: preorderMessage ? String(preorderMessage).trim() : '',
      customizesAllowed: customizesAllowed === 'true' || customizesAllowed === true,
      guidelineId: guidelineId && guidelineId !== 'null' && guidelineId !== '' ? guidelineId : null,
      showGuidelines: showGuidelines === 'true' || showGuidelines === true,
      fabricId: fabricId && fabricId !== 'null' && fabricId !== '' ? fabricId : null,
      sizeGuideType: ['predefined', 'custom'].includes(sizeGuideType) ? sizeGuideType : 'predefined',
      sizeGuideId: sizeGuideType === 'predefined' && sizeGuideId && sizeGuideId !== 'null' && sizeGuideId !== '' ? sizeGuideId : null,
      customSizeGuideUrl: sizeGuideType === 'custom' && customSizeGuideUrl ? String(customSizeGuideUrl).trim() : null,
      // Style Number for single products only
      styleNumber: productType !== 'variant' && styleNumber ? String(styleNumber).trim() : undefined,
      // Dimensions (L x W x H), weight, and stock type
      dimensionLength: dimensionLength ? String(dimensionLength).trim() : undefined,
      dimensionWidth: dimensionWidth ? String(dimensionWidth).trim() : undefined,
      dimensionHeight: dimensionHeight ? String(dimensionHeight).trim() : undefined,
      weight: weight ? String(weight).trim() : undefined,
      stockType: ['ready_to_ship', 'made_to_order'].includes(stockType) ? stockType : 'ready_to_ship',
      relatedProducts: parsedRelatedProducts,
    };

    // Add colorMedia to the document
    if (colorMedia && typeof colorMedia === 'object' && Object.keys(colorMedia).length > 0) {
      console.log('Adding colorMedia to document:', colorMedia);
      doc.colorMedia = colorMedia;
    }

    console.log('Final document before saving:', JSON.stringify(doc, null, 2));
    const created = await Product.create(doc);
    console.log('Created product with colorMedia:', created.colorMedia);
    return created;
  }
};

module.exports = createProductService;