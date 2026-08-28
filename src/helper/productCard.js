// src/helper/productCard.js
//
// Single mapper from a Product document to the payload the storefront product
// card needs. The card renders a hover image swap, in-tile gallery arrows,
// colour dots and a quick-add size row, so it needs more than the legacy
// `ShopProduct` shape gave it — but it must stay small enough to send 48 of
// them in one response.

/** Tags that render as the chip in the top-left of a product tile. */
const BADGE_TAGS = ['new drop', 'new', 'bestseller', 'back in stock', 'limited', 'sale'];

/** Tags that render as the small grey fit label on the PDP / quick add. */
const FIT_TAGS = ['athletic fit', 'regular fit', 'relaxed fit', 'oversized fit', 'compression fit', 'crew cut'];

const lc = (v) => String(v || '').trim().toLowerCase();
const titleCase = (v) => String(v || '').replace(/\b\w/g, (c) => c.toUpperCase());

/** colorMedia is a Map in mongoose and a plain object once .lean()'d. */
function colorMediaToObject(colorMedia) {
  if (!colorMedia) return {};
  if (colorMedia instanceof Map) return Object.fromEntries(colorMedia);
  if (typeof colorMedia === 'object') return colorMedia;
  return {};
}

/**
 * Gallery for one colour: its banners first, then its thumbnail, falling back
 * to the product-level media for single products.
 */
function imagesForColor(product, color) {
  const media = colorMediaToObject(product.colorMedia);
  const entry = color ? media[color] : null;
  const out = [];
  if (entry) {
    if (entry.thumbnailUrl) out.push(entry.thumbnailUrl);
    (entry.bannerUrls || []).forEach((u) => u && out.push(u));
  }
  if (!out.length) {
    if (product.thumbnailUrl) out.push(product.thumbnailUrl);
    (product.bannerUrls || []).forEach((u) => u && out.push(u));
  }
  return [...new Set(out.filter(Boolean))];
}

/** Lowest sellable price across the product and its variants. */
function priceOf(product) {
  const candidates = [];
  const push = (regular, sale) => {
    const r = Number(regular);
    const s = Number(sale);
    if (Number.isFinite(r) && r > 0) {
      candidates.push({ price: r, sale: Number.isFinite(s) && s > 0 && s < r ? s : null });
    }
  };

  push(product.websitePrice ?? product.price, product.websiteDiscountedPrice ?? product.discountedPrice);
  (product.variants || []).forEach((v) => push(v.websitePrice ?? v.price, v.websiteDiscountedPrice ?? v.discountedPrice));

  if (!candidates.length) return { price: 0, salePrice: null, effectivePrice: 0, isOnSale: false, discountPercentage: 0 };

  // Pick the cheapest *effective* price so the card shows the entry price.
  const best = candidates.reduce((a, b) => ((b.sale ?? b.price) < (a.sale ?? a.price) ? b : a));
  const effectivePrice = best.sale ?? best.price;
  const isOnSale = best.sale != null;

  return {
    price: best.price,
    salePrice: best.sale,
    effectivePrice,
    isOnSale,
    discountPercentage: isOnSale ? Math.round(((best.price - best.sale) / best.price) * 100) : 0,
  };
}

/** Distinct colours in variant order, each with its own hero image. */
function colorsOf(product) {
  const media = colorMediaToObject(product.colorMedia);
  const seen = new Map();

  (product.variants || []).forEach((v) => {
    const name = String(v.color || '').trim();
    if (!name || seen.has(lc(name))) return;
    seen.set(lc(name), {
      name,
      code: v.colorCode || null,
      thumbnail: media[name]?.thumbnailUrl || product.thumbnailUrl || null,
      inStock: false,
    });
  });

  // Mark stock per colour.
  (product.variants || []).forEach((v) => {
    const entry = seen.get(lc(v.color));
    if (entry && Number(v.stock) > 0) entry.inStock = true;
  });

  // Colours that only exist in colorMedia (media uploaded before variants).
  Object.keys(media).forEach((name) => {
    if (!seen.has(lc(name))) {
      seen.set(lc(name), { name, code: null, thumbnail: media[name]?.thumbnailUrl || null, inStock: true });
    }
  });

  return [...seen.values()];
}

/** Sizes for one colour (or across the product when no colour is given). */
function sizesOf(product, color) {
  const out = new Map();
  (product.variants || [])
    .filter((v) => !color || lc(v.color) === lc(color))
    .forEach((v) => {
      const label = String(v.size || '').trim();
      if (!label) return;
      const prev = out.get(label);
      const inStock = Number(v.stock) > 0;
      if (!prev) {
        out.set(label, {
          label,
          inStock,
          variantId: v.variantId || String(v._id || ''),
          price: Number(v.websitePrice ?? v.price) || 0,
          salePrice: Number(v.websiteDiscountedPrice ?? v.discountedPrice) || null,
        });
      } else if (inStock) {
        prev.inStock = true;
      }
    });

  if (!out.size && product.productType !== 'variant') {
    out.set('ONE SIZE', { label: 'ONE SIZE', inStock: Number(product.stock) > 0, variantId: null, price: Number(product.price) || 0, salePrice: null });
  }
  return [...out.values()];
}

/** First matching tag from a list, presented for display. */
function pickTag(tags, pool) {
  const found = (tags || []).find((t) => pool.includes(lc(t)));
  return found ? String(found).toUpperCase() : null;
}

/**
 * Map a Product (document or lean object) to the storefront card payload.
 * @param {object} product
 * @param {{ color?: string }} [opts] pre-select a colour (used by PLP colour filters)
 */
function toProductCard(product, opts = {}) {
  if (!product) return null;

  const colors = colorsOf(product);
  const activeColor = opts.color && colors.find((c) => lc(c.name) === lc(opts.color)) ? opts.color : colors[0]?.name || null;
  const images = imagesForColor(product, activeColor);
  const pricing = priceOf(product);

  const totalStock = (product.variants || []).length
    ? (product.variants || []).reduce((n, v) => n + (Number(v.stock) || 0), 0)
    : Number(product.stock) || 0;

  return {
    _id: String(product._id),
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription || '',

    ...pricing,

    thumbnail: images[0] || null,
    hoverImage: images[1] || null,
    images,

    badge: pickTag(product.tags, BADGE_TAGS),
    fitLabel: pickTag(product.tags, FIT_TAGS) || (product.styleNumber ? null : null),
    tags: product.tags || [],

    inStock: totalStock > 0,
    stock: totalStock,
    preorderEnabled: !!product.preorderEnabled,

    productType: product.productType || 'single',
    activeColor,
    colors,
    sizes: sizesOf(product, activeColor),

    categories: product.categories || [],
    createdAt: product.createdAt,
  };
}

module.exports = {
  toProductCard,
  imagesForColor,
  colorsOf,
  sizesOf,
  priceOf,
  colorMediaToObject,
  titleCase,
  BADGE_TAGS,
  FIT_TAGS,
};
