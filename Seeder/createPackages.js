// createPackages.js - Create initial packages for GymFolio

const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('../scripts/lib/tenantScript');
const Package = require('../src/models/packageModel');

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

// Package data from GymfolioPricing component
const packagesData = [
  {
    name: 'Starter',
    price: '5,000',
    currency: 'PKR',
    period: 'per month',
    features: [
      'Gym access',
      '2 classes/week'
    ],
    theme: 'light',
    isActive: true,
    order: 1
  },
  {
    name: 'Pro',
    price: '13,000',
    currency: 'PKR',
    period: '3 months',
    features: [
      'Gym access',
      '5 classes/week',
      'Diet plan'
    ],
    theme: 'dark',
    badge: 'Popular',
    supportingText: 'Everything in our basic plan plus....',
    isActive: true,
    order: 2
  },
  {
    name: 'Elite',
    price: '25,000',
    currency: 'PKR',
    period: '6 months',
    features: [
      'All above features',
      'Personal trainer sessions',
      'Nutrition consultation',
      'Priority booking'
    ],
    theme: 'light',
    isActive: true,
    order: 3
  },
  {
    name: 'Platinum',
    price: '45,000',
    currency: 'PKR',
    period: '12 months',
    features: [
      'Full gym access',
      'Unlimited classes',
      'Regular assessments',
      'Personalized training plan',
      'Guest passes'
    ],
    theme: 'light',
    isActive: true,
    order: 4
  },
  {
    name: 'Family Pack',
    price: 'Varies',
    currency: 'PKR',
    period: 'Custom',
    features: [
      'Multi-login access',
      'Family discounts',
      'Flexible scheduling',
      'Shared trainer sessions'
    ],
    theme: 'light',
    isActive: true,
    order: 5
  },
  {
    name: 'Corporate',
    price: 'Custom',
    currency: 'PKR',
    period: 'B2B Deal',
    features: [
      'Company-wide fitness plan',
      'Group sessions',
      'Corporate wellness programs',
      'Customized packages',
      'Employee health tracking'
    ],
    theme: 'light',
    isActive: true,
    order: 6
  }
];

// Create packages
async function createPackages() {
  console.log('📦 Creating packages...\n');

  // Check if packages already exist
  const existingCount = await Package.countDocuments();
  if (existingCount > 0) {
    console.log(`⚠️  Found ${existingCount} existing packages.`);
    console.log('Do you want to delete them and create new ones? (Y/N)');
    console.log('Run with --force flag to skip this check and clear existing data.\n');

    // If force flag is not present, exit
    if (!process.argv.includes('--force')) {
      console.log('Exiting without changes. Use --force to override.');
      return [];
    }

    console.log('🗑️  Deleting existing packages...');
    await Package.deleteMany({});
    console.log('✅ Cleared existing packages.\n');
  }

  const packages = [];

  for (let i = 0; i < packagesData.length; i++) {
    const packageData = packagesData[i];

    const pkg = new Package(packageData);

    try {
      const saved = await pkg.save();
      packages.push(saved);
      console.log(`✅ Created package: ${packageData.name} - ${packageData.price} ${packageData.currency} / ${packageData.period}`);
    } catch (error) {
      console.error(`❌ Error creating package ${packageData.name}:`, error.message);
    }
  }

  return packages;
}

async function main() {
  try {
    await connectDB();
    // Every gym has its own database: --gym <slug> picks which one.
    enterContext(await resolveGymContextFromArgs());
    console.log('🚀 Starting package seeder...\n');

    const packages = await createPackages();

    console.log(`\n🎉 Successfully created ${packages.length} packages!`);

    // Show summary
    const totalPackages = await Package.countDocuments();
    const activePackages = await Package.countDocuments({ isActive: true });
    const inactivePackages = await Package.countDocuments({ isActive: false });

    console.log('\n📊 Database Summary:');
    console.log(`- Total packages: ${totalPackages}`);
    console.log(`- Active packages: ${activePackages}`);
    console.log(`- Inactive packages: ${inactivePackages}`);

    // List all packages
    console.log('\n📦 Created Packages:');
    const allPackages = await Package.find().sort({ order: 1 });
    allPackages.forEach((pkg, index) => {
      console.log(`${index + 1}. ${pkg.name} - ${pkg.price} ${pkg.currency} / ${pkg.period}`);
      console.log(`   Features: ${pkg.features.length} items`);
      if (pkg.badge) console.log(`   Badge: ${pkg.badge}`);
      console.log(`   Theme: ${pkg.theme}, Active: ${pkg.isActive}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }
}

main();
