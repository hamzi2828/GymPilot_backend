// src/seeds/seedDiscounts.js
const mongoose = require('mongoose');
const Discount = require('../models/discount');
require('dotenv').config();

// Sample discount coupons
const discounts = [
  {
    code: 'WELCOME10',
    description: 'Welcome discount for new customers - 10% off first order',
    discountType: 'percentage',
    discountValue: 10,
    minimumOrderAmount: 0,
    maximumDiscount: 500,
    usageLimit: null,
    usedCount: 0,
    startDate: new Date(),
    endDate: null,
    isActive: true,
  },
  {
    code: 'SUMMER25',
    description: 'Summer sale - 25% off on orders above Rs 2000',
    discountType: 'percentage',
    discountValue: 25,
    minimumOrderAmount: 2000,
    maximumDiscount: 1000,
    usageLimit: 100,
    usedCount: 0,
    startDate: new Date(),
    endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
    isActive: true,
  },
  {
    code: 'FLAT500',
    description: 'Flat Rs 500 off on orders above Rs 3000',
    discountType: 'fixed',
    discountValue: 500,
    minimumOrderAmount: 3000,
    maximumDiscount: null,
    usageLimit: 50,
    usedCount: 0,
    startDate: new Date(),
    endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days from now
    isActive: true,
  },
  {
    code: 'VIP50',
    description: 'VIP exclusive - 50% off (max Rs 2000 discount)',
    discountType: 'percentage',
    discountValue: 50,
    minimumOrderAmount: 5000,
    maximumDiscount: 2000,
    usageLimit: 20,
    usedCount: 0,
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
    isActive: true,
  },
  {
    code: 'FREESHIP',
    description: 'Free shipping - Rs 200 off (covers shipping cost)',
    discountType: 'fixed',
    discountValue: 200,
    minimumOrderAmount: 1000,
    maximumDiscount: null,
    usageLimit: null,
    usedCount: 0,
    startDate: new Date(),
    endDate: null,
    isActive: true,
  },
];

async function seedDiscounts() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/InkedWear';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    let createdCount = 0;
    let skippedCount = 0;

    for (const discountData of discounts) {
      // Check if discount code already exists
      const existingDiscount = await Discount.findOne({ code: discountData.code });

      if (existingDiscount) {
        console.log(`Skipped (already exists): ${discountData.code}`);
        skippedCount++;
      } else {
        await Discount.create(discountData);
        console.log(`Created: ${discountData.code} - ${discountData.description}`);
        createdCount++;
      }
    }

    console.log('\n========================================');
    console.log('Discounts seeded successfully!');
    console.log(`Created: ${createdCount}`);
    console.log(`Skipped (already exist): ${skippedCount}`);
    console.log('========================================\n');

    // Print summary
    const allDiscounts = await Discount.find();
    console.log('Discount Summary:');
    console.log(`Total discounts: ${allDiscounts.length}`);
    console.log(`Active: ${allDiscounts.filter(d => d.isActive).length}`);
    console.log(`Percentage type: ${allDiscounts.filter(d => d.discountType === 'percentage').length}`);
    console.log(`Fixed type: ${allDiscounts.filter(d => d.discountType === 'fixed').length}`);

    console.log('\nDiscount Codes:');
    allDiscounts.forEach(d => {
      const value = d.discountType === 'percentage' ? `${d.discountValue}%` : `Rs ${d.discountValue}`;
      const minOrder = d.minimumOrderAmount > 0 ? ` (Min: Rs ${d.minimumOrderAmount})` : '';
      console.log(`  - ${d.code}: ${value} off${minOrder}`);
    });

  } catch (error) {
    console.error('Error seeding discounts:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seedDiscounts();
