// src/seeds/seedBlogContent.js
require('dotenv').config();
const mongoose = require('mongoose');
const BlogCategory = require('../models/BlogCategory');
const Author = require('../models/authorModel');
const Blog = require('../models/blogModel');

// Use environment variable or fallback
const MONGO_URI = process.env.MONGO_URI;

// Blog Categories Data (5 items)
const categoriesData = [
  {
    name: 'Fashion Trends',
    slug: 'fashion-trends',
    description: 'Latest fashion trends, seasonal styles, and outfit inspirations for the modern woman.',
    active: true,
    featured: true
  },
  {
    name: 'Style Tips',
    slug: 'style-tips',
    description: 'Expert advice on how to dress for different occasions and body types.',
    active: true,
    featured: true
  },
  {
    name: 'Behind The Scenes',
    slug: 'behind-the-scenes',
    description: 'Exclusive look at our design process, fabric selection, and craftsmanship.',
    active: true,
    featured: false
  },
  {
    name: 'Cultural Fashion',
    slug: 'cultural-fashion',
    description: 'Exploring traditional and contemporary Eastern fashion heritage.',
    active: true,
    featured: true
  },
  {
    name: 'Sustainable Fashion',
    slug: 'sustainable-fashion',
    description: 'Eco-friendly fashion choices and sustainable clothing practices.',
    active: true,
    featured: false
  }
];

// Authors Data (5 items)
const authorsData = [
  {
    name: 'Sarah Ahmed',
    email: 'sarah.ahmed@inkedwearpk.com',
    bio: 'Senior Fashion Editor with 10 years of experience in the fashion industry. Passionate about blending Eastern and Western styles.',
    active: true
  },
  {
    name: 'Fatima Khan',
    email: 'fatima.khan@inkedwearpk.com',
    bio: 'Style consultant and wardrobe expert. Helps women discover their unique fashion identity.',
    active: true
  },
  {
    name: 'Ayesha Malik',
    email: 'ayesha.malik@inkedwearpk.com',
    bio: 'Fashion designer and creative director at The Jymor. Specializes in bridal and formal wear.',
    active: true
  },
  {
    name: 'Zara Hassan',
    email: 'zara.hassan@inkedwearpk.com',
    bio: 'Fashion journalist covering trends from Paris to Lahore. Advocate for sustainable fashion.',
    active: true
  },
  {
    name: 'Nadia Iqbal',
    email: 'nadia.iqbal@inkedwearpk.com',
    bio: 'Celebrity stylist and fashion influencer with a passion for modest fashion.',
    active: true
  }
];

// Blogs Data (5 items with full content)
const blogsData = [
  {
    title: 'Top 10 Fashion Trends for Spring 2025',
    content: `
      <h2>Embrace the New Season with These Must-Have Trends</h2>
      <p>Spring 2025 brings a refreshing mix of bold statements and timeless elegance. From vibrant florals to sustainable fabrics, this season is all about expressing your unique style while staying conscious of the environment.</p>

      <h3>1. Floral Renaissance</h3>
      <p>Oversized floral prints are making a grand comeback. Think bold roses, delicate cherry blossoms, and abstract botanical patterns that add life to any outfit.</p>

      <h3>2. Pastel Power</h3>
      <p>Soft lavenders, mint greens, and blush pinks dominate the palette this season. These gentle hues create an elegant and sophisticated look perfect for any occasion.</p>

      <h3>3. Sustainable Luxe</h3>
      <p>Eco-friendly fabrics like organic cotton, bamboo silk, and recycled materials are now at the forefront of luxury fashion. Style meets sustainability in the most beautiful way.</p>

      <h3>4. Statement Sleeves</h3>
      <p>Dramatic puff sleeves, bell sleeves, and ruffled cuffs add a romantic touch to blouses and dresses. These statement pieces elevate even the simplest outfit.</p>

      <h3>5. Fusion Wear</h3>
      <p>The blend of Eastern and Western silhouettes continues to trend. Think kurtas with modern cuts, fusion sarees, and contemporary takes on traditional wear.</p>

      <p>Stay tuned for more fashion updates and styling tips from our expert team!</p>
    `,
    status: 'published',
    featured: true,
    image: '/uploads/blogs/spring-trends-2025.jpg',
    tags: ['spring', 'trends', 'fashion', '2025', 'style'],
    metaTitle: 'Top 10 Fashion Trends for Spring 2025 | The Jymor',
    metaDescription: 'Discover the hottest fashion trends for Spring 2025. From floral prints to sustainable fabrics, find your perfect spring style.',
    metaKeywords: 'spring fashion 2025, fashion trends, sustainable fashion, floral prints'
  },
  {
    title: 'How to Build a Capsule Wardrobe: Essential Guide',
    content: `
      <h2>Simplify Your Style with a Capsule Wardrobe</h2>
      <p>A capsule wardrobe is a curated collection of essential, timeless pieces that can be mixed and matched to create countless outfits. Here's your complete guide to building one.</p>

      <h3>Understanding the Capsule Concept</h3>
      <p>The idea is simple: own fewer clothes but make them count. A typical capsule wardrobe contains 30-40 versatile pieces that work for all seasons and occasions.</p>

      <h3>Essential Pieces to Include</h3>
      <ul>
        <li><strong>Classic White Shirt:</strong> The foundation of any wardrobe</li>
        <li><strong>Well-Fitted Blazer:</strong> Instantly elevates any look</li>
        <li><strong>Little Black Dress:</strong> Timeless and versatile</li>
        <li><strong>Quality Denim:</strong> A perfect pair of jeans</li>
        <li><strong>Neutral Trousers:</strong> For professional settings</li>
      </ul>

      <h3>Color Palette Selection</h3>
      <p>Stick to a cohesive color palette. Neutrals like black, white, navy, and beige form the base, while one or two accent colors add personality.</p>

      <h3>Quality Over Quantity</h3>
      <p>Invest in well-made pieces that will last. Quality fabrics and construction mean your clothes will look better for longer and save you money in the long run.</p>

      <p>Start your capsule wardrobe journey today and experience the freedom of simplified style!</p>
    `,
    status: 'published',
    featured: true,
    image: '/uploads/blogs/capsule-wardrobe-guide.jpg',
    tags: ['capsule wardrobe', 'minimalism', 'essentials', 'style guide'],
    metaTitle: 'How to Build a Capsule Wardrobe | Complete Guide | The Jymor',
    metaDescription: 'Learn how to build a perfect capsule wardrobe with our essential guide. Simplify your style and maximize your outfit options.',
    metaKeywords: 'capsule wardrobe, minimalist fashion, wardrobe essentials, style guide'
  },
  {
    title: 'The Art of Traditional Embroidery in Modern Fashion',
    content: `
      <h2>Celebrating Heritage Through Contemporary Design</h2>
      <p>Traditional embroidery techniques have been passed down through generations, and today they're finding new life in modern fashion. Discover how ancient artistry meets contemporary style.</p>

      <h3>Rich Heritage of Pakistani Embroidery</h3>
      <p>From intricate Sindhi mirror work to delicate Kashmiri embroidery, Pakistan boasts a rich textile heritage. Each region brings its unique patterns, techniques, and stories.</p>

      <h3>Types of Traditional Embroidery</h3>
      <h4>Chikankari</h4>
      <p>This delicate white-on-white embroidery from Lucknow creates subtle, elegant patterns perfect for summer wear.</p>

      <h4>Phulkari</h4>
      <p>Vibrant geometric patterns in bold colors, traditionally from Punjab, add a festive touch to any garment.</p>

      <h4>Zardozi</h4>
      <p>Luxurious gold and silver threadwork that transforms bridal wear into wearable art.</p>

      <h3>Modern Interpretations</h3>
      <p>Contemporary designers are reimagining these traditional techniques on modern silhouettes. A simple Western-cut dress becomes extraordinary with hand-embroidered details.</p>

      <h3>Preserving Craftsmanship</h3>
      <p>By choosing handcrafted embroidered pieces, you're supporting artisan communities and preserving centuries-old traditions.</p>
    `,
    status: 'published',
    featured: false,
    image: '/uploads/blogs/traditional-embroidery.jpg',
    tags: ['embroidery', 'traditional', 'craftsmanship', 'heritage', 'artisan'],
    metaTitle: 'Traditional Embroidery in Modern Fashion | The Jymor',
    metaDescription: 'Explore the beautiful world of traditional embroidery and how it enhances modern fashion. Discover Chikankari, Phulkari, and Zardozi.',
    metaKeywords: 'traditional embroidery, Pakistani fashion, Chikankari, Phulkari, Zardozi'
  },
  {
    title: 'Dressing for Different Body Types: A Complete Guide',
    content: `
      <h2>Celebrate Your Shape with the Right Styles</h2>
      <p>Every body is beautiful, and the right clothing choices can help you feel confident and comfortable. Here's how to dress for your unique body type.</p>

      <h3>Understanding Body Shapes</h3>
      <p>While everybody is unique, understanding common body shapes can help guide your style choices. Remember, these are guidelines, not rules!</p>

      <h3>Pear Shape</h3>
      <p>Characterized by wider hips and narrower shoulders. Highlight your upper body with detailed necklines, statement sleeves, and structured shoulders. A-line skirts balance proportions beautifully.</p>

      <h3>Apple Shape</h3>
      <p>Fuller midsection with slimmer legs. Empire waists, V-necklines, and flowing fabrics create a flattering silhouette. Show off those legs with shorter hemlines!</p>

      <h3>Hourglass Shape</h3>
      <p>Balanced bust and hips with a defined waist. Celebrate your curves with fitted styles, wrap dresses, and belted pieces that emphasize your natural waist.</p>

      <h3>Rectangle Shape</h3>
      <p>Balanced proportions with less defined waist. Create curves with peplum tops, ruffles, and structured pieces. Belts can help define your waistline.</p>

      <h3>The Most Important Rule</h3>
      <p>Wear what makes you feel confident and happy. Fashion rules are meant to be broken, and personal style trumps all guidelines!</p>
    `,
    status: 'published',
    featured: true,
    image: '/uploads/blogs/body-types-guide.jpg',
    tags: ['body types', 'styling', 'fashion tips', 'confidence', 'guide'],
    metaTitle: 'Dressing for Different Body Types | Style Guide | The Jymor',
    metaDescription: 'Learn how to dress for your body type with our complete style guide. Tips for pear, apple, hourglass, and rectangle body shapes.',
    metaKeywords: 'body type fashion, style guide, dressing tips, body shape styling'
  },
  {
    title: 'Sustainable Fashion: Making Eco-Friendly Choices',
    content: `
      <h2>Fashion That Cares for the Planet</h2>
      <p>The fashion industry is one of the largest polluters globally. But as conscious consumers, we have the power to make a difference. Here's how to embrace sustainable fashion.</p>

      <h3>Understanding Fast Fashion</h3>
      <p>Fast fashion's cheap prices come at a cost: poor working conditions, environmental damage, and mountains of textile waste. The first step to sustainable fashion is awareness.</p>

      <h3>Sustainable Fabric Choices</h3>
      <ul>
        <li><strong>Organic Cotton:</strong> Grown without harmful pesticides</li>
        <li><strong>Linen:</strong> Natural, biodegradable, and long-lasting</li>
        <li><strong>Tencel:</strong> Made from sustainably sourced wood pulp</li>
        <li><strong>Recycled Materials:</strong> Giving new life to existing textiles</li>
      </ul>

      <h3>Building a Sustainable Wardrobe</h3>
      <h4>Buy Less, Choose Well</h4>
      <p>Invest in quality pieces that will last years, not trends that last weeks. A well-made garment is always more sustainable.</p>

      <h4>Care for Your Clothes</h4>
      <p>Proper washing, storage, and repairs extend the life of your garments significantly. Learn basic mending skills!</p>

      <h4>Second-Hand Shopping</h4>
      <p>Vintage and thrift stores are treasure troves of unique pieces. Pre-loved fashion reduces demand for new production.</p>

      <h3>Our Commitment at The Jymor</h3>
      <p>We're committed to sustainable practices, from eco-friendly packaging to partnering with ethical manufacturers. Fashion can be beautiful and responsible.</p>
    `,
    status: 'published',
    featured: false,
    image: '/uploads/blogs/sustainable-fashion.jpg',
    tags: ['sustainable', 'eco-friendly', 'environment', 'conscious fashion'],
    metaTitle: 'Sustainable Fashion: Eco-Friendly Choices | The Jymor',
    metaDescription: 'Discover how to make sustainable fashion choices. Learn about eco-friendly fabrics, ethical shopping, and building a conscious wardrobe.',
    metaKeywords: 'sustainable fashion, eco-friendly clothing, ethical fashion, conscious consumer'
  }
];

async function seedBlogContent() {
  try {
    // Connect to MongoDB
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000
    });
    console.log('Connected to MongoDB');

    // Seed Categories
    console.log('\n--- Seeding Blog Categories ---');
    const createdCategories = [];
    for (const categoryData of categoriesData) {
      const existingCategory = await BlogCategory.findOne({ slug: categoryData.slug });
      if (existingCategory) {
        console.log(`Category "${categoryData.name}" already exists, updating...`);
        Object.assign(existingCategory, categoryData);
        await existingCategory.save();
        createdCategories.push(existingCategory);
      } else {
        const category = await BlogCategory.create(categoryData);
        console.log(`Created category: ${category.name}`);
        createdCategories.push(category);
      }
    }
    console.log(`Total categories: ${createdCategories.length}`);

    // Seed Authors
    console.log('\n--- Seeding Authors ---');
    const createdAuthors = [];
    for (const authorData of authorsData) {
      const existingAuthor = await Author.findOne({ email: authorData.email });
      if (existingAuthor) {
        console.log(`Author "${authorData.name}" already exists, updating...`);
        Object.assign(existingAuthor, authorData);
        await existingAuthor.save();
        createdAuthors.push(existingAuthor);
      } else {
        const author = await Author.create(authorData);
        console.log(`Created author: ${author.name}`);
        createdAuthors.push(author);
      }
    }
    console.log(`Total authors: ${createdAuthors.length}`);

    // Seed Blogs
    console.log('\n--- Seeding Blogs ---');
    const createdBlogs = [];
    for (let i = 0; i < blogsData.length; i++) {
      const blogData = blogsData[i];

      // Assign category and author (cycling through them)
      const category = createdCategories[i % createdCategories.length];
      const author = createdAuthors[i % createdAuthors.length];

      // Check if blog with similar title exists
      const existingBlog = await Blog.findOne({
        title: blogData.title
      });

      if (existingBlog) {
        console.log(`Blog "${blogData.title}" already exists, skipping...`);
        createdBlogs.push(existingBlog);
      } else {
        const blog = await Blog.create({
          ...blogData,
          categoryId: category._id,
          author: author._id
        });

        // Increment author's blog count
        await Author.incrementBlogCount(author._id);

        console.log(`Created blog: ${blog.title}`);
        console.log(`  - Category: ${category.name}`);
        console.log(`  - Author: ${author.name}`);
        createdBlogs.push(blog);
      }
    }
    console.log(`Total blogs: ${createdBlogs.length}`);

    console.log('\n=== Seeding Complete ===');
    console.log(`Categories: ${createdCategories.length}`);
    console.log(`Authors: ${createdAuthors.length}`);
    console.log(`Blogs: ${createdBlogs.length}`);

  } catch (error) {
    console.error('Seeding error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

// Run the seeder
seedBlogContent();
