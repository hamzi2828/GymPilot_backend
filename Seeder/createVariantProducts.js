// createVariantProducts.js - Create test variant products with exact structure

const mongoose = require('mongoose');
const crypto = require('crypto');
const Product = require('../src/models/Product');

// Database connection
async function connectDB() {
  require('dotenv').config();
  const MONGO_URI = process.env.MONGO_URI;

  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log(`✅ Connected to MongoDB Database: ${mongoose.connection.name}`);
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// Categories
const categories = [
  'Running Gear',
  'Fitness Apparel',
  'Sports Equipment',
  'Workout Gear',
  'Athletic Wear'
];

// Colors and sizes
const colors = ['Orange', 'Green', 'Black', 'White', 'Blue'];
const sizes = ['Small', 'Medium', 'Large', 'XL'];

// All available images
const allImages = [
  '/uploads/1757006235529-741331007-gym-5.svg',
  '/uploads/1757006537365-644695970-gym-2.svg',
  '/uploads/1757006694046-55411946-gym-3.svg',
  '/uploads/1757006736978-675299171-gym-4.svg',
  '/uploads/1757006771834-569938326-gym-5.svg',
  '/uploads/1757006840795-626253440-gym-2.svg',
  '/uploads/1757008029072-398978864-Orange_gym-7.svg',
  '/uploads/1757008029072-645677855-Orange_0_gym-bdetail1.svg',
  '/uploads/1757008029078-164611448-Orange_1_gym-bdetail2.svg',
  '/uploads/1757008029080-912633109-Orange_2_gym-bdetail3.svg',
  '/uploads/1757008029084-67767631-Green_1_gym-blog-2.svg',
  '/uploads/1757008029084-70113638-Green_gym-6.svg',
  '/uploads/1757008029084-92436068-Green_0_gym-blog-1.svg',
  '/uploads/1757008029086-533245630-Green_2_gym-blog-3.svg'
];

// Helper functions
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomElements(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function getRandomPrice(min = 20, max = 200) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomStock(min = 1, max = 10) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getVariantPrice(basePrice, color, size) {
  // Add small variations to the base price based on color and size
  let variantPrice = basePrice;

  // Size-based pricing
  if (size === 'XL') variantPrice += 5;
  else if (size === 'Large') variantPrice += 2;

  // Color-based pricing (premium colors might cost more)
  if (color === 'Orange' || color === 'Blue') variantPrice += 3;

  return variantPrice;
}

function getDiscountPrice(price) {
  // Randomly apply discount to some items (30% chance)
  if (Math.random() < 0.3) {
    const discount = Math.floor(Math.random() * 20) + 10; // 10-30% discount
    return Math.floor(price * (100 - discount) / 100);
  }
  return null; // No discount
}

function generateSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim('-');
}

// Generate unique variant ID
function generateVariantId(productName, color, size) {
  // Create a readable but unique ID format: PRODUCT_COLOR_SIZE_RANDOM
  const productCode = productName.split(' ').map(word => word.charAt(0)).join('').toUpperCase();
  const colorCode = color.substring(0, 3).toUpperCase();
  const sizeCode = size.charAt(0).toUpperCase();
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();

  return `${productCode}-${colorCode}-${sizeCode}-${randomSuffix}`;
}

// Generate SKU for variant
function generateVariantSKU(productName, color, size, index) {
  const productCode = productName.split(' ').map(word => word.charAt(0)).join('').toUpperCase();
  const colorCode = color.substring(0, 3).toUpperCase();
  const sizeCode = size.charAt(0).toUpperCase();
  const variantNumber = String(index + 1).padStart(2, '0');

  return `${productCode}-${colorCode}-${sizeCode}-${variantNumber}`;
}

// Product names - max 10 products
const productNames = [
  'WORDMARK CREW SOCKS 3 PACK',
  'PREMIUM WORKOUT TANK TOP',
  'ELITE SPORTS COMPRESSION LEGGINGS',
  'ULTIMATE PERFORMANCE HOODIE',
  'ATHLETIC RUNNING SHORTS',
  'PERFORMANCE TRAINING TEE',
  'CROSSFIT COMPRESSION SHIRT',
  'YOGA FLEX PANTS',
  'MARATHON RUNNING JACKET',
  'FITNESS GYM SWEATSHIRT'
];

// Cleanup existing variant products
async function cleanupVariantProducts() {
  console.log('🗑️ Cleaning up existing variant products...');

  try {
    const deleteResult = await Product.deleteMany({ productType: 'variant' });
    console.log(`✅ Deleted ${deleteResult.deletedCount} existing variant products`);

    // Also clean up any draft products that might be variants
    const draftVariants = await Product.deleteMany({
      status: 'draft',
      $or: [
        { variants: { $exists: true, $not: { $size: 0 } } },
        { colorMedia: { $exists: true } }
      ]
    });
    console.log(`✅ Deleted ${draftVariants.deletedCount} draft variant products`);

    console.log('🎯 Cleanup completed!\n');
  } catch (error) {
    console.error('❌ Error during cleanup:', error.message);
    throw error;
  }
}

async function createVariantProducts() {
  console.log('🏭 Creating new variant products with enhanced pricing and stock...');
  
  for (let i = 0; i < productNames.length; i++) {
    const baseName = productNames[i];
    const name = `${baseName} - ${getRandomElement(['PEARL WHITE', 'MIDNIGHT BLACK', 'OCEAN BLUE', 'FOREST GREEN'])}`;
    const slug = generateSlug(name);
    const category = getRandomElement(categories);
    const basePrice = getRandomPrice(40, 180); // Higher quality pricing
    
    // Generate 2-4 variants
    const variantCount = Math.floor(Math.random() * 3) + 2;
    const variants = [];
    const colorMediaMap = new Map();
    
    // Select unique color/size combinations
    const usedCombinations = new Set();
    
    for (let v = 0; v < variantCount; v++) {
      let color, size, combination;
      do {
        color = getRandomElement(colors);
        size = getRandomElement(sizes);
        combination = `${color}-${size}`;
      } while (usedCombinations.has(combination));

      usedCombinations.add(combination);

      // Generate unique variant ID and SKU
      const variantId = generateVariantId(baseName, color, size);
      const sku = generateVariantSKU(baseName, color, size, v);

      // Calculate variant-specific pricing
      const variantPrice = getVariantPrice(basePrice, color, size);
      const discountPrice = getDiscountPrice(variantPrice);
      const variantStock = getRandomStock();

      // Create variant with unique IDs and enhanced pricing
      const variant = {
        variantId: generateVariantId(baseName, color, size), // Generate unique variant ID
        color,
        size,
        price: variantPrice,
        stock: variantStock,
        sku, // Auto-generated SKU
        discountedPrice: discountPrice // Smart discount pricing
      };
      variants.push(variant);

      console.log(`   📦 Variant ${v + 1}: ${color} ${size} - $${variantPrice}${discountPrice ? ` (was $${variantPrice}, now $${discountPrice})` : ''} - Stock: ${variantStock}`);
      
      // Create colorMedia for this color if not exists
      if (!colorMediaMap.has(color)) {
        const colorSpecificImages = allImages.filter(img => 
          img.toLowerCase().includes(color.toLowerCase())
        );
        
        if (colorSpecificImages.length > 0) {
          // Use color-specific images
          colorMediaMap.set(color, {
            thumbnailUrl: colorSpecificImages[0],
            bannerUrls: colorSpecificImages.slice(1, Math.min(colorSpecificImages.length, 4))
          });
        } else {
          // Use random general images
          const randomImages = getRandomElements(allImages, 4);
          colorMediaMap.set(color, {
            thumbnailUrl: randomImages[0],
            bannerUrls: randomImages.slice(1)
          });
        }
      }
    }
    
    // Convert Map to Object for MongoDB
    const colorMedia = {};
    colorMediaMap.forEach((value, key) => {
      colorMedia[key] = value;
    });
    
    const product = new Product({
      name,
      slug,
      category,
      price: basePrice,
      stock: variants.reduce((sum, v) => sum + v.stock, 0),
      status: 'published', // Make products visible
      bannerUrls: [], // Empty for variant products as per your structure
      productType: 'variant',
      variants,
      colorMedia, // This is the key structure you need
      metaTitle: `${name} - Premium Quality`,
      metaDescription: `High-quality ${category.toLowerCase()} available in multiple colors and sizes.`,
      metaKeywords: `${category.toLowerCase()}, workout, fitness, premium, ${colors.join(', ')}`
    });
    
    try {
      await product.save();
      console.log(`✅ Created variant product: ${name}`);
      console.log(`   - Variants: ${variantCount}`);
      console.log(`   - Colors: ${Array.from(colorMediaMap.keys()).join(', ')}`);
      console.log(`   - Variant IDs: ${variants.map(v => v.variantId).join(', ')}`);
      console.log(`   - SKUs: ${variants.map(v => v.sku).join(', ')}`);
    } catch (error) {
      console.error(`❌ Error creating ${name}:`, error.message);
    }
  }
}

async function main() {
  try {
    await connectDB();
    console.log('🚀 Starting variant product recreation process...\n');

    // Step 1: Cleanup existing variant products
    await cleanupVariantProducts();

    // Step 2: Create new variant products
    await createVariantProducts();

    console.log('\n🎉 Variant product recreation completed!');

    // Show detailed summary
    const variantProducts = await Product.find({ productType: 'variant' }).populate('variants');
    console.log(`\n📊 SUMMARY:`);
    console.log(`   Total variant products: ${variantProducts.length}`);

    let totalVariants = 0;
    let totalStock = 0;
    let avgPrice = 0;
    let discountedCount = 0;

    variantProducts.forEach(product => {
      totalVariants += product.variants.length;
      product.variants.forEach(variant => {
        totalStock += variant.stock;
        avgPrice += variant.price;
        if (variant.discountedPrice) discountedCount++;
      });
    });

    if (totalVariants > 0) {
      avgPrice = (avgPrice / totalVariants).toFixed(2);
    }

    console.log(`   Total variants: ${totalVariants}`);
    console.log(`   Total stock: ${totalStock} units`);
    console.log(`   Average price: $${avgPrice}`);
    console.log(`   Products with discounts: ${discountedCount}/${totalVariants} (${((discountedCount/totalVariants)*100).toFixed(1)}%)`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n📊 Database connection closed.');
  }
}

main();