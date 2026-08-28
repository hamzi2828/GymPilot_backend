// src/models/homeSection.js
//
// One document == one block on the storefront homepage. The admin reorders,
// toggles and edits these, so the homepage has no hard-coded content.
//
// `type` picks the renderer on the frontend; `source` decides where a block's
// products come from, and `tiles` holds the editorial media (hero slides,
// category banners, UGC posts, info cards). A single flexible shape keeps the
// admin to one screen instead of one screen per section type.

const mongoose = require('mongoose');

/** A call-to-action rendered as a chip over media. */
const ctaSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, required: true },
    href: { type: String, trim: true, default: '/products' },
    // 'light'  -> white chip (default over photography)
    // 'accent' -> lime chip, for the single loudest CTA in a view
    // 'ghost'  -> transparent with a white hairline border
    variant: { type: String, enum: ['light', 'accent', 'ghost', 'ink'], default: 'light' },
  },
  { _id: false }
);

/**
 * A media tile. Used by every editorial block:
 *   hero              -> one tile per slide
 *   banner_grid       -> one tile per cell (2x2)
 *   collection_strip  -> one tile per column (3-up)
 *   mosaic            -> the tall sticky media panel
 *   ugc_rail          -> one tile per social post
 *   info_cards        -> one tile per card
 */
const tileSchema = new mongoose.Schema(
  {
    eyebrow: { type: String, trim: true, default: '' }, // renders as "// NEW DROP"
    title: { type: String, trim: true, default: '' },
    subtitle: { type: String, trim: true, default: '' },
    body: { type: String, trim: true, default: '' }, // info_cards paragraph

    imageUrl: { type: String, trim: true, default: '' },
    mobileImageUrl: { type: String, trim: true, default: '' },
    videoUrl: { type: String, trim: true, default: '' }, // autoplay/muted/loop when set

    href: { type: String, trim: true, default: '' }, // whole-tile link
    ctas: { type: [ctaSchema], default: [] },

    // Layout hints honoured by the grid renderers.
    colSpan: { type: Number, min: 1, max: 4, default: 1 },
    rowSpan: { type: Number, min: 1, max: 4, default: 1 },
    align: { type: String, enum: ['left', 'center', 'right'], default: 'left' },
    valign: { type: String, enum: ['top', 'center', 'bottom'], default: 'bottom' },
    theme: { type: String, enum: ['light', 'dark'], default: 'light' }, // text colour over media
    scrim: { type: Boolean, default: true }, // dark gradient behind the text

    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

const homeSectionSchema = new mongoose.Schema(
  {
    // Stable identifier so the frontend can special-case a block if it ever
    // needs to (e.g. render the hero above the header).
    key: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },

    // Heading shown above the block. Blank = no heading (hero, banner grids).
    title: { type: String, trim: true, default: '' },
    subtitle: { type: String, trim: true, default: '' },

    type: {
      type: String,
      required: true,
      enum: [
        'hero',             // full-viewport slider
        'product_rail',     // horizontal product carousel  (TOP PICKS)
        'product_grid',     // plain responsive product grid
        'mosaic',           // product columns + tall sticky media panel
        'banner_grid',      // 2x2 category banners
        'collection_strip', // 3-up short banners
        'ugc_rail',         // social/community image carousel
        'info_cards',       // text-block-over-image cards
      ],
      index: true,
    },

    // ---- where the products come from (product_rail / product_grid / mosaic)
    source: {
      type: String,
      enum: ['manual', 'category', 'featured', 'latest', 'sale', 'tag'],
      default: 'latest',
    },
    categorySlug: { type: String, trim: true, default: '' },
    tag: { type: String, trim: true, default: '' },
    limit: { type: Number, min: 1, max: 48, default: 12 },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],

    // ---- editorial media
    tiles: { type: [tileSchema], default: [] },

    // ---- renderer options
    options: {
      // mosaic: which side the tall media panel sits on, and how many product
      // columns run beside it.
      mediaSide: { type: String, enum: ['left', 'right'], default: 'right' },
      productColumns: { type: Number, min: 1, max: 3, default: 2 },
      // grids
      columns: { type: Number, min: 2, max: 6, default: 4 },
      // banner tiles
      aspect: { type: String, trim: true, default: '4/5' }, // CSS aspect-ratio
      // section chrome
      background: { type: String, enum: ['paper', 'white', 'ink'], default: 'paper' },
      fullBleed: { type: Boolean, default: false }, // ignore page gutters
      showArrows: { type: Boolean, default: true },
      showViewAll: { type: Boolean, default: false },
      viewAllHref: { type: String, trim: true, default: '/products' },
    },

    isActive: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

homeSectionSchema.index({ isActive: 1, order: 1 });

/** Active sections, in render order, with their tiles pre-sorted. */
homeSectionSchema.statics.getActiveSections = function () {
  return this.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).lean();
};

// Auto-append new sections to the end of the list.
homeSectionSchema.pre('save', async function (next) {
  if (this.isNew && !this.order) {
    const last = await this.constructor.findOne({}).sort({ order: -1 }).select('order').lean();
    this.order = last ? last.order + 1 : 1;
  }
  next();
});

module.exports = mongoose.models.HomeSection || mongoose.model('HomeSection', homeSectionSchema);
