// Script to clean up unused MongoDB collections
// Run with: node scripts/cleanupCollections.js

require('dotenv').config();
const mongoose = require('mongoose');

// Collections actually used by the application
const USED_COLLECTIONS = [
  'users',
  'products',
  'categories',
  'colors',
  'sizes',
  'carts',
  'orders',
  'wishlists',
  'reviews',
  'blogs',
  'blogcategories',
  'blogcomments',
  'blogheros',
  'authors',
  'newsletters',
  'contacts',
  'settings',
  'heroslides'
];

async function cleanupCollections() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('MongoDB URI not found in environment variables');
      process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected!\n');

    const db = mongoose.connection.db;

    // Get all collections
    const collections = await db.listCollections().toArray();
    console.log(`Total collections in database: ${collections.length}\n`);

    // Identify unused collections
    const unusedCollections = collections.filter(col => {
      const name = col.name.toLowerCase();
      // Skip system collections
      if (name.startsWith('system.')) return false;
      // Check if it's in our used list
      return !USED_COLLECTIONS.some(used =>
        name === used ||
        name === used + 's' ||
        name.replace(/s$/, '') === used
      );
    });

    console.log(`Used collections: ${collections.length - unusedCollections.length}`);
    console.log(`Unused collections to delete: ${unusedCollections.length}\n`);

    if (unusedCollections.length === 0) {
      console.log('No unused collections found.');
      await mongoose.disconnect();
      return;
    }

    // List unused collections
    console.log('Unused collections:');
    unusedCollections.forEach((col, i) => {
      console.log(`  ${i + 1}. ${col.name}`);
    });
    console.log('');

    // Delete unused collections
    console.log('Deleting unused collections...\n');
    let deleted = 0;
    for (const col of unusedCollections) {
      try {
        await db.dropCollection(col.name);
        console.log(`  ✓ Deleted: ${col.name}`);
        deleted++;
      } catch (err) {
        console.log(`  ✗ Failed to delete ${col.name}: ${err.message}`);
      }
    }

    console.log(`\nCleanup complete! Deleted ${deleted} collections.`);

    // Show remaining count
    const remaining = await db.listCollections().toArray();
    console.log(`Remaining collections: ${remaining.length}`);

    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

cleanupCollections();
