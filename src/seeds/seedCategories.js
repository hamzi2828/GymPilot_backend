// src/seeds/seedCategories.js
// Based on The Jymor Pakistan SEO Strategy PDF - March 2026
const mongoose = require('mongoose');
const Category = require('../models/category');
require('dotenv').config();

const slugify = (str) =>
  str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

// Complete category structure from SEO Strategy PDF
const categoryStructure = [
  // ============ MEN'S COLLECTION ============
  {
    name: "Men's Collection",
    slug: 'mens-wear',
    description: "From the comfort of a well-cut kurta on a Friday afternoon to the sharp finish of a formal shalwar kameez on Eid — The Jymor's men's collection covers every moment and every occasion.",
    featured: true,
    active: true,
    children: [
      // Men's Shalwar Kameez
      {
        name: 'Shalwar Kameez',
        slug: 'mens-shalwar-kameez',
        description: "The shalwar kameez is more than Pakistan's national dress — it's a daily uniform, a festive statement, and a cultural identity worn by millions.",
        children: [
          { name: 'Casual Shalwar Kameez', slug: 'casual-shalwar-kameez', description: 'Cotton and lawn blends for everyday wear' },
          { name: 'Formal Shalwar Kameez', slug: 'formal-shalwar-kameez', description: 'Wash-and-wear and embroidered options for weddings and events' },
          { name: 'Eid & Festive Shalwar Kameez', slug: 'eid-festive-shalwar-kameez', description: 'Premium fabrics for special occasions' },
          { name: 'Slim Fit Shalwar Kameez', slug: 'slim-fit-shalwar-kameez', description: 'Modern, tailored cuts for the urban man' },
          { name: 'Kurta Pajama Sets', slug: 'kurta-pajama-sets', description: 'Coordinated sets for ease and elegance' },
        ],
      },
      // Men's Kurta
      {
        name: 'Kurta',
        slug: 'mens-kurta',
        description: 'The kurta is the most versatile piece in a Pakistani man\'s wardrobe. Wear it with shalwar for a traditional look, or pair it with jeans for a smart-casual edge.',
        children: [
          { name: 'Plain Cotton Kurta', slug: 'plain-cotton-kurta', description: 'The everyday essential in breathable cotton' },
          { name: 'Embroidered Kurta', slug: 'embroidered-kurta', description: 'Intricate threadwork for weddings, Eid and formal events' },
          { name: 'Kurta with Jeans Style', slug: 'kurta-jeans-style', description: 'Modern cuts designed to pair with denim' },
          { name: 'Festive & Eid Kurta', slug: 'festive-eid-kurta', description: 'Premium fabrics and detailed craftsmanship for special occasions' },
          { name: 'Waistcoat Sets', slug: 'waistcoat-sets', description: 'Kurta with matching waistcoat for a complete, polished look' },
        ],
      },
      // Men's T-Shirts & Polo Shirts
      {
        name: 'T-Shirts & Polo Shirts',
        slug: 'mens-tshirts',
        description: 'A great T-shirt is the backbone of casual dressing. Premium cotton quality, modern fits, and designs ranging from clean graphic prints to classic solid colours.',
        children: [
          { name: 'Plain T-Shirts', slug: 'plain-tshirts', description: 'Solid colour basics in 100% cotton and poly-cotton blends' },
          { name: 'Graphic Tees', slug: 'graphic-tees', description: 'Bold prints, street-ready designs, and Pakistan-inspired graphics' },
          { name: 'Polo Shirts', slug: 'polo-shirts', description: 'Half-sleeve and full-sleeve polos for casual and semi-formal wear' },
          { name: 'Oversized Tees', slug: 'oversized-tees', description: 'Relaxed, streetwear-inspired cuts for the younger crowd' },
          { name: 'V-Neck & Crew Neck', slug: 'vneck-crewneck', description: 'Classic cuts in everyday fabrics' },
        ],
      },
      // Men's Casual & Formal Shirts
      {
        name: 'Casual & Formal Shirts',
        slug: 'mens-shirts',
        description: 'Whether you\'re heading to the office, a dinner, or a weekend outing — the right shirt makes all the difference.',
        children: [
          { name: 'Formal Dress Shirts', slug: 'formal-dress-shirts', description: 'Crisp, well-tailored shirts for office and formal events' },
          { name: 'Casual Shirts', slug: 'casual-shirts', description: 'Checked, printed, and plain shirts for everyday wear' },
          { name: 'Oxford Shirts', slug: 'oxford-shirts', description: 'The smart-casual staple, available in classic colours' },
          { name: 'Linen Shirts', slug: 'linen-shirts', description: 'Breathable summer shirts perfect for Pakistan\'s hot months' },
        ],
      },
      // Men's Jeans & Trousers
      {
        name: 'Jeans & Trousers',
        slug: 'mens-bottoms',
        description: 'From slim-fit jeans for weekend outings to chino trousers for a smart office look — quality, style, and value.',
        children: [
          { name: 'Slim Fit Jeans', slug: 'slim-fit-jeans', description: 'Modern tapered denim for the urban Pakistani man' },
          { name: 'Straight Fit Jeans', slug: 'straight-fit-jeans', description: 'Relaxed, classic denim that pairs with everything' },
          { name: 'Chino Trousers', slug: 'chino-trousers', description: 'Smart-casual cotton chinos for office and casual outings' },
          { name: 'Cargo Trousers', slug: 'cargo-trousers', description: 'Functional, durable designs with extra pocket space' },
          { name: 'Formal Trousers', slug: 'formal-trousers', description: 'Dress trousers for formal occasions and office wear' },
        ],
      },
      // Men's Joggers & Activewear
      {
        name: 'Joggers & Activewear',
        slug: 'mens-activewear',
        description: 'Whether you\'re hitting the gym, taking a morning walk, or spending a rest day at home — soft French Terry fabrics, elasticated waistbands, and relaxed fits.',
        children: [
          { name: 'Jogger Pants', slug: 'jogger-pants', description: 'Tapered, soft-waist joggers in cotton and French Terry' },
          { name: 'Gym Shorts', slug: 'gym-shorts', description: 'Lightweight shorts for training and everyday casual wear' },
          { name: 'Sweatpants', slug: 'sweatpants', description: 'Relaxed-fit sweatpants for cooler days and rest days' },
          { name: 'Tracksuit Sets', slug: 'tracksuit-sets', description: 'Matching top and bottom sets for a complete sporty look' },
        ],
      },
      // Men's Hoodies & Jackets
      {
        name: 'Hoodies & Jackets',
        slug: 'mens-winterwear',
        description: 'When Pakistan\'s winters arrive, style doesn\'t have to take a back seat. Pullover and zip-up hoodies, bomber jackets, and sweatshirts.',
        children: [
          { name: 'Pullover Hoodies', slug: 'pullover-hoodies', description: 'Classic pull-over hoodies in cotton and fleece' },
          { name: 'Zip-Up Hoodies', slug: 'zip-up-hoodies', description: 'Versatile zip hoodies for easy layering' },
          { name: 'Sweatshirts', slug: 'sweatshirts', description: 'Clean, mid-weight sweatshirts for transitional weather' },
          { name: 'Bomber Jackets', slug: 'bomber-jackets', description: 'Street-ready bombers for casual urban styling' },
        ],
      },
      // Men's Loungewear & Pajamas
      {
        name: 'Loungewear & Pajamas',
        slug: 'mens-loungewear',
        description: 'You spend hours at home — you deserve to be comfortable. Woven and jersey pajamas, nightsuits, and casual shorts.',
        children: [
          { name: 'Woven Pajama Sets', slug: 'woven-pajama-sets', description: 'Traditional woven cotton pajamas for classic comfort' },
          { name: 'Jersey Pajamas', slug: 'jersey-pajamas', description: 'Soft jersey knit pajamas for light, flexible sleep' },
          { name: 'Nightsuit Sets', slug: 'mens-nightsuit-sets', description: 'Coordinated top and bottom sets in breathable fabrics' },
        ],
      },
      // Men's Underwear & Vests
      {
        name: 'Underwear & Vests',
        slug: 'mens-undergarments',
        description: 'Good basics are the foundation of a great wardrobe. 100% breathable cotton — soft, supportive, and designed for Pakistan\'s climate.',
        children: [
          { name: 'Cotton Briefs', slug: 'cotton-briefs', description: 'Classic, comfortable hip briefs in black, white and grey' },
          { name: 'Boxer Trunks', slug: 'boxer-trunks', description: 'Modern, fitted boxer-style trunks for everyday wear' },
          { name: 'Boxer Shorts', slug: 'boxer-shorts', description: 'Relaxed woven boxer shorts for comfort at home' },
          { name: 'Undershirt Vests', slug: 'undershirt-vests', description: 'V-neck and crew neck vests as under-layers' },
          { name: 'Socks', slug: 'mens-socks', description: 'Crew socks, ankle socks and no-show socks in multi-packs' },
        ],
      },
    ],
  },

  // ============ WOMEN'S COLLECTION ============
  {
    name: "Women's Collection",
    slug: 'womens-wear',
    description: "Effortless style for the Pakistani woman — whether you're dressing for a wedding, a family gathering, a day at the office, or a lazy weekend at home.",
    featured: true,
    active: true,
    children: [
      // Women's Pret Dresses
      {
        name: 'Pret Dresses',
        slug: 'womens-pret',
        description: 'Pret — meaning ready-to-wear — beautifully crafted, immediately wearable outfits styled for every occasion from casual days to formal events.',
        children: [
          { name: 'Casual Pret', slug: 'casual-pret', description: 'Everyday kurtas, short shirts and relaxed separates' },
          { name: 'Formal Pret', slug: 'formal-pret', description: 'Embroidered and embellished pieces for dinners and gatherings' },
          { name: '1-Piece Pret', slug: '1-piece-pret', description: 'Standalone shirts and kurtas for mix-and-match styling' },
          { name: '2-Piece Sets', slug: '2-piece-sets', description: 'Coordinated shirt and trouser sets' },
          { name: '3-Piece Sets', slug: '3-piece-sets', description: 'Complete co-ordinated outfits with dupatta' },
        ],
      },
      // Women's Lawn Suits
      {
        name: 'Lawn Suits',
        slug: 'womens-lawn',
        description: 'When the temperature rises across Pakistan, one fabric reigns supreme: lawn. Lightweight, breathable, and beautifully printable.',
        children: [
          { name: 'Printed Lawn Suits', slug: 'printed-lawn-suits', description: 'Bold and subtle prints for casual and semi-casual wear' },
          { name: 'Embroidered Lawn', slug: 'embroidered-lawn', description: 'Delicate embroidery work on premium lawn fabric' },
          { name: 'Unstitched Lawn', slug: 'unstitched-lawn', description: 'Choose your own stitching style for a personalised fit' },
          { name: 'Stitched Lawn Suits', slug: 'stitched-lawn-suits', description: 'Ready-to-wear, true to size for zero hassle' },
          { name: '2-Piece Lawn', slug: '2-piece-lawn', description: 'Shirt and trouser sets without a dupatta for everyday ease' },
          { name: '3-Piece Lawn', slug: '3-piece-lawn', description: 'Complete sets with dupatta for a polished look' },
        ],
      },
      // Women's Shalwar Kameez & Kurta Sets
      {
        name: 'Shalwar Kameez & Kurta Sets',
        slug: 'womens-eastern',
        description: 'The shalwar kameez is Pakistan\'s most iconic outfit — versatile, elegant, and expressive forms of dress.',
        children: [
          { name: 'Cotton Shalwar Kameez', slug: 'cotton-shalwar-kameez', description: 'Breathable, everyday wear in printed and plain fabrics' },
          { name: 'Khaddar Suits', slug: 'khaddar-suits', description: 'Winter-weight khaddar for the colder months' },
          { name: 'Silk & Chiffon Formal', slug: 'silk-chiffon-formal', description: 'Elegant fabrics for weddings and formal dinners' },
          { name: 'Embroidered Kurta Sets', slug: 'embroidered-kurta-sets', description: 'Detailed embroidery work for festive occasions' },
          { name: 'Kurta with Palazzo', slug: 'kurta-palazzo', description: 'Modern pairing with wide-leg trousers' },
        ],
      },
      // Women's Co-Ords & Matching Sets
      {
        name: 'Co-Ords & Matching Sets',
        slug: 'womens-coords',
        description: 'Co-ords take the guesswork out of getting dressed. Everything already matches — the colours, the fabric, the vibe.',
        children: [
          { name: 'Casual Co-Ords', slug: 'casual-coords', description: 'Cotton and jersey matching sets for everyday comfort' },
          { name: 'Formal Co-Ords', slug: 'formal-coords', description: 'Embellished and embroidered sets for dinners and gatherings' },
          { name: 'Loungewear Co-Ords', slug: 'loungewear-coords', description: 'Comfortable matching sets for the home' },
        ],
      },
      // Women's Western Wear
      {
        name: 'Western Wear',
        slug: 'womens-western',
        description: 'For the Pakistani woman who loves to mix Eastern and Western styles — stylish, modest, and affordable options.',
        children: [
          { name: 'Casual Tops & Shirts', slug: 'casual-tops-shirts', description: 'Everyday tops in cotton and blended fabrics' },
          { name: 'Wide-Leg Trousers', slug: 'wide-leg-trousers', description: 'Modern, modest trouser cuts for all occasions' },
          { name: 'Women\'s Jeans', slug: 'womens-jeans', description: 'Straight fit and wide-leg denim for everyday wear' },
          { name: 'Women\'s Sweatshirts', slug: 'womens-sweatshirts', description: 'Casual pullovers for cooler days' },
          { name: 'Women\'s Cargo Pants', slug: 'womens-cargo-pants', description: 'Trendy, functional cargo styling' },
        ],
      },
      // Women's Activewear
      {
        name: 'Activewear',
        slug: 'womens-activewear',
        description: 'Comfortable, stylish, and modest athletic wear that lets you move freely and feel confident.',
        children: [
          { name: 'Leggings', slug: 'leggings', description: 'Full-length and 3/4 leggings in stretchy, breathable fabric' },
          { name: 'Sports Tops', slug: 'sports-tops', description: 'Relaxed and fitted tops for training and casual active wear' },
          { name: 'Training Sets', slug: 'training-sets', description: 'Matching legging and top sets for a complete gym look' },
          { name: 'Yoga Wear', slug: 'yoga-wear', description: 'Soft, flexible fabric for low-impact workouts' },
        ],
      },
      // Women's Nightwear & Loungewear
      {
        name: 'Nightwear & Loungewear',
        slug: 'womens-nightwear',
        description: 'Your nighttime routine deserves thoughtful dressing too. Soft cotton pajama sets, printed nightsuits, and comfortable loungewear.',
        children: [
          { name: 'Nightsuit Sets', slug: 'womens-nightsuit-sets', description: 'Co-ordinated shirt and pyjama sets in soft cotton' },
          { name: 'Woven Pajamas', slug: 'womens-woven-pajamas', description: 'Traditional woven cotton for breathable sleep comfort' },
          { name: 'Jersey Loungewear', slug: 'jersey-loungewear', description: 'Stretchy jersey knit for flexibility and softness' },
          { name: 'Printed Nightwear', slug: 'printed-nightwear', description: 'Fun and feminine prints for the bedroom' },
        ],
      },
    ],
  },

  // ============ SPECIAL COLLECTIONS ============
  {
    name: 'New Arrivals',
    slug: 'new-arrivals',
    description: 'New styles just landed. Be the first to wear what\'s new — the latest cuts, fabrics, and prints for men and women.',
    featured: true,
    active: true,
    children: [],
  },
  {
    name: 'Sale',
    slug: 'sale',
    description: 'Shop our sale collection — great styles at unbeatable prices. Limited stock available.',
    featured: true,
    active: true,
    children: [],
  },
];

// Recursive function to create categories
async function createCategoryWithChildren(categoryData, parentId = null, level = 0) {
  const { children, ...data } = categoryData;

  const indent = '  '.repeat(level);

  // Check if category already exists
  let category = await Category.findOne({ slug: data.slug });

  if (category) {
    // Update existing category
    await Category.findByIdAndUpdate(category._id, {
      ...data,
      parentId,
      active: true,
      featured: data.featured || false,
    });
    console.log(`${indent}Updated: ${data.name}`);
  } else {
    // Create new category
    category = await Category.create({
      ...data,
      parentId,
      active: true,
      featured: data.featured || false,
    });
    console.log(`${indent}Created: ${data.name}`);
  }

  // Process children recursively
  if (children && children.length > 0) {
    for (const child of children) {
      await createCategoryWithChildren(child, category._id, level + 1);
    }
  }

  return category;
}

async function seedCategories() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/InkedWear';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB\n');

    // Clear existing categories (optional - comment out if you want to preserve existing)
    // await Category.deleteMany({});
    // console.log('Cleared existing categories\n');

    console.log('Seeding categories from The Jymor SEO Strategy...\n');

    for (const categoryData of categoryStructure) {
      await createCategoryWithChildren(categoryData);
      console.log(''); // Empty line between top-level categories
    }

    // Print summary
    const allCategories = await Category.find();
    const rootCategories = allCategories.filter(c => !c.parentId);
    const childCategories = allCategories.filter(c => c.parentId);

    console.log('========================================');
    console.log('Categories seeded successfully!');
    console.log('========================================');
    console.log(`Total categories: ${allCategories.length}`);
    console.log(`Root categories: ${rootCategories.length}`);
    console.log(`Subcategories: ${childCategories.length}`);
    console.log('========================================\n');

  } catch (error) {
    console.error('Error seeding categories:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

seedCategories();
