// createSingleProducts.js - Create 10 single products at once

const mongoose = require('mongoose');
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
  '/uploads/1757008029086-533245630-Green_2_gym-blog-3.svg',
  '/uploads/1757008669072-779073397-gym-6.svg',
  '/uploads/1757008669073-854684101-gym-bdetail1.svg',
  '/uploads/1757008669078-172119998-gym-bdetail2.svg',
  '/uploads/1757008669081-632390063-gym-bdetail3.svg',
  '/uploads/1757008669084-649084708-gym-bdetail3.svg',
  '/uploads/1757008669086-773753972-gym-blog-2.svg'
];

// Single product names
const singleProductNames = [
  'Premium Yoga Mat',
  'Resistance Bands Set',
  'Steel Water Bottle',
  'Microfiber Gym Towel',
  'Foam Roller Pro',
  'Jump Rope Speed',
  'Exercise Ball Large',
  'Weightlifting Belt',
  'Gym Gloves Pro',
  'Protein Shaker Bottle',
  'Fitness Tracker Band',
  'Ankle Weights Set',
  'Push-Up Handles',
  'Gym Bag Duffel',
  'Recovery Massage Ball'
];

// Helper functions
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomElements(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function getRandomPrice(min = 15, max = 150) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomStock(min = 5, max = 100) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateSlug(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim('-') + '-' + Date.now() + Math.floor(Math.random() * 1000);
}

// Product descriptions
const getProductDescription = (name, category) => {
  const descriptions = {
    'Premium Yoga Mat': 'High-quality non-slip yoga mat perfect for all types of workouts',
    'Resistance Bands Set': 'Complete set of resistance bands with varying strengths',
    'Steel Water Bottle': 'Insulated stainless steel water bottle keeps drinks cold for hours',
    'Microfiber Gym Towel': 'Ultra-absorbent and quick-dry microfiber towel',
    'Foam Roller Pro': 'Professional foam roller for muscle recovery and massage',
    'Jump Rope Speed': 'High-speed jump rope with adjustable length',
    'Exercise Ball Large': 'Anti-burst exercise ball for core strengthening',
    'Weightlifting Belt': 'Heavy-duty leather weightlifting belt for support',
    'Gym Gloves Pro': 'Professional gym gloves with superior grip',
    'Protein Shaker Bottle': 'Leak-proof protein shaker with mixing ball'
  };
  
  return descriptions[name] || `Premium ${category.toLowerCase()} equipment for serious athletes`;
};

async function createSingleProducts() {
  console.log('🚀 Creating 10 single products...');
  
  let createdCount = 0;
  const selectedNames = getRandomElements(singleProductNames, 10);
  
  for (let i = 0; i < selectedNames.length; i++) {
    const name = selectedNames[i];
    const slug = generateSlug(name);
    const category = getRandomElement(categories);
    const price = getRandomPrice();
    const discountedPrice = Math.random() > 0.6 ? price - Math.floor(Math.random() * (price * 0.3)) : undefined;
    const stock = getRandomStock();
    
    // Select random images for this product
    const thumbnailUrl = getRandomElement(allImages);
    const bannerUrls = getRandomElements(allImages.filter(img => img !== thumbnailUrl), Math.floor(Math.random() * 4) + 1);
    
    const product = new Product({
      name,
      slug,
      category,
      price,
      discountedPrice,
      stock,
      status: Math.random() > 0.3 ? 'published' : 'draft', // 70% published, 30% draft
      thumbnailUrl,
      bannerUrls,
      productType: 'single',
      variants: [], // Empty for single products
      metaTitle: `${name} - Premium Quality ${category}`,
      metaDescription: getProductDescription(name, category),
      metaKeywords: `${category.toLowerCase()}, fitness, gym, equipment, ${name.toLowerCase().replace(/\s+/g, ', ')}`
    });
    
    try {
      await product.save();
      createdCount++;
      console.log(`✅ Created: ${name} (${category}) - $${price}${discountedPrice ? ` (Sale: $${discountedPrice})` : ''}`);
    } catch (error) {
      console.error(`❌ Error creating ${name}:`, error.message);
    }
  }
  
  return createdCount;
}

async function main() {
  try {
    await connectDB();
    console.log('🎯 Starting single product generation...\n');
    
    const created = await createSingleProducts();
    
    console.log(`\n🎉 Successfully created ${created}/10 single products!`);
    
    // Show summary
    const singleProducts = await Product.find({ productType: 'single' });
    const variantProducts = await Product.find({ productType: 'variant' });
    
    console.log('\n📊 Database Summary:');
    console.log(`- Single products: ${singleProducts.length}`);
    console.log(`- Variant products: ${variantProducts.length}`);
    console.log(`- Total products: ${singleProducts.length + variantProducts.length}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed.');
  }
}

main();