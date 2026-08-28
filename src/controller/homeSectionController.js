// src/controller/homeSectionController.js
//
// Admin CRUD for homepage blocks + the single public endpoint the storefront
// homepage calls. The public endpoint hydrates each block's products so the
// homepage renders from one request instead of one request per section.

const HomeSection = require('../models/homeSection');
const Product = require('../models/product');
const { toProductCard } = require('../helper/productCard');

const PUBLISHED = { status: 'published', displayOn: { $ne: 'pos' } };

/** Resolve the products for one section according to its `source`. */
async function resolveProducts(section) {
  const needsProducts = ['product_rail', 'product_grid', 'mosaic'].includes(section.type);
  if (!needsProducts) return [];

  const limit = Math.min(Number(section.limit) || 12, 48);

  switch (section.source) {
    case 'manual': {
      const ids = (section.productIds || []).map(String);
      if (!ids.length) return [];
      const docs = await Product.find({ _id: { $in: ids }, ...PUBLISHED }).lean();
      // Preserve the admin's hand-picked order.
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      return ids.map((id) => byId.get(id)).filter(Boolean);
    }

    case 'category': {
      if (!section.categorySlug) return [];
      return Product.find({ categories: section.categorySlug, ...PUBLISHED })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    }

    case 'featured':
      return Product.find({ featured: true, ...PUBLISHED }).sort({ createdAt: -1 }).limit(limit).lean();

    case 'sale':
      return Product.find({
        ...PUBLISHED,
        $or: [
          { discountedPrice: { $gt: 0 } },
          { websiteDiscountedPrice: { $gt: 0 } },
          { 'variants.discountedPrice': { $gt: 0 } },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    case 'tag':
      if (!section.tag) return [];
      return Product.find({ tags: section.tag, ...PUBLISHED }).sort({ createdAt: -1 }).limit(limit).lean();

    case 'latest':
    default:
      return Product.find(PUBLISHED).sort({ createdAt: -1 }).limit(limit).lean();
  }
}

/** Drop inactive tiles and sort what's left. */
function normaliseTiles(section) {
  return (section.tiles || [])
    .filter((t) => t.isActive !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

const homeSectionController = {
  // ---------------------------------------------------------------- public

  /** GET /api/public/home-sections — the whole homepage in one payload. */
  async getPublicSections(req, res) {
    try {
      const sections = await HomeSection.getActiveSections();

      const hydrated = await Promise.all(
        sections.map(async (section) => {
          const products = await resolveProducts(section);
          return {
            ...section,
            tiles: normaliseTiles(section),
            products: products.map((p) => toProductCard(p)).filter(Boolean),
          };
        })
      );

      res.status(200).json({ success: true, data: hydrated, count: hydrated.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  // ----------------------------------------------------------------- admin

  /** GET /home-sections */
  async getAll(req, res) {
    try {
      const sections = await HomeSection.find({}).sort({ order: 1, createdAt: 1 }).lean();
      res.status(200).json({ success: true, data: sections, count: sections.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /** GET /home-sections/:id */
  async getById(req, res) {
    try {
      const section = await HomeSection.findById(req.params.id).lean();
      if (!section) return res.status(404).json({ success: false, error: 'Section not found' });
      res.status(200).json({ success: true, data: section });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /** POST /home-sections */
  async create(req, res) {
    try {
      const payload = { ...req.body };
      if (!payload.key) {
        payload.key = String(payload.title || payload.type || 'section')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .concat('-', Date.now().toString(36));
      }
      const section = await HomeSection.create(payload);
      res.status(201).json({ success: true, data: section, message: 'Section created' });
    } catch (error) {
      const status = error.code === 11000 ? 409 : 400;
      res.status(status).json({
        success: false,
        error: error.code === 11000 ? 'A section with that key already exists' : error.message,
      });
    }
  },

  /** PUT /home-sections/:id */
  async update(req, res) {
    try {
      const section = await HomeSection.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });
      if (!section) return res.status(404).json({ success: false, error: 'Section not found' });
      res.status(200).json({ success: true, data: section, message: 'Section updated' });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  },

  /** PATCH /home-sections/:id/status */
  async toggleStatus(req, res) {
    try {
      const section = await HomeSection.findById(req.params.id);
      if (!section) return res.status(404).json({ success: false, error: 'Section not found' });
      section.isActive = typeof req.body.isActive === 'boolean' ? req.body.isActive : !section.isActive;
      await section.save();
      res.status(200).json({ success: true, data: section });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  },

  /** PATCH /home-sections/reorder — body: { order: [id, id, ...] } */
  async reorder(req, res) {
    try {
      const ids = Array.isArray(req.body.order) ? req.body.order : [];
      await Promise.all(ids.map((id, i) => HomeSection.findByIdAndUpdate(id, { order: i + 1 })));
      const sections = await HomeSection.find({}).sort({ order: 1 }).lean();
      res.status(200).json({ success: true, data: sections });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  },

  /** DELETE /home-sections/:id */
  async remove(req, res) {
    try {
      const section = await HomeSection.findByIdAndDelete(req.params.id);
      if (!section) return res.status(404).json({ success: false, error: 'Section not found' });
      res.status(200).json({ success: true, message: 'Section deleted' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
};

module.exports = homeSectionController;
