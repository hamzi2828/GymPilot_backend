// seedCategorySeoContent.js
// Auto-generates description + SEO content (intro, footer, FAQs, meta tags)
// for every TOP-LEVEL ("main") category. Subcategories are skipped by default
// — pass `--all` to include them too.
//
// Usage:
//   node Seeder/seedCategorySeoContent.js              # main categories, skip filled
//   node Seeder/seedCategorySeoContent.js --force      # overwrite existing values
//   node Seeder/seedCategorySeoContent.js --all        # include subcategories
//   node Seeder/seedCategorySeoContent.js --slug=mens-collection   # one category
//   node Seeder/seedCategorySeoContent.js --dry        # print, don't save

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const Category = require('../src/models/category');

const MONGO_URI = process.env.MONGO_URI;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const INCLUDE_ALL = args.includes('--all');
const DRY = args.includes('--dry');
const SLUG_FLAG = (args.find((a) => a.startsWith('--slug=')) || '').split('=')[1];

// ────────────────────────────────────────────────────────────────────────────
// Content generation — template-based but deterministically varied per slug so
// no two categories render identical paragraphs (Google flags duplicate text).
// ────────────────────────────────────────────────────────────────────────────

// Tiny non-cryptographic hash → integer; lets us pick stable variants per slug.
function hash(str, salt = 0) {
  let h = salt >>> 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
function pick(pool, slug, salt) {
  return pool[hash(slug, salt) % pool.length];
}

function humanize(slug) {
  let s = slug;
  try { s = decodeURIComponent(s); } catch {}
  const leaf = s.split(/->|>/).pop() || s;
  return leaf
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Detect audience from name / slug keywords. Falls back to 'unisex'.
function detectAudience(name, slug) {
  const s = `${name} ${slug}`.toLowerCase();
  if (/\b(women|womens|woman|ladies|abaya|kurta-sets|lawn|frock|kaftan)\b/.test(s)) return 'women';
  if (/\b(men|mens|man|boys|tracksuit|polo|tee|kurta\b|cargo|joggers|trousers|shirts)\b/.test(s)) return 'men';
  return 'unisex';
}

const introOpeners = {
  women: [
    'Discover {name} at Inked Wear PK — a curated edit for the modern Pakistani woman who wants quality, comfort, and a contemporary cut without compromise.',
    'Step into our {name} collection — every piece is built around how Pakistani women actually dress today: relaxed, expressive, and quietly premium.',
    'Our {name} range brings together considered fabric, careful tailoring, and the kind of styling details you only notice when you wear them.',
    'Shop {name} online in Pakistan from Inked Wear PK — silhouettes that flatter, fabric that breathes, and finish that lasts beyond a single season.',
  ],
  men: [
    'Shop {name} at Inked Wear PK — premium fits, honest fabric, and clean detailing for men who want to look sharp without overdressing.',
    'Our {name} range is built for real Pakistani men: pieces you can wear to work, to the gym, or out, with no awkward break-in period.',
    'Browse {name} online — every cut is engineered for Pakistani body types and Pakistani weather, not just photographed for a lookbook.',
    'Inked Wear PK\'s {name} edit is about substance over hype: solid fabric, tailored fits, and pricing that respects what you\'re actually paying for.',
  ],
  unisex: [
    'Welcome to our {name} collection — premium clothing made for everyday Pakistani wardrobes.',
    'Browse {name} at Inked Wear PK. Quality fabric, modern cuts, fair pricing — everything you\'d expect from a premium brand, with none of the markup.',
    'Our {name} range is designed for people who want clothing that holds up wash after wash and still looks intentional on day one.',
  ],
};

const fabricLines = [
  'We obsess over fabric — every roll is selected for hand-feel, drape, colourfastness, and how it breathes in Pakistani weather.',
  'Fabric isn\'t an afterthought here. We test for shrinkage, pilling, and colour bleed before a single piece goes into production.',
  'You can feel the difference the second you handle one of our pieces — the weave is denser, the finish is cleaner, the seams sit flat.',
  'Our fabric standards come from years of trial and error: lighter where you need it, structured where it counts, washable without losing its shape.',
];

const fitLines = [
  'Fits are tested on real Pakistani bodies, not generic mannequins, so the size you order is the size that actually works for you.',
  'Cuts are intentional — not too oversized to look sloppy, not too tight to feel restrictive. We pattern for comfort that still photographs well.',
  'Each silhouette is graded across the full size range, so a Small drapes the same as a 2XL — proportional, considered, and never an afterthought.',
  'The fits are dialled in: relaxed where it should breathe, tailored where it should hold shape, with nothing pulling in the wrong place.',
];

const occasionLines = {
  women: [
    'Wear it casually with sandals and a quiet ear-piece, dress it up with heels and statement jewellery, or layer it for the office — these pieces flex with your day.',
    'Built for everything from running errands to attending a low-key family event, our {name} pieces refuse to be boxed into a single moment.',
    'Whether you\'re heading to work, a friend\'s mehndi, or just want to feel put-together at home, this collection has a piece for it.',
  ],
  men: [
    'Style it down with sneakers and a clean watch, or pair with leather and a structured belt for a sharper look — versatility is built in.',
    'From the office to a weekend out, these {name} pieces don\'t demand a specific dress code — they fit yours.',
    'Pair with everyday jeans, swap into trousers for work, throw it under a jacket when the weather turns — the styling options are wide open.',
  ],
  unisex: [
    'These pieces work across moments — casual, semi-formal, or just relaxing at home — without feeling out of place anywhere.',
    'Whether you\'re commuting, hosting, or hanging out, our {name} edit holds up.',
  ],
};

const closingLines = [
  'Free shipping on qualifying orders, Cash on Delivery across Pakistan, and a no-fuss return window — buy with confidence, not with caveats.',
  'We deliver nationwide with Cash on Delivery, easy exchanges, and a return policy that actually means something. Shop without the second-guessing.',
  'Cash on Delivery is live across Pakistan, dispatch is fast, and we back every order with a real return window — no fine print.',
];

// FAQ pools — generic questions paired with category-flavoured answers.
function buildFaqs(name, audience, slug) {
  const lower = name.toLowerCase();
  const faqs = [
    {
      question: `Are your ${lower} pieces true to size?`,
      answer: `Yes — our ${lower} are graded against measurements taken on Pakistani body types, not foreign standards. If you\'re between sizes, our size guide includes both centimetres and inches, or you can WhatsApp us at +92 312 2031137 and we\'ll help you pick.`,
    },
    {
      question: `What fabric do you use for your ${lower}?`,
      answer: `We choose fabric per category based on how it\'s actually worn. For ${lower}, we prioritise breathability, durability, and how it holds colour over multiple washes. Each product page lists the exact fabric composition.`,
    },
    {
      question: `Do you offer Cash on Delivery on ${lower}?`,
      answer: `Yes, Cash on Delivery is available on every order in Pakistan, including ${lower}. You only pay when the courier hands you the parcel.`,
    },
    {
      question: `Can I return or exchange ${lower} if the fit isn\'t right?`,
      answer: `Absolutely. We offer a 7-day exchange and return window on unused, tag-on items. Open the parcel, try it on, and if it isn\'t right, message us and we\'ll arrange a swap.`,
    },
    {
      question: `How long does delivery take for ${lower}?`,
      answer: `Standard nationwide delivery takes 2–5 business days. Karachi, Lahore, and Islamabad are typically faster; smaller cities take a day or two longer.`,
    },
    {
      question: audience === 'women'
        ? `How should I care for my ${lower}?`
        : `Will my ${lower} hold up to regular wear?`,
      answer: audience === 'women'
        ? `Most of our ${lower} are best washed in cold water, gentle cycle, dried flat in shade. Each tag includes specific care instructions tailored to that fabric.`
        : `Yes — fabric and stitching are tested for repeated wear, washing, and movement. Our ${lower} are built to look as good in month six as they do on day one.`,
    },
  ];

  // Pick 4 deterministically from this pool of 6.
  const startIndex = hash(slug, 99) % faqs.length;
  return [0, 1, 2, 3].map((i) => faqs[(startIndex + i) % faqs.length]);
}

function buildContent(category, parentName) {
  const name = (category.name || humanize(category.slug || '')).trim();
  const slug = category.slug || '';
  const audience = detectAudience(name, slug);
  const lower = name.toLowerCase();

  const opener = pick(introOpeners[audience], slug, 1).replace(/\{name\}/g, lower);
  const fabric = pick(fabricLines, slug, 2);
  const fit = pick(fitLines, slug, 3);
  const occasion = pick(occasionLines[audience] || occasionLines.unisex, slug, 4).replace(/\{name\}/g, lower);
  const closing = pick(closingLines, slug, 5);

  const parentBreadcrumb = parentName
    ? `<p class="text-xs text-gray-500 mb-2">${parentName} → ${name}</p>`
    : '';

  // Intro body — 3 paragraphs, ~180–250 words, unique per slug.
  const seoIntroBody = [
    parentBreadcrumb,
    `<p>${opener}</p>`,
    `<p>${fabric} ${fit}</p>`,
    `<p>${occasion} ${closing}</p>`,
  ].filter(Boolean).join('\n');

  // Avoid "Men's Men's Collection" when the name already starts with the prefix.
  const startsWithWomens = /^women(['’]s)?\b/i.test(name);
  const startsWithMens = /^men(['’]s)?\b/i.test(name);
  const seoIntroTitle = audience === 'women' && !startsWithWomens
    ? `Women\'s ${name} Online in Pakistan`
    : audience === 'men' && !startsWithMens
    ? `Men\'s ${name} — Premium Quality, Honest Pricing`
    : audience === 'women'
    ? `${name} Online in Pakistan`
    : audience === 'men'
    ? `${name} — Premium Quality, Honest Pricing`
    : `Shop ${name} Online in Pakistan`;

  const seoFooterBody = [
    `<p>Every piece in our ${lower} collection is part of a larger idea: that premium clothing in Pakistan shouldn\'t require a markup tax. We design, source, and stitch with the same standards as international brands — and price for the local market.</p>`,
    `<p>If you\'re unsure about size or styling, our team is one WhatsApp message away at +92 312 2031137. Need to compare measurements? The size guide has every dimension in both centimetres and inches. And if your order isn\'t right, our 7-day return and exchange window has you covered — no friction, no questions buried in fine print.</p>`,
    `<p>Browse the rest of our ${audience === 'women' ? 'women\'s ' : audience === 'men' ? 'men\'s ' : ''}catalogue, or check the style journal for fit guides, fabric notes, and outfit ideas built around our ${lower} pieces.</p>`,
  ].join('\n');

  const seoFaqs = buildFaqs(name, audience, slug);

  // Short description — used on admin lists / cards. 1–2 sentences, keyword-rich.
  const description = `${name} at Inked Wear PK — premium fabric, considered fits, and Pakistan-friendly pricing. ${audience === 'women' ? 'Designed for the modern Pakistani woman.' : audience === 'men' ? 'Built for real Pakistani men.' : 'Designed for everyday Pakistani wardrobes.'} Cash on Delivery, fast nationwide shipping.`;

  // Meta tags — kept under 70 / 160 chars per Seobility recommendations.
  let metaTitle = audience === 'women'
    ? `${name} Online Pakistan | Inked Wear PK`
    : audience === 'men'
    ? `${name} Pakistan — Inked Wear PK`
    : `${name} | Inked Wear PK`;
  if (metaTitle.length > 70) metaTitle = `${name} | Inked Wear PK`.slice(0, 70);

  let metaDescription = `Shop ${lower} online at Inked Wear PK — premium fabric, modern fits, COD across Pakistan. Fast delivery and a 7-day return window on every order.`;
  if (metaDescription.length > 160) metaDescription = metaDescription.slice(0, 157) + '...';

  const metaKeywords = [
    lower,
    `${lower} pakistan`,
    `${lower} online`,
    `buy ${lower}`,
    'inked wear pk',
    audience === 'women' ? 'womens clothing pakistan' : audience === 'men' ? 'mens clothing pakistan' : 'clothing pakistan',
  ].join(', ');

  return {
    description,
    seoIntroTitle,
    seoIntroBody,
    seoFooterBody,
    seoFaqs,
    metaTitle,
    metaDescription,
    metaKeywords,
  };
}

// ────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected: ${mongoose.connection.name}`);

  // Build a parent map so we can pass the parent name into the generator.
  const all = await Category.find({}).populate('parentId', 'name slug').lean();
  const byId = new Map(all.map((c) => [String(c._id), c]));

  // Filter target set.
  let targets = all;
  if (SLUG_FLAG) {
    targets = all.filter((c) => c.slug === SLUG_FLAG);
    if (!targets.length) {
      console.error(`No category found with slug=${SLUG_FLAG}`);
      await mongoose.disconnect();
      process.exit(1);
    }
  } else if (!INCLUDE_ALL) {
    targets = all.filter((c) => !c.parentId);
  }

  console.log(`Found ${all.length} categories total. Targeting ${targets.length}.`);
  if (DRY) console.log('DRY RUN — no writes will happen.');

  let updated = 0;
  let skipped = 0;
  let preview = null;

  for (const cat of targets) {
    const parentName = cat.parentId
      ? (typeof cat.parentId === 'object' ? cat.parentId.name : byId.get(String(cat.parentId))?.name)
      : null;

    const generated = buildContent(cat, parentName);

    // Skip if seoIntroBody already filled and not forcing.
    const alreadyFilled = (cat.seoIntroBody && cat.seoIntroBody.trim()) ||
      (cat.seoFooterBody && cat.seoFooterBody.trim());
    if (alreadyFilled && !FORCE) {
      skipped++;
      console.log(`  [skip] ${cat.slug} — already has SEO content (use --force to overwrite)`);
      continue;
    }

    // Preserve manual description if present and not forcing.
    const updates = { ...generated };
    if (cat.description && cat.description.trim() && !FORCE) {
      delete updates.description;
    }

    if (DRY) {
      if (!preview) preview = { slug: cat.slug, ...generated };
    } else {
      await Category.updateOne({ _id: cat._id }, { $set: updates });
    }
    updated++;
    console.log(`  [ok]   ${cat.slug}  — ${generated.seoIntroTitle}`);
  }

  console.log('');
  console.log(`Done. Updated: ${updated}. Skipped: ${skipped}.`);
  if (DRY && preview) {
    console.log('\nSample generated payload (first target):');
    console.log(JSON.stringify(preview, null, 2));
  }

  await mongoose.disconnect();
  console.log('Disconnected.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Seeder failed:', err);
  process.exit(1);
});
