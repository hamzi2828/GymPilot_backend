// src/model/category.js

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    description: { type: String, default: '', trim: true },
    thumbnailUrl: { type: String, default: null },
    bannerUrl: { type: String, default: null },
    active: { type: Boolean, default: true },
    featured: { type: Boolean, default: false },
    // Show in "Shop by Collections" section on homepage
    showInCollections: { type: Boolean, default: false },
    // Shipping cost for this category
    shippingCost: { type: Number, default: 0, min: 0 },
    // Estimated delivery days for this category
    estimatedDays: { type: String, default: '', trim: true },
    // Parent category reference for subcategories
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    // Measurements required for this category
    measurements: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Measurement' }],
    // Size guide images for this category
    sizeChartRegularCm: { type: String, default: null },
    sizeChartRegularInch: { type: String, default: null },
    sizeChartRelaxedCm: { type: String, default: null },
    sizeChartRelaxedInch: { type: String, default: null },
    measuringTipImage: { type: String, default: null },
    // SEO content rendered above the products grid (intro) and below it (footer).
    // Stored as HTML so the admin can use a rich editor; rendered server-side so
    // crawlers see the text in the initial response (fixes low text-HTML ratio).
    seoIntroTitle: { type: String, default: '', trim: true },
    seoIntroBody: { type: String, default: '' },
    seoFooterBody: { type: String, default: '' },
    seoFaqs: [
      {
        _id: false,
        question: { type: String, trim: true },
        answer: { type: String, trim: true },
      },
    ],
    metaTitle: { type: String, default: '', trim: true, maxLength: 160 },
    metaDescription: { type: String, default: '', trim: true, maxLength: 320 },
    metaKeywords: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

// Virtual for getting child categories
categorySchema.virtual('children', {
  ref: 'Category',
  localField: '_id',
  foreignField: 'parentId',
});

// Ensure virtuals are included in JSON output
categorySchema.set('toJSON', { virtuals: true });
categorySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Category', categorySchema);
