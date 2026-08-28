// src/model/product.js

const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema(
  {
    variantId: { type: String, required: true, unique: false, trim: true }, // Custom unique ID for variant
    color: { type: String, required: true, trim: true },
    colorCode: { type: String, trim: true, default: undefined }, // Hex color code
    size: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    websitePrice: { type: Number, min: 0, default: undefined },
    stock: { type: Number, required: true, min: 0 },
    sku: { type: String, trim: true, default: undefined },
    discountedPrice: { type: Number, min: 0, default: undefined },
    websiteDiscountedPrice: { type: Number, min: 0, default: undefined },
    styleNumber: { type: String, trim: true, default: undefined },
  },
  { _id: true } // Enable MongoDB _id for variants
);

const colorMediaSchema = new mongoose.Schema(
  {
    thumbnailUrl: { type: String, trim: true, default: undefined },
    bannerUrls: { type: [String], default: [] },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    categories: { type: [String], default: [] }, // Multiple categories support
    fabricId: { type: mongoose.Schema.Types.ObjectId, ref: 'Fabric', default: null },
    sizeGuideType: { type: String, enum: ['predefined', 'custom'], default: 'predefined' },
    sizeGuideId: { type: mongoose.Schema.Types.ObjectId, ref: 'SizeGuide', default: null },
    customSizeGuideUrl: { type: String, trim: true, default: null },
    price: { type: Number, required: true, min: 0 },
    websitePrice: { type: Number, min: 0, default: undefined },
    discountedPrice: { type: Number, min: 0, default: undefined },
    websiteDiscountedPrice: { type: Number, min: 0, default: undefined },
    stock: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['published', 'draft', 'out_of_stock'], default: 'draft', index: true },
    featured: { type: Boolean, default: false, index: true },

    // Global media (hidden in variant mode on UI but kept here for compatibility)
    thumbnailUrl: { type: String, trim: true, default: undefined },
    bannerUrls: { type: [String], default: [] },

    productType: { type: String, enum: ['single', 'variant'], default: 'single', index: true },
    displayOn: { type: String, enum: ['website', 'pos', 'both'], default: 'both', index: true },
    variants: { type: [variantSchema], default: [] },

    // Optional future use: media per color
    colorMedia: {
      type: Map,
      of: colorMediaSchema,
      default: undefined,
    },

    // Description fields
    description: { type: String, trim: true, default: undefined },
    shortDescription: { type: String, trim: true, maxLength: 500, default: undefined },
    features: { type: String, trim: true, default: undefined },

    // Tags
    tags: { type: [String], default: [] },

    // SEO fields
    metaTitle: { type: String, trim: true, maxLength: 120, default: undefined },
    metaDescription: { type: String, trim: true, maxLength: 320, default: undefined },
    metaKeywords: { type: String, trim: true, default: undefined },
    metaSchema: { type: String, trim: true, default: undefined },

    // Preorder fields
    preorderEnabled: { type: Boolean, default: false, index: true },
    preorderMessage: { type: String, trim: true, default: '' },

    // Customization field
    customizesAllowed: { type: Boolean, default: false, index: true },
    guidelineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Guideline', default: null },
    showGuidelines: { type: Boolean, default: false },

    // Style Number for single products
    styleNumber: { type: String, trim: true, default: undefined },

    // Dimensions (L x W x H) and weight
    dimensionLength: { type: String, trim: true, default: undefined },
    dimensionWidth: { type: String, trim: true, default: undefined },
    dimensionHeight: { type: String, trim: true, default: undefined },
    weight: { type: String, trim: true, default: undefined },

    // Stock type
    stockType: { type: String, enum: ['ready_to_ship', 'made_to_order'], default: 'ready_to_ship', index: true },

    // Related products
    relatedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  },
  { timestamps: true }
);

// Ensure formatting on save
productSchema.pre('save', function (next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.name = String(this.name).trim();
  }
  if (this.isModified('slug') && typeof this.slug === 'string') {
    this.slug = String(this.slug).trim().toLowerCase();
  }
  next();
});

// Simple length validator for banners
productSchema.path('bannerUrls').validate(function (value) {
  return !value || value.length <= 5;
}, 'You can upload up to 5 banner images');

// Delete cached model to ensure schema updates are applied
if (mongoose.models.Product) {
  delete mongoose.models.Product;
}

module.exports = mongoose.model('Product', productSchema);
