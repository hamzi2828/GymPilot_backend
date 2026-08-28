// Script to remove the deprecated 'category' field from all products
// Run with: node scripts/removeCategoryField.js

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/inkwear';

async function removeCategoryField() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const productsCollection = db.collection('products');

    // Remove 'category' field from all products
    const result = await productsCollection.updateMany(
      {}, // Match all documents
      { $unset: { category: "" } } // Remove the category field
    );

    console.log(`Updated ${result.modifiedCount} products`);
    console.log(`Matched ${result.matchedCount} products`);
    console.log('Successfully removed "category" field from all products');

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

removeCategoryField();
