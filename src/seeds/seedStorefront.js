// src/seeds/seedStorefront.js
//
// Seeds the storefront: category tree, colours, sizes, a realistic product
// catalogue, and the homepage blocks that drive the new UI.
//
//   node src/seeds/seedStorefront.js            # seed (skips existing)
//   node src/seeds/seedStorefront.js --reset    # wipe products/categories first
//   node src/seeds/seedStorefront.js --sections # homepage blocks only
//
// Products are grouped by style: the reference lists one entry per colourway,
// so "Ultralight Gym T-shirt - Chestnut" and "... - Navy" collapse into one
// variant product with a colour swatch each, which is what the PDP expects.

require('dotenv').config();
const mongoose = require('mongoose');

const Product = require('../models/product');
const Category = require('../models/category');
const Color = require('../models/color');
const Size = require('../models/size');
const HomeSection = require('../models/homeSection');
const { harvest } = require('./lib/harvestReference');

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const SECTIONS_ONLY = args.includes('--sections');

// ---------------------------------------------------------------------------
// Category tree
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { slug: 'men', name: 'Men', featured: true, showInCollections: true,
    description: 'Training kit built for the work — tees, shorts, joggers and layers that move the way you do.' },
  { slug: 'men-tshirts', name: 'T-Shirts', parent: 'men' },
  { slug: 'men-shorts', name: 'Shorts', parent: 'men' },
  { slug: 'men-joggers', name: 'Joggers & Pants', parent: 'men' },
  { slug: 'men-hoodies', name: 'Hoodies & Jackets', parent: 'men' },
  { slug: 'men-tanks', name: 'Stringers & Tanks', parent: 'men' },
  { slug: 'men-sets', name: 'Sets', parent: 'men' },

  { slug: 'women', name: 'Women', featured: true, showInCollections: true,
    description: 'Leggings, bras and layers engineered for support, shape and the long session.' },
  { slug: 'women-leggings', name: 'Leggings', parent: 'women' },
  { slug: 'women-bras', name: 'Sports Bras', parent: 'women' },
  { slug: 'women-tops', name: 'Tops & T-Shirts', parent: 'women' },
  { slug: 'women-shorts', name: 'Shorts', parent: 'women' },
  { slug: 'women-hoodies', name: 'Hoodies & Jackets', parent: 'women' },
  { slug: 'women-sets', name: 'Sets', parent: 'women' },

  { slug: 'accessories', name: 'Accessories', featured: true, showInCollections: true,
    description: 'Bags, socks, caps and the small stuff that finishes the kit.' },
  { slug: 'bags', name: 'Bags & Backpacks', parent: 'accessories' },
  { slug: 'socks', name: 'Socks', parent: 'accessories' },
  { slug: 'headwear', name: 'Headwear', parent: 'accessories' },

  { slug: 'new-arrivals', name: 'New Arrivals', featured: true },
  { slug: 'bestsellers', name: 'Bestsellers', featured: true },
  { slug: 'sale', name: 'Sale', featured: true },
];

/** Reference collection -> local category slugs. */
const COLLECTION_MAP = {
  'gym-wear-men': ['men'],
  'gym-tshirts-men': ['men', 'men-tshirts'],
  'gym-shorts-men': ['men', 'men-shorts'],
  'gym-pants-men': ['men', 'men-joggers'],
  'gym-hoodies-men': ['men', 'men-hoodies'],
  'gym-stringers-tanks': ['men', 'men-tanks'],
  'men-sets': ['men', 'men-sets'],
  'workout-clothes-women': ['women'],
  'workout-leggings-women': ['women', 'women-leggings'],
  'sports-bras': ['women', 'women-bras'],
  'workout-tops-women': ['women', 'women-tops'],
  'gym-shorts-women': ['women', 'women-shorts'],
  'gym-hoodies-women': ['women', 'women-hoodies'],
  accessories: ['accessories'],
};

// ---------------------------------------------------------------------------
// Colour / size reference data
// ---------------------------------------------------------------------------

/** Hex codes for the colourway names that come back from the reference. */
const COLOR_HEX = {
  black: '#111111', white: '#FFFFFF', 'pearl white': '#F4F2ED', navy: '#1B2537',
  chestnut: '#7A4A34', grey: '#8A8A8E', 'grey marl': '#9B9B9F', charcoal: '#3A3A3D',
  sleet: '#B7BFC6', 'moon rock': '#B3A899', pacific: '#1E6F63', teal: '#177A72',
  olive: '#5A6247', khaki: '#8E8465', sand: '#D6C7AE', beige: '#DCCEB8',
  stone: '#C9C1B4', cream: '#EFE7D8', burgundy: '#5C1F27', 'fired brick': '#8A3324',
  maroon: '#6B2029', red: '#B4231F', rust: '#9C4A24', mocha: '#6F5545',
  'arctic marl': '#D3DBDD', 'starlight blue': '#A9C6D6', blue: '#2A4C8F',
  lilac: '#9C8FBF', pink: '#D9A0AC', mauve: '#A67E86', purple: '#57407A',
  green: '#2F6B3C', 'forest green': '#25452F', lime: '#BEE304', mint: '#B7D8C6',
  yellow: '#E0B93C', orange: '#C9611F', brown: '#5C4433', taupe: '#9A8B7C',
  ivory: '#F2ECE0', silver: '#C9CDD2', 'frosted geometry sleet': '#B7BFC6',
};

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', 'ONE SIZE'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const lc = (v) => String(v || '').trim().toLowerCase();
const slugify = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function hexFor(colorName) {
  const key = lc(colorName);
  if (COLOR_HEX[key]) return COLOR_HEX[key];
  // Fall back to the closest single word, e.g. "Deep Navy" -> navy.
  const word = key.split(/\s+/).reverse().find((w) => COLOR_HEX[w]);
  return word ? COLOR_HEX[word] : '#8A8A8E';
}

/** Split "Alpha T-shirt - Frosted Geometry Sleet" into style + colourway. */
function splitTitle(title) {
  const idx = String(title).lastIndexOf(' - ');
  if (idx < 0) return { style: String(title).trim(), color: 'Black' };
  return { style: title.slice(0, idx).trim(), color: title.slice(idx + 3).trim() };
}

/** Map the reference's productType onto our subcategory slugs. */
function categoriesForType(productType, existing) {
  const t = lc(productType);
  const extra = [];
  const add = (...slugs) => slugs.forEach((s) => extra.push(s));

  if (/t-?shirt|tee/.test(t)) existing.includes('women') ? add('women-tops') : add('men-tshirts');
  else if (/short/.test(t)) existing.includes('women') ? add('women-shorts') : add('men-shorts');
  else if (/jogger|pant|trouser/.test(t)) existing.includes('women') ? add('women-leggings') : add('men-joggers');
  else if (/hoodie|jacket|sweat|zip/.test(t)) existing.includes('women') ? add('women-hoodies') : add('men-hoodies');
  else if (/legging|tight/.test(t)) add('women', 'women-leggings');
  else if (/bra|brami/.test(t)) add('women', 'women-bras');
  else if (/stringer|tank|vest/.test(t)) add('men', 'men-tanks');
  else if (/sock/.test(t)) add('accessories', 'socks');
  else if (/bag|backpack|duffle/.test(t)) add('accessories', 'bags');
  else if (/cap|hat|beanie|headband/.test(t)) add('accessories', 'headwear');
  else if (/set/.test(t)) existing.includes('women') ? add('women-sets') : add('men-sets');

  return [...new Set([...existing, ...extra])];
}

/** Deterministic pseudo-random so repeated seeds produce the same store. */
function seededRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

async function seedCategories() {
  console.log('\n▸ Categories');
  const idBySlug = new Map();

  // Parents first so children can reference them.
  for (const pass of [0, 1]) {
    for (const c of CATEGORIES) {
      if ((pass === 0) !== !c.parent) continue;

      const doc = {
        name: c.name,
        slug: c.slug,
        description: c.description || '',
        active: true,
        featured: !!c.featured,
        showInCollections: !!c.showInCollections,
        parentId: c.parent ? idBySlug.get(c.parent) || null : null,
        metaTitle: `${c.name} | The Jymor`,
        metaDescription: c.description || `Shop ${c.name.toLowerCase()} at The Jymor.`,
      };

      const saved = await Category.findOneAndUpdate({ slug: c.slug }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
      idBySlug.set(c.slug, saved._id);
    }
  }

  console.log(`  ${idBySlug.size} categories`);
  return idBySlug;
}

async function seedColorsAndSizes(products) {
  console.log('\n▸ Colours & sizes');

  const colors = new Map();
  const sizes = new Set();
  products.forEach((p) => {
    p.variants.forEach((v) => {
      if (v.color) colors.set(lc(v.color), v.color);
      if (v.size) sizes.add(v.size);
    });
  });

  for (const name of colors.values()) {
    await Color.findOneAndUpdate(
      { slug: slugify(name) },
      { name, slug: slugify(name), hex: hexFor(name), active: true },
      { upsert: true, setDefaultsOnInsert: true }
    ).catch((e) => console.warn(`  ! colour ${name}: ${e.message}`));
  }

  const ordered = [...sizes].sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a.toUpperCase());
    const bi = SIZE_ORDER.indexOf(b.toUpperCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  for (const name of ordered) {
    await Size.findOneAndUpdate(
      { slug: slugify(name) },
      { name, slug: slugify(name), active: true },
      { upsert: true, setDefaultsOnInsert: true }
    ).catch((e) => console.warn(`  ! size ${name}: ${e.message}`));
  }

  console.log(`  ${colors.size} colours, ${ordered.length} sizes`);
}

/** Group reference entries into variant products, one per style. */
function buildProducts(reference) {
  const styles = new Map();

  reference.forEach((ref) => {
    const { style, color } = splitTitle(ref.title);
    const key = slugify(style);
    if (!key) return;

    const entry = styles.get(key) || {
      style,
      slug: key,
      productType: ref.productType,
      fit: ref.fit,
      description: ref.description,
      tags: new Set(),
      categories: new Set(),
      price: ref.price,
      compareAt: ref.compareAt,
      colorways: [],
    };

    entry.price = Math.min(entry.price || ref.price, ref.price || entry.price);
    if (ref.compareAt > (entry.compareAt || 0)) entry.compareAt = ref.compareAt;
    if (!entry.description && ref.description) entry.description = ref.description;
    if (!entry.fit && ref.fit) entry.fit = ref.fit;

    ref.tags
      .filter((t) => !/^(all|aw\d+|kndexclude|men all|women all|color:|fit:)/i.test(t))
      .forEach((t) => entry.tags.add(t));
    ref.categories.forEach((c) => entry.categories.add(c));

    entry.colorways.push({
      color,
      sizes: ref.sizes.length ? ref.sizes : ['ONE SIZE'],
      images: ref.images,
      inventory: ref.inventory,
      price: ref.price,
      compareAt: ref.compareAt,
    });

    styles.set(key, entry);
  });

  // Turn each style into a Product document.
  return [...styles.values()].map((entry, index) => {
    const categories = categoriesForType(entry.productType, [...entry.categories]);

    // A tenth of the catalogue carries a genuine markdown so the sale views,
    // strike-through pricing and SALE badge all have something to show.
    const onSale = seededRandom(entry.slug) < 0.22;
    const discountPct = onSale ? [10, 15, 20, 25, 30][Math.floor(seededRandom(entry.slug + 'd') * 5)] : 0;

    const variants = [];
    const colorMedia = {};

    entry.colorways.forEach((cw) => {
      const images = cw.images.filter(Boolean);
      if (images.length) {
        colorMedia[cw.color] = { thumbnailUrl: images[0], bannerUrls: images.slice(1, 5) };
      }

      cw.sizes.forEach((size, si) => {
        const price = cw.price || entry.price || 0;
        const rnd = seededRandom(`${entry.slug}-${cw.color}-${size}`);
        // Roughly one variant in fourteen is sold out, so the crossed-out size
        // state is exercised in the UI.
        const stock = rnd < 0.07 ? 0 : Math.max(3, Math.round(rnd * 40) + 4);

        variants.push({
          variantId: `${entry.slug}-${slugify(cw.color)}-${slugify(size)}`,
          color: cw.color,
          colorCode: hexFor(cw.color),
          size,
          price,
          websitePrice: price,
          stock,
          sku: `JY-${entry.slug.slice(0, 10).toUpperCase()}-${slugify(cw.color).slice(0, 4).toUpperCase()}-${size}`.replace(/--+/g, '-'),
          ...(discountPct
            ? {
                discountedPrice: Math.round((price * (100 - discountPct)) / 100),
                websiteDiscountedPrice: Math.round((price * (100 - discountPct)) / 100),
              }
            : {}),
        });
        void si;
      });
    });

    const tags = [...entry.tags];
    if (entry.fit) tags.unshift(entry.fit);
    if (index < 14) tags.unshift('NEW DROP');
    else if (seededRandom(entry.slug + 'b') > 0.82) tags.unshift('BESTSELLER');
    if (discountPct) tags.push('SALE');

    const heroImages = entry.colorways[0]?.images || [];
    const basePrice = entry.price || variants[0]?.price || 0;

    return {
      name: entry.style,
      slug: entry.slug,
      categories: [...new Set([...categories, ...(index < 14 ? ['new-arrivals'] : []), ...(discountPct ? ['sale'] : [])])],
      price: basePrice,
      websitePrice: basePrice,
      ...(discountPct
        ? {
            discountedPrice: Math.round((basePrice * (100 - discountPct)) / 100),
            websiteDiscountedPrice: Math.round((basePrice * (100 - discountPct)) / 100),
          }
        : {}),
      stock: variants.reduce((n, v) => n + v.stock, 0),
      status: 'published',
      featured: index < 10 || seededRandom(entry.slug + 'f') > 0.86,
      thumbnailUrl: heroImages[0],
      bannerUrls: heroImages.slice(1, 5),
      productType: entry.colorways.length > 1 || variants.length > 1 ? 'variant' : 'single',
      displayOn: 'both',
      variants,
      colorMedia,
      description:
        entry.description ||
        `${entry.style} — built for the session and everything around it. Engineered fabric, considered fit, and detailing that holds up rep after rep.`,
      shortDescription: `${entry.fit ? `${entry.fit}. ` : ''}${entry.style} in ${entry.colorways.length} colourway${entry.colorways.length > 1 ? 's' : ''}.`,
      features: [
        'Four-way stretch for unrestricted range of motion',
        'Moisture-wicking finish that moves sweat away fast',
        'Flatlock seams to stop chafe on long sessions',
        'Shape retention wash after wash',
      ].join('\n'),
      tags: [...new Set(tags)].slice(0, 10),
      metaTitle: `${entry.style} | The Jymor`,
      metaDescription: `Shop the ${entry.style} at The Jymor. ${entry.fit || 'Performance fit'}, engineered fabric, free delivery over Rs 15,000.`,
      stockType: 'ready_to_ship',
    };
  });
}

async function seedProducts(idBySlug) {
  console.log('\n▸ Harvesting reference catalogue');
  const reference = await harvest(COLLECTION_MAP);
  console.log(`  ${reference.length} unique reference entries`);

  const products = buildProducts(reference);
  console.log(`\n▸ Products (${products.length} styles)`);

  let created = 0;
  let updated = 0;
  for (const p of products) {
    const existing = await Product.findOne({ slug: p.slug });
    if (existing) {
      await Product.findOneAndUpdate({ slug: p.slug }, p, { new: true });
      updated++;
    } else {
      await Product.create(p);
      created++;
    }
  }
  console.log(`  ${created} created, ${updated} updated`);

  await seedColorsAndSizes(products);

  // Give every category a banner/thumbnail from one of its own products.
  console.log('\n▸ Category artwork');
  for (const [slug, id] of idBySlug) {
    const sample = await Product.findOne({ categories: slug, thumbnailUrl: { $exists: true, $ne: null } })
      .sort({ createdAt: -1 })
      .lean();
    if (!sample) continue;
    await Category.findByIdAndUpdate(id, {
      thumbnailUrl: sample.thumbnailUrl,
      bannerUrl: sample.bannerUrls?.[0] || sample.thumbnailUrl,
    });
  }

  return products;
}

// ---------------------------------------------------------------------------
// Homepage blocks
// ---------------------------------------------------------------------------

/**
 * Editorial artwork for the homepage blocks.
 *
 * These are wide lifestyle shots, not product cut-outs — headline copy sits on
 * top of them, and a tight packshot on a plain sweep reads badly behind text.
 * Replace these URLs with your own campaign photography in Admin -> Home
 * Sections; nothing here is referenced anywhere but the seed.
 */
const CDN = 'https://cdn.shopify.com/s/files/1/0618/9462/3460/files';
const ART = {
  // Hero slides. These get cropped to a wide letterbox, so they need a
  // subject that survives losing the top and bottom of the frame — the very
  // dark, tightly-composed shots used for the category tiles go black here.
  heroPrimary: `${CDN}/Shorts_8.jpg`,
  heroSecondary: `${CDN}/Leggings_10.jpg`,
  heroTertiary: `${CDN}/L-8.jpg`,
  // Mosaic sticky panels — tall crops, so the moodier art works here.
  sideWomen: `${CDN}/SIDE_BANNER_STATIC.jpg`,
  sideMen: `${CDN}/MEN_SIDE_STATIC.jpg`,
  // category banner grid
  tees: `${CDN}/T_Shirt.jpg`,
  leggings: `${CDN}/Leggings_11.jpg`,
  accessories: `${CDN}/Acessories-BTG.jpg`,
  sale: `${CDN}/EOSS_f1c65465-d54d-4851-a788-988a82ab5b34.jpg`,
  shorts: `${CDN}/Shorts_8.jpg`,
  // collection strip
  train: `${CDN}/MEN_36.jpg`,
  run: `${CDN}/RUN_1_1.jpg`,
  reset: `${CDN}/L-8.jpg`,
  // community rail
  ugc: [
    `${CDN}/Leggings_10.jpg`,
    `${CDN}/MT05169_ALPHATEE_3.jpg`,
    `${CDN}/WT05172_CONTOURTEE_5.jpg`,
    `${CDN}/SOCKS_15.jpg`,
    `${CDN}/MT05169_ALPHATEE_8.jpg`,
    `${CDN}/WT05162_SEAMLESSCONTOURUNITARD_3.jpg`,
  ],
  // info cards
  story: `${CDN}/ECOM_0011_SQUATWOLF_133.jpg`,
  sizing: `${CDN}/Store_Image-1x1.jpg`,
  delivery: `${CDN}/PACK_VIP-1x1.jpg`,
};

async function seedHomeSections() {
  console.log('\n▸ Homepage sections');

  const sections = [
    {
      key: 'hero',
      type: 'hero',
      order: 1,
      options: { fullBleed: true, background: 'ink' },
      tiles: [
        {
          eyebrow: 'NEW DROP',
          title: 'Back To Gym',
          imageUrl: ART.heroPrimary,
          theme: 'light',
          valign: 'bottom',
          order: 1,
          ctas: [
            { label: 'Shop Men', href: '/category/men', variant: 'light' },
            { label: 'Shop Women', href: '/category/women', variant: 'light' },
          ],
        },
        {
          eyebrow: 'New Collection. Now Live',
          title: 'Train Like You Mean It',
          imageUrl: ART.heroSecondary,
          theme: 'light',
          valign: 'bottom',
          order: 2,
          ctas: [
            { label: 'Shop Men', href: '/category/men', variant: 'light' },
            { label: 'Shop Women', href: '/category/women', variant: 'light' },
          ],
        },
        {
          eyebrow: 'New Drop',
          title: 'Elevated Coverage',
          imageUrl: ART.heroTertiary,
          theme: 'light',
          valign: 'bottom',
          order: 3,
          ctas: [
            { label: 'Shop Now', href: '/category/new-arrivals', variant: 'light' },
            { label: 'Explore More', href: '/products', variant: 'ghost' },
          ],
        },
      ],
    },

    {
      key: 'top-picks',
      title: 'Top Picks',
      type: 'product_rail',
      source: 'featured',
      limit: 12,
      order: 2,
      options: { showArrows: true, showViewAll: true, viewAllHref: '/products', background: 'paper' },
    },

    {
      key: 'best-of-elevated-coverage',
      title: 'Best Of Elevated Coverage',
      type: 'mosaic',
      source: 'category',
      categorySlug: 'women',
      limit: 12,
      order: 3,
      options: { mediaSide: 'right', productColumns: 2, background: 'paper' },
      tiles: [
        {
          title: 'Elevated Coverage',
          eyebrow: 'The Edit',
          imageUrl: ART.sideWomen,
          href: '/category/women',
          theme: 'light',
          valign: 'bottom',
          order: 1,
          ctas: [{ label: 'Shop The Edit', href: '/category/women', variant: 'light' }],
        },
      ],
    },

    {
      key: 'shop-by-category',
      type: 'banner_grid',
      order: 4,
      options: { columns: 2, aspect: '4/5', background: 'paper' },
      tiles: [
        {
          eyebrow: 'New', title: 'T-Shirts', imageUrl: ART.tees, href: '/category/men-tshirts',
          order: 1, valign: 'bottom',
          ctas: [
            { label: 'Shop Men', href: '/category/men-tshirts', variant: 'light' },
            { label: 'Shop Women', href: '/category/women-tops', variant: 'light' },
          ],
        },
        {
          eyebrow: 'New', title: 'Leggings', imageUrl: ART.leggings, href: '/category/women-leggings',
          order: 2, valign: 'bottom',
          ctas: [{ label: 'Shop Now', href: '/category/women-leggings', variant: 'light' }],
        },
        {
          eyebrow: 'New', title: 'Accessories', imageUrl: ART.accessories, href: '/category/accessories',
          order: 3, valign: 'bottom',
          ctas: [{ label: 'Shop Now', href: '/category/accessories', variant: 'light' }],
        },
        {
          eyebrow: 'Popular', title: 'End Of Season Sale', imageUrl: ART.sale, href: '/category/sale',
          order: 4, valign: 'bottom',
          ctas: [
            { label: 'Shop Men', href: '/category/men', variant: 'accent' },
            { label: 'Shop Women', href: '/category/women', variant: 'light' },
          ],
        },
      ],
    },

    {
      key: 'mens-essentials',
      title: 'Best Of Men’s Training',
      type: 'mosaic',
      source: 'category',
      categorySlug: 'men',
      limit: 12,
      order: 5,
      options: { mediaSide: 'left', productColumns: 2, background: 'paper' },
      tiles: [
        {
          title: 'Built For The Work',
          eyebrow: 'Men',
          imageUrl: ART.sideMen,
          href: '/category/men',
          theme: 'light',
          valign: 'bottom',
          order: 1,
          ctas: [{ label: 'Shop Men', href: '/category/men', variant: 'light' }],
        },
      ],
    },

    {
      key: 'activity-strip',
      type: 'collection_strip',
      order: 6,
      options: { columns: 3, aspect: '3/4', fullBleed: true, background: 'ink' },
      tiles: [
        { eyebrow: 'New', title: 'Train', imageUrl: ART.train, href: '/category/men', order: 1, valign: 'bottom' },
        { eyebrow: 'New', title: 'Run', imageUrl: ART.run, href: '/category/men-shorts', order: 2, valign: 'bottom' },
        { eyebrow: 'New', title: 'Reset', imageUrl: ART.reset, href: '/category/women', order: 3, valign: 'bottom' },
      ],
    },

    {
      key: 'new-in',
      title: 'New In',
      type: 'product_rail',
      source: 'latest',
      limit: 12,
      order: 7,
      options: { showArrows: true, showViewAll: true, viewAllHref: '/category/new-arrivals', background: 'paper' },
    },

    {
      key: 'in-the-wild',
      title: 'In The Wild',
      type: 'ugc_rail',
      order: 8,
      options: { showArrows: true, background: 'paper', aspect: '3/4' },
      tiles: ART.ugc.map((imageUrl, i) => ({ title: '@thejymor', imageUrl, href: '/products', order: i + 1 })),
    },

    {
      key: 'stay-up-to-date',
      title: 'Stay Up To Date',
      type: 'info_cards',
      order: 9,
      options: { columns: 3, background: 'paper' },
      tiles: [
        {
          title: 'Our Story',
          body: 'The Jymor was built around one idea: kit that disappears so the work doesn’t. Find out how we got here and where we’re headed.',
          imageUrl: ART.story,
          href: '/about-us',
          order: 1,
        },
        {
          title: 'Size & Fit',
          body: 'Athletic, regular or relaxed — our fit guide walks you through every cut so the first size you order is the one you keep.',
          imageUrl: ART.sizing,
          href: '/size-guide',
          order: 2,
        },
        {
          title: 'Delivery & Returns',
          body: 'Free delivery on orders over Rs 15,000, cash on delivery nationwide, and 14 days to change your mind.',
          imageUrl: ART.delivery,
          href: '/shipping-policy',
          order: 3,
        },
      ],
    },
  ];

  for (const s of sections) {
    await HomeSection.findOneAndUpdate({ key: s.key }, { ...s, isActive: true }, { upsert: true, new: true, setDefaultsOnInsert: true });
  }
  console.log(`  ${sections.length} sections`);
}

// ---------------------------------------------------------------------------

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  if (SECTIONS_ONLY) {
    await seedHomeSections();
    await mongoose.disconnect();
    console.log('\nDone.');
    return;
  }

  if (RESET) {
    console.log('\n▸ Resetting products / categories / sections');
    await Promise.all([
      Product.deleteMany({}),
      Category.deleteMany({}),
      HomeSection.deleteMany({}),
    ]);
  }

  const idBySlug = await seedCategories();
  await seedProducts(idBySlug);
  await seedHomeSections();

  const [products, categories, sections] = await Promise.all([
    Product.countDocuments(),
    Category.countDocuments(),
    HomeSection.countDocuments(),
  ]);
  console.log(`\n✓ ${products} products · ${categories} categories · ${sections} homepage sections`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\nSeed failed:', err);
  process.exit(1);
});
