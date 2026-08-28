// src/seeds/seedSEOBlogs.js
// Seeds the 4 blog articles from The Jymor Pakistan SEO Strategy Document
require('dotenv').config();
const mongoose = require('mongoose');
const BlogCategory = require('../models/BlogCategory');
const Author = require('../models/authorModel');
const Blog = require('../models/blogModel');

// Use environment variable or fallback
const MONGO_URI = process.env.MONGO_URI;

// Blog Categories for SEO Strategy
const seoCategoriesData = [
  {
    name: "Men's Fashion",
    slug: 'mens-fashion',
    description: 'Style guides, outfit inspiration, and fashion tips for Pakistani men.',
    active: true,
    featured: true
  },
  {
    name: "Women's Fashion",
    slug: 'womens-fashion',
    description: 'Fashion advice, styling tips, and trend guides for Pakistani women.',
    active: true,
    featured: true
  },
  {
    name: 'Seasonal Guides',
    slug: 'seasonal-guides',
    description: 'Seasonal fashion guides for Eid, summer, winter, and special occasions.',
    active: true,
    featured: true
  },
  {
    name: 'Occasion Wear',
    slug: 'occasion-wear',
    description: 'Outfit ideas and styling tips for weddings, Eid, and special events.',
    active: true,
    featured: true
  }
];

// SEO Strategy Author
const seoAuthorData = {
  name: 'The Jymor Style Team',
  slug: 'inkedwearpk-style-team',
  email: 'hello@inkedwearpk.com',
  bio: 'The official The Jymor style team bringing you the latest fashion guides, outfit inspiration, and trend reports for Pakistani men and women.',
  active: true
};

// 4 Blog Articles from SEO Strategy PDF
const seoBlogsData = [
  // Blog 1: Men's Fashion Guide Pakistan 2026
  {
    title: "Men's Fashion in Pakistan 2026: The Complete Style Guide",
    slug: 'mens-fashion-pakistan-2026',
    content: `
<p>Pakistani men's fashion has never been more vibrant, more confident, or more diverse. In 2026, the modern Pakistani man moves fluidly between the elegance of a well-cut shalwar kameez and the ease of a graphic tee and joggers — and does both with style. Whether you're updating your wardrobe for Eid, the office, or just everyday life, this guide covers everything.</p>

<h2>1. The Eastern Wardrobe Essentials</h2>

<h3>Shalwar Kameez — Still King</h3>
<p>The shalwar kameez remains Pakistan's most worn garment, and rightly so. It's versatile, comfortable, and dignified in a way no other outfit matches. In 2026, the key trend is in the cut — slimmer fits for younger men, structured collars, and subtle embroidery on the chest and cuffs for semi-formal occasions.</p>
<p><strong>Fabric guide:</strong> Cotton lawn for summer, cotton blend for autumn, karandi or wash-and-wear for winter. Go for solid colours at the office; printed or embroidered for weddings and Eid.</p>

<h3>Kurta — The Smart Casual Solution</h3>
<p>The kurta with jeans remains one of the strongest smart-casual combinations available to Pakistani men. A plain cotton kurta over slim-fit jeans with simple sandals is appropriate for almost any casual occasion. For weddings and formal events, an embroidered kurta with a matching waistcoat elevates the look significantly.</p>

<h2>2. Western Wear for Pakistani Men</h2>

<h3>T-Shirts and Polo Shirts</h3>
<p>Plain cotton T-shirts in navy, black, white, and grey are the most versatile items you can own. They pair with jeans, chinos, and even shalwar for a casual look. Polo shirts offer a slightly more formal alternative while remaining comfortable in Pakistan's warm weather.</p>
<p><strong>Trend watch 2026:</strong> Oversized graphic tees with cultural and national motifs are popular among younger men, particularly around Independence Day.</p>

<h3>Jeans and Trousers</h3>
<p>Slim-fit and straight-cut jeans remain the dominant denim styles. For office and semi-casual wear, chino trousers in khaki, navy, or grey are the smart choice. Cargo trousers have made a strong comeback in street fashion circles in Karachi and Lahore.</p>

<h2>3. Building a Core Pakistani Men's Wardrobe</h2>
<p>Here's what a well-rounded Pakistani man's wardrobe looks like in 2026:</p>
<ul>
  <li>2–3 shalwar kameez sets (casual cotton + one semi-formal)</li>
  <li>2–3 kurtas (plain cotton + one embroidered festive option)</li>
  <li>3–4 T-shirts in solid colours</li>
  <li>1–2 polo shirts for smart-casual occasions</li>
  <li>2 pairs of jeans (slim and straight)</li>
  <li>1–2 chino or formal trousers</li>
  <li>1–2 joggers for home and active wear</li>
  <li>1 hoodie or jacket for winter layering</li>
  <li>Multi-packs of underwear and socks</li>
</ul>

<h2>4. Occasion Dressing</h2>
<ul>
  <li><strong>Eid:</strong> Embroidered kurta with waistcoat, or formal embroidered shalwar kameez in rich colours (navy, forest green, maroon, charcoal)</li>
  <li><strong>Wedding (day):</strong> Neat shalwar kameez in subtle colours; avoid over-embellishment for daytime</li>
  <li><strong>Wedding (evening):</strong> Sherwanis or full embroidered shalwar kameez for close family events; smart kurta with waistcoat for guests</li>
  <li><strong>Office:</strong> Formal trousers + shirt, or clean-cut shalwar kameez in wash-and-wear fabric</li>
  <li><strong>Weekend/Casual:</strong> T-shirt + jeans, or cotton kurta + jeans</li>
</ul>

<h2>5. Shop The Jymor's Men's Collection</h2>
<p>Everything in this guide is available in The Jymor's men's clothing range — from premium cotton shalwar kameez and embroidered kurtas to casual T-shirts, joggers, and winter hoodies.</p>
    `,
    status: 'published',
    featured: true,
    image: '/uploads/blogs/mens-fashion-pakistan-2026.jpg',
    tags: ['mens fashion', 'pakistan', '2026', 'style guide', 'shalwar kameez', 'kurta', 'menswear'],
    metaTitle: "Men's Fashion in Pakistan 2026: The Complete Style Guide | The Jymor",
    metaDescription: "The definitive men's fashion guide for Pakistan in 2026 — what to wear, how to style it, and where to shop. From shalwar kameez to streetwear.",
    metaKeywords: "men's fashion Pakistan 2026, men's style guide Pakistan, men's clothing Pakistan, shalwar kameez, kurta, Pakistani menswear",
    categorySlug: 'mens-fashion'
  },

  // Blog 2: How to Choose the Perfect Lawn Suit
  {
    title: "How to Choose the Perfect Lawn Suit: A Pakistani Woman's Complete Guide",
    slug: 'how-to-choose-lawn-suit-pakistan',
    content: `
<p>Every summer, Pakistan's women face the same delightful problem: too many beautiful lawn suits, and not enough wardrobe space. But with hundreds of options available online, knowing how to choose well makes all the difference. This guide tells you exactly what to look for.</p>

<h2>What Makes a Good Lawn Suit?</h2>

<h3>Fabric Quality Comes First</h3>
<p>Not all lawn is equal. Premium lawn fabric has a softer hand-feel, a finer weave, and colours that stay vibrant through multiple washes. A quick test: hold the fabric up to the light. Higher-quality lawn will be slightly sheer but even in texture with no inconsistencies in the weave.</p>
<p><strong>Look for:</strong> 100% cotton lawn, lawn with chiffon dupatta (lightweight and flowing), and embroidered lawn (more expensive, but worth it for festive occasions).</p>

<h3>Stitched vs Unstitched</h3>
<p>This is the biggest practical decision. <strong>Stitched lawn suits</strong> come ready-to-wear in standard sizes (XS–XXL) — you order, it arrives, you wear it. Perfect if you know your size and want zero hassle. <strong>Unstitched lawn</strong> gives you the freedom to have it tailored exactly to your measurements. Better fit, but requires time and a good darzi.</p>
<p><strong>Our recommendation:</strong> For casual daily wear, go stitched and prioritise convenience. For formal or Eid occasions where fit is paramount, unstitched and tailored gives the best result.</p>

<h2>Understanding Print Types</h2>
<ul>
  <li><strong>Digital print</strong> — Clean, photographic-quality prints. Vibrant and modern. Best for casual and trendy styles.</li>
  <li><strong>Screen print</strong> — Traditional printing method. Slightly less detail but excellent colour saturation. More affordable.</li>
  <li><strong>Embroidered</strong> — Thread or machine embroidery on the shirt, neckline or border. Elevated look, ideal for festive occasions.</li>
  <li><strong>Foil/Glitter print</strong> — Adds shimmer and shine. Better for evening events and Eid wear.</li>
</ul>

<h2>2-Piece vs 3-Piece</h2>
<p><strong>2-piece lawn suits</strong> (shirt + trouser) are more practical for daily wear — less fabric to manage, easy to style. <strong>3-piece suits</strong> (shirt + trouser + dupatta) create a more complete, traditional look. For office and casual use, 2-piece is more practical. For gatherings and formal occasions, 3-piece is more appropriate.</p>

<h2>Colour & Print Selection by Occasion</h2>
<ul>
  <li><strong>Daily office wear</strong> — Subtle prints, pastel tones, simple embroidery. Nothing too bold or distracting.</li>
  <li><strong>Family gathering</strong> — Medium prints, bright colours are welcome. 2 or 3 piece both work.</li>
  <li><strong>Wedding guest (day)</strong> — Bold embroidery, vibrant colours, 3-piece with chiffon dupatta.</li>
  <li><strong>Eid</strong> — Go all out. Foil prints, heavy embroidery, rich fabric. This is the occasion for your most beautiful suit.</li>
</ul>

<h2>Shop The Jymor Women's Lawn</h2>
<p>The Jymor's women's lawn collection is updated seasonally with new prints, embroidery styles, and both stitched and unstitched options at accessible prices. <a href="/womens-lawn">Browse the Women's Lawn Collection →</a></p>
    `,
    status: 'published',
    featured: true,
    image: '/uploads/blogs/lawn-suit-guide-pakistan.jpg',
    tags: ['lawn suits', 'womens fashion', 'pakistan', 'summer', 'guide', 'stitched', 'unstitched'],
    metaTitle: 'How to Choose the Perfect Lawn Suit in Pakistan | The Jymor Guide',
    metaDescription: "Confused by all the lawn suit options in Pakistan? Our complete guide explains fabrics, prints, stitching options and how to find the best value lawn suits online.",
    metaKeywords: 'lawn suit guide Pakistan, best lawn suits Pakistan, how to buy lawn suit, lawn fabric guide, stitched lawn, unstitched lawn',
    categorySlug: 'womens-fashion'
  },

  // Blog 3: Eid Outfit Ideas for Men & Women 2026
  {
    title: 'Eid Outfit Ideas for Men & Women in Pakistan 2026',
    slug: 'eid-outfit-ideas-pakistan-2026',
    content: `
<p>Eid is Pakistan's most important occasion for dressing up — and it deserves your absolute best. Whether you're celebrating Eid ul-Fitr or Eid ul-Adha, this guide has outfit ideas for every style, every budget, and every occasion across the two days of festivities.</p>

<h2>Men's Eid Outfit Ideas</h2>

<h3>Look 1: The Classic Embroidered Shalwar Kameez</h3>
<p><strong>Colour:</strong> Forest green, navy, or ivory.<br>
<strong>Fabric:</strong> Premium cotton or wash-and-wear.<br>
<strong>Details:</strong> Embroidery on collar and cuffs.<br>
<strong>Pair with:</strong> Brown or tan khussa shoes.<br>
<strong>Works for:</strong> Eid prayers, family visits, formal lunch.</p>

<h3>Look 2: Kurta + Waistcoat + Shalwar</h3>
<p><strong>Colour:</strong> Maroon or charcoal kurta with a contrasting or matching waistcoat.<br>
<strong>Style:</strong> Embroidered kurta with a structured waistcoat.<br>
<strong>Pair with:</strong> Classic leather khussa or formal sandals.<br>
<strong>Works for:</strong> Evening gatherings, close family events, dinner parties.</p>

<h3>Look 3: Smart Casual Kurta + Jeans</h3>
<p><strong>Colour:</strong> Plain white or sky blue cotton kurta.<br>
<strong>Pair with:</strong> Dark-wash slim jeans.<br>
<strong>Footwear:</strong> Clean white sneakers or simple sandals.<br>
<strong>Works for:</strong> Younger men, casual second-day Eid, visiting friends.</p>

<h3>Eid Colour Palette for Men 2026</h3>
<ul>
  <li><strong>Forest green</strong> — Strong, sophisticated, universally flattering</li>
  <li><strong>Ivory/Cream</strong> — Classic and elegant, especially for embroidered styles</li>
  <li><strong>Navy blue</strong> — Smart, reliable, pairs with almost any shoe</li>
  <li><strong>Maroon/Burgundy</strong> — Rich, festive, ideal for evening events</li>
  <li><strong>Powder blue</strong> — Fresh and modern for younger styles</li>
</ul>

<h2>Women's Eid Outfit Ideas</h2>

<h3>Look 1: Embroidered 3-Piece Lawn Suit</h3>
<p>For Eid in spring/summer, a premium embroidered lawn 3-piece with a chiffon dupatta is the quintessential look. Choose rich jewel tones — emerald, deep rose, golden yellow — for a festive statement. Pair with silver or gold sandals and minimal jewellery.</p>

<h3>Look 2: Chiffon or Organza Formal Pret</h3>
<p>For a more elevated look, a chiffon or organza pret suit in a solid colour with embellished border work or sequin detailing is stunning for Eid evening gatherings. Deep navy, plum, or warm rust are excellent Eid colour choices.</p>

<h3>Look 3: Silk or Velvet Kurta Set</h3>
<p>For women who prefer a co-ordinated, tailored look — a silk or velvet kurta with matching palazzo or cigarette trousers is modern, elegant, and practical. Add a contrast embroidered dupatta for the traditional touch.</p>

<h3>Women's Eid Colour Palette 2026</h3>
<ul>
  <li><strong>Emerald green</strong> — Bold and gorgeous, especially in embroidered lawn</li>
  <li><strong>Deep rose / Hot pink</strong> — Vibrant, youthful, unmissable</li>
  <li><strong>Ivory and gold</strong> — Timeless, works for all ages</li>
  <li><strong>Lavender and lilac</strong> — Trending strongly this season</li>
  <li><strong>Coral and rust</strong> — Warm tones perfect for summer Eid</li>
</ul>

<h2>Shop The Jymor's Eid Collection</h2>
<p>The Jymor's men's and women's festive range includes embroidered shalwar kameez for men, premium pret dresses for women, and lawn suits perfect for Pakistan's Eid season. <a href="/new-arrivals">Explore the Eid Collection →</a></p>
    `,
    status: 'published',
    featured: true,
    image: '/uploads/blogs/eid-outfit-ideas-2026.jpg',
    tags: ['eid', 'outfit ideas', 'pakistan', '2026', 'mens fashion', 'womens fashion', 'festive', 'eid ul fitr', 'eid ul adha'],
    metaTitle: 'Eid Outfit Ideas for Men & Women Pakistan 2026 | The Jymor',
    metaDescription: "Get inspired for Eid 2026 with The Jymor's outfit guide for men and women in Pakistan. From embroidered kurtas to stunning lawn suits — your Eid look sorted.",
    metaKeywords: 'Eid outfit ideas Pakistan 2026, Eid clothes Pakistan, Eid dress men women, what to wear Eid Pakistan, Eid fashion',
    categorySlug: 'occasion-wear'
  },

  // Blog 4: Pakistan's Best Casual Wear Brands Compared
  {
    title: "Pakistan's Best Casual Wear Brands in 2026: What to Know Before You Shop",
    slug: 'best-casual-wear-brands-pakistan-2026',
    content: `
<p>Pakistan's online clothing market has exploded over the past five years. Today you have more choice than ever — but more choice also means more confusion. This guide breaks down what actually matters when choosing a clothing brand in Pakistan so you can shop smarter.</p>

<h2>What to Look for in a Pakistani Clothing Brand</h2>

<ul>
  <li><strong>Fabric quality</strong> — Does the brand clearly state its fabric composition? Cotton, lawn, and poly-cotton are standard; premium brands go further with specifications.</li>
  <li><strong>Pakistani sizing</strong> — Does the brand offer sizes that reflect Pakistani body types? A brand with only Western-standard sizes will often lead to frustration.</li>
  <li><strong>Eastern and Western options</strong> — Pakistan's men and women wear both. A brand that offers both halves of the wardrobe is significantly more convenient.</li>
  <li><strong>Cash on delivery</strong> — Still the dominant payment preference in Pakistan. A brand without COD limits its customer base significantly.</li>
  <li><strong>Exchange and return policy</strong> — Things don't always fit as expected. A clear, easy exchange policy is a major trust signal.</li>
  <li><strong>Seasonal awareness</strong> — Pakistan has distinct seasons. A good brand refreshes its collection with appropriate fabrics for summer and winter.</li>
</ul>

<h2>Key Features to Compare</h2>

<table style="width:100%; border-collapse: collapse; margin: 20px 0;">
  <thead>
    <tr style="background-color: #f5f5f5;">
      <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Feature</th>
      <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">What to Look For</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>Payment</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">Cash on Delivery available nationwide</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>Shipping</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">Free delivery on orders over Rs. 3,000</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>Returns</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">Easy 15-day exchange policy</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>Sizing</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">Full Pakistani size guide, XS–XXL</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>Fabrics</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">Sourced for Pakistan's climate</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>Range</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">Men's + Women's under one roof</td>
    </tr>
  </tbody>
</table>

<h2>The Importance of Both Eastern and Western Options</h2>
<p>Many Pakistani brands focus exclusively on either Eastern wear (shalwar kameez, kurta) or Western wear (t-shirts, jeans). But the modern Pakistani wardrobe needs both. Shopping from a brand that covers the full spectrum — from a man's everyday shalwar kameez to a woman's beautifully printed lawn suit, plus casual Western pieces — saves time, builds consistency in your wardrobe, and often provides better value through combined orders.</p>

<h2>Why Climate-Appropriate Fabrics Matter</h2>
<p>Pakistan's seasons are extreme — from scorching Karachi summers to freezing Islamabad winters. A brand that understands this will offer:</p>
<ul>
  <li>Breathable lawn and cotton for summer</li>
  <li>Warm knits and hoodies for winter</li>
  <li>Transitional fabrics for autumn and spring</li>
</ul>

<h2>The Case for The Jymor</h2>
<p>The Jymor is designed to tick every one of these boxes. Both men's and women's clothing under one roof. Premium cotton and lawn fabrics chosen for Pakistan's climate. Full Pakistani sizing from XS to XXL. Cash on delivery nationwide. And a product range that covers everything from an everyday shalwar kameez to a beautiful embroidered lawn suit for Eid.</p>

<p>We built The Jymor because we believe Pakistanis deserve a clothing brand that genuinely understands them — not one imported from outside. <a href="/products">Shop The Jymor's full collection →</a></p>
    `,
    status: 'published',
    featured: false,
    image: '/uploads/blogs/best-casual-brands-pakistan.jpg',
    tags: ['clothing brands', 'pakistan', 'casual wear', 'comparison', 'shopping guide', 'online shopping'],
    metaTitle: "Best Casual Wear Brands in Pakistan 2026 | The Jymor Comparison",
    metaDescription: "Looking for the best casual clothing brands in Pakistan? We compare quality, price, range and service so you can make the best choice for your wardrobe.",
    metaKeywords: 'best clothing brands Pakistan, casual wear brands Pakistan, online clothes Pakistan, men\'s brands Pakistan, women\'s brands Pakistan',
    categorySlug: 'style-tips'
  }
];

// Add Style Tips category for the comparison blog
const additionalCategory = {
  name: 'Style Tips',
  slug: 'style-tips',
  description: 'Expert advice on how to dress for different occasions and make smart fashion choices.',
  active: true,
  featured: true
};

async function seedSEOBlogs() {
  try {
    // Connect to MongoDB
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000
    });
    console.log('Connected to MongoDB');

    // Seed Categories
    console.log('\n--- Seeding SEO Blog Categories ---');
    const allCategories = [...seoCategoriesData, additionalCategory];
    const categoryMap = {};

    for (const categoryData of allCategories) {
      const existingCategory = await BlogCategory.findOne({ slug: categoryData.slug });
      if (existingCategory) {
        console.log(`Category "${categoryData.name}" already exists, updating...`);
        Object.assign(existingCategory, categoryData);
        await existingCategory.save();
        categoryMap[categoryData.slug] = existingCategory;
      } else {
        const category = await BlogCategory.create(categoryData);
        console.log(`Created category: ${category.name}`);
        categoryMap[categoryData.slug] = category;
      }
    }
    console.log(`Total categories processed: ${Object.keys(categoryMap).length}`);

    // Delete all existing blogs first
    console.log('\n--- Deleting Existing Blogs ---');
    const deleteResult = await Blog.deleteMany({});
    console.log(`Deleted ${deleteResult.deletedCount} existing blogs`);

    // Reset author blog counts
    await Author.updateMany({}, { blogCount: 0 });
    console.log('Reset all author blog counts to 0');

    // Fix existing authors with null slugs
    console.log('\n--- Fixing Authors with Null Slugs ---');
    const authorsWithNullSlug = await Author.find({ slug: null });
    for (const auth of authorsWithNullSlug) {
      auth.slug = auth.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim()
        .slice(0, 50);
      await auth.save();
      console.log(`Fixed slug for author: ${auth.name} -> ${auth.slug}`);
    }

    // Use existing author or create one
    console.log('\n--- Setting Up Blog Author ---');
    let author = await Author.findOne({ email: seoAuthorData.email });

    if (!author) {
      // Try to find any existing active author
      author = await Author.findOne({ active: true });
    }

    if (!author) {
      // Create new author with slug explicitly set to avoid mongoose hook issues
      const newAuthor = new Author(seoAuthorData);
      newAuthor.slug = 'inkedwearpk-style-team';
      await newAuthor.save();
      author = newAuthor;
      console.log(`Created author: ${author.name}`);
    } else {
      console.log(`Using existing author: ${author.name} (${author.email})`);
    }

    // Seed Blogs
    console.log('\n--- Seeding SEO Strategy Blogs ---');
    const createdBlogs = [];

    for (const blogData of seoBlogsData) {
      const { categorySlug, ...blogFields } = blogData;

      // Get category
      const category = categoryMap[categorySlug];
      if (!category) {
        console.log(`Category "${categorySlug}" not found for blog "${blogData.title}", skipping...`);
        continue;
      }

      // Check if blog exists
      const existingBlog = await Blog.findOne({ slug: blogData.slug });

      if (existingBlog) {
        console.log(`Blog "${blogData.title}" already exists, updating...`);
        Object.assign(existingBlog, {
          ...blogFields,
          categoryId: category._id,
          author: author._id
        });
        await existingBlog.save();
        createdBlogs.push(existingBlog);
        console.log(`  - Updated: ${existingBlog.title}`);
      } else {
        const blog = await Blog.create({
          ...blogFields,
          categoryId: category._id,
          author: author._id
        });

        // Increment author's blog count
        if (Author.incrementBlogCount) {
          await Author.incrementBlogCount(author._id);
        }

        console.log(`Created blog: ${blog.title}`);
        console.log(`  - Category: ${category.name}`);
        console.log(`  - Author: ${author.name}`);
        console.log(`  - URL: /blogs/${blog.slug}`);
        createdBlogs.push(blog);
      }
    }

    console.log('\n=== SEO Blog Seeding Complete ===');
    console.log(`Categories: ${Object.keys(categoryMap).length}`);
    console.log(`Author: ${author.name}`);
    console.log(`Blogs created/updated: ${createdBlogs.length}`);
    console.log('\nBlog URLs:');
    createdBlogs.forEach(blog => {
      console.log(`  - /blogs/${blog.slug}`);
    });

  } catch (error) {
    console.error('Seeding error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

// Run the seeder
seedSEOBlogs();
