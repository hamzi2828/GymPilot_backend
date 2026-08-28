// src/controller/storefrontController.js
//
// Read-only endpoints for the redesigned storefront: the product listing page
// (with its facets), the product detail payload, and the mega-menu tree.
//
// These sit alongside the legacy /api/public/products routes rather than
// replacing them, so the old pages keep working while the new UI rolls out.

const Product = require('../models/product');
const Category = require('../models/category');
const { toProductCard, colorsOf, sizesOf, imagesForColor, priceOf, colorMediaToObject } = require('../helper/productCard');

const PUBLISHED = { status: 'published', displayOn: { $ne: 'pos' } };

const lc = (v) => String(v || '').trim().toLowerCase();
const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.length ? v.split(',') : []).map((s) => String(s).trim()).filter(Boolean);

/** Sort spec by the key the PLP dropdown sends. */
function sortSpec(sort) {
  switch (sort) {
    case 'price-asc': return { price: 1 };
    case 'price-desc': return { price: -1 };
    case 'name-asc': return { name: 1 };
    case 'oldest': return { createdAt: 1 };
    case 'featured': return { featured: -1, createdAt: -1 };
    case 'newest':
    default: return { createdAt: -1 };
  }
}

/** Facet counts computed over the *unpaginated* match, so filters stay usable. */
function buildFacets(docs) {
  const colors = new Map();
  const sizes = new Map();
  const tags = new Map();
  const cats = new Map();
  let min = Infinity;
  let max = 0;

  docs.forEach((p) => {
    colorsOf(p).forEach((c) => {
      const key = c.name;
      const entry = colors.get(key) || { name: key, code: c.code, count: 0 };
      entry.count += 1;
      if (!entry.code && c.code) entry.code = c.code;
      colors.set(key, entry);
    });

    sizesOf(p).forEach((s) => {
      const entry = sizes.get(s.label) || { label: s.label, count: 0 };
      entry.count += 1;
      sizes.set(s.label, entry);
    });

    (p.tags || []).forEach((t) => {
      const entry = tags.get(t) || { name: t, count: 0 };
      entry.count += 1;
      tags.set(t, entry);
    });

    (p.categories || []).forEach((c) => {
      const entry = cats.get(c) || { slug: c, count: 0 };
      entry.count += 1;
      cats.set(c, entry);
    });

    const { effectivePrice } = priceOf(p);
    if (effectivePrice > 0) {
      min = Math.min(min, effectivePrice);
      max = Math.max(max, effectivePrice);
    }
  });

  return {
    colors: [...colors.values()].sort((a, b) => b.count - a.count),
    sizes: [...sizes.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    tags: [...tags.values()].sort((a, b) => b.count - a.count),
    categories: [...cats.values()].sort((a, b) => b.count - a.count),
    price: { min: Number.isFinite(min) ? Math.floor(min) : 0, max: Math.ceil(max) || 0 },
  };
}

const storefrontController = {
  /**
   * GET /api/public/storefront/products
   *
   * Query: category, categories, q, colors, sizes, tags, minPrice, maxPrice,
   *        onSale, inStock, sort, page, limit
   */
  async listProducts(req, res) {
    try {
      const {
        category,
        q,
        minPrice,
        maxPrice,
        onSale,
        inStock,
        sort = 'newest',
        page = 1,
        limit = 24,
      } = req.query;

      const categories = asArray(req.query.categories || category);
      const colorFilter = asArray(req.query.colors).map(lc);
      const sizeFilter = asArray(req.query.sizes).map(lc);
      const tagFilter = asArray(req.query.tags).map(lc);

      const match = { ...PUBLISHED };
      if (categories.length) match.categories = { $in: categories };
      if (q) {
        const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        match.$or = [{ name: rx }, { shortDescription: rx }, { tags: rx }];
      }
      if (String(onSale) === 'true') {
        match.$and = [
          ...(match.$and || []),
          {
            $or: [
              { discountedPrice: { $gt: 0 } },
              { websiteDiscountedPrice: { $gt: 0 } },
              { 'variants.discountedPrice': { $gt: 0 } },
            ],
          },
        ];
      }

      // Fetch the whole match once: facet counts need every document, and the
      // colour/size filters live inside the variants array where a plain
      // $match can't express "same variant, both conditions".
      const all = await Product.find(match).sort(sortSpec(sort)).lean();

      const filtered = all.filter((p) => {
        if (colorFilter.length) {
          const names = colorsOf(p).map((c) => lc(c.name));
          if (!colorFilter.some((c) => names.includes(c))) return false;
        }
        if (sizeFilter.length) {
          const labels = sizesOf(p).map((s) => lc(s.label));
          if (!sizeFilter.some((s) => labels.includes(s))) return false;
        }
        if (tagFilter.length) {
          const t = (p.tags || []).map(lc);
          if (!tagFilter.some((x) => t.includes(x))) return false;
        }
        const { effectivePrice } = priceOf(p);
        if (minPrice && effectivePrice < Number(minPrice)) return false;
        if (maxPrice && effectivePrice > Number(maxPrice)) return false;
        if (String(inStock) === 'true') {
          const stock = (p.variants || []).length
            ? p.variants.reduce((n, v) => n + (Number(v.stock) || 0), 0)
            : Number(p.stock) || 0;
          if (stock <= 0) return false;
        }
        return true;
      });

      const perPage = Math.min(Number(limit) || 24, 96);
      const currentPage = Math.max(Number(page) || 1, 1);
      const start = (currentPage - 1) * perPage;
      const pageDocs = filtered.slice(start, start + perPage);

      res.status(200).json({
        success: true,
        data: pageDocs.map((p) => toProductCard(p)).filter(Boolean),
        facets: buildFacets(all),
        total: filtered.length,
        count: pageDocs.length,
        page: currentPage,
        totalPages: Math.max(Math.ceil(filtered.length / perPage), 1),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * GET /api/public/storefront/products/:slug
   * Full PDP payload: gallery per colour, size matrix, related products.
   */
  async getProduct(req, res) {
    try {
      const product = await Product.findOne({ slug: lc(req.params.slug), ...PUBLISHED })
        .populate('fabricId', 'name description')
        .populate('sizeGuideId')
        .lean();

      if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

      const colors = colorsOf(product);
      const media = colorMediaToObject(product.colorMedia);

      // One gallery + one size row per colour, so switching colour on the PDP
      // needs no extra request.
      const galleries = {};
      const sizesByColor = {};
      (colors.length ? colors : [{ name: '__default__' }]).forEach((c) => {
        const key = c.name === '__default__' ? '__default__' : c.name;
        galleries[key] = imagesForColor(product, c.name === '__default__' ? null : c.name);
        sizesByColor[key] = sizesOf(product, c.name === '__default__' ? null : c.name);
      });

      const related = product.relatedProducts?.length
        ? await Product.find({ _id: { $in: product.relatedProducts }, ...PUBLISHED }).lean()
        : await Product.find({
            _id: { $ne: product._id },
            categories: { $in: product.categories || [] },
            ...PUBLISHED,
          })
            .sort({ createdAt: -1 })
            .limit(8)
            .lean();

      res.status(200).json({
        success: true,
        data: {
          ...toProductCard(product),
          description: product.description || '',
          features: product.features || '',
          fabric: product.fabricId || null,
          sizeGuide: product.sizeGuideId || null,
          customSizeGuideUrl: product.customSizeGuideUrl || null,
          sizeGuideType: product.sizeGuideType || 'predefined',
          styleNumber: product.styleNumber || null,
          weight: product.weight || null,
          dimensions: {
            length: product.dimensionLength || null,
            width: product.dimensionWidth || null,
            height: product.dimensionHeight || null,
          },
          stockType: product.stockType || 'ready_to_ship',
          preorderMessage: product.preorderMessage || '',
          customizesAllowed: !!product.customizesAllowed,
          metaTitle: product.metaTitle || '',
          metaDescription: product.metaDescription || '',
          galleries,
          sizesByColor,
          colorMedia: media,
          variants: (product.variants || []).map((v) => ({
            variantId: v.variantId || String(v._id || ''),
            color: v.color,
            colorCode: v.colorCode || null,
            size: v.size,
            price: Number(v.websitePrice ?? v.price) || 0,
            salePrice: Number(v.websiteDiscountedPrice ?? v.discountedPrice) || null,
            stock: Number(v.stock) || 0,
            sku: v.sku || null,
          })),
          related: related.map((p) => toProductCard(p)).filter(Boolean),
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  /**
   * GET /api/public/storefront/nav
   * Category tree + live product counts, shaped for the mega menu.
   */
  async getNav(req, res) {
    try {
      const [categories, counts] = await Promise.all([
        Category.find({ active: true }).sort({ featured: -1, name: 1 }).lean(),
        Product.aggregate([{ $match: PUBLISHED }, { $unwind: '$categories' }, { $group: { _id: '$categories', n: { $sum: 1 } } }]),
      ]);

      const countBySlug = new Map(counts.map((c) => [c._id, c.n]));
      const byId = new Map(categories.map((c) => [String(c._id), { ...c, count: countBySlug.get(c.slug) || 0, children: [] }]));

      const roots = [];
      byId.forEach((cat) => {
        const parent = cat.parentId ? byId.get(String(cat.parentId)) : null;
        if (parent) parent.children.push(cat);
        else roots.push(cat);
      });

      /**
       * A parent's total is the number of *distinct* products anywhere in its
       * subtree. Summing the children's counts double-counts: products are filed
       * under both their department and their type ("men" + "men-tshirts"), so
       * naive addition reported 203 for a department holding 103 products.
       */
      const slugsOf = (cat) => [cat.slug, ...cat.children.flatMap(slugsOf)];

      const withTotals = async (cat) => {
        await Promise.all(cat.children.map(withTotals));
        const slugs = [...new Set(slugsOf(cat).filter(Boolean))];
        cat.totalCount = slugs.length
          ? await Product.countDocuments({ categories: { $in: slugs }, ...PUBLISHED })
          : 0;
        return cat;
      };
      await Promise.all(roots.map(withTotals));

      res.status(200).json({ success: true, data: roots });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
};

module.exports = storefrontController;
