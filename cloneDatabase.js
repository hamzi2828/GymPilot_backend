require('dotenv').config();
const { MongoClient } = require('mongodb');

// Source and Target database URIs — set these in .env
const SOURCE_URI = process.env.SOURCE_MONGO_URI;
const TARGET_URI = process.env.TARGET_MONGO_URI;

async function cloneDatabase() {
  let sourceClient = null;
  let targetClient = null;

  try {
    console.log('Connecting to source database (InkedWear)...');
    sourceClient = new MongoClient(SOURCE_URI);
    await sourceClient.connect();
    const sourceDb = sourceClient.db('InkedWear');

    console.log('Connecting to target database (InkedWear)...');
    targetClient = new MongoClient(TARGET_URI);
    await targetClient.connect();
    const targetDb = targetClient.db('InkedWear');

    // Get all collections from source database
    const collections = await sourceDb.listCollections().toArray();
    console.log(`Found ${collections.length} collections to clone:`);
    collections.forEach(col => console.log(`  - ${col.name}`));

    // Clone each collection
    for (const collectionInfo of collections) {
      const collectionName = collectionInfo.name;

      // Skip system collections
      if (collectionName.startsWith('system.')) {
        console.log(`\nSkipping system collection: ${collectionName}`);
        continue;
      }

      console.log(`\nCloning collection: ${collectionName}`);

      const sourceCollection = sourceDb.collection(collectionName);
      const targetCollection = targetDb.collection(collectionName);

      // Get all documents from source collection
      const documents = await sourceCollection.find({}).toArray();
      console.log(`  Found ${documents.length} documents`);

      if (documents.length > 0) {
        // Drop existing collection in target if it exists
        try {
          await targetCollection.drop();
          console.log(`  Dropped existing collection in target`);
        } catch (err) {
          // Collection might not exist, that's fine
          if (err.code !== 26) { // 26 = NamespaceNotFound
            console.log(`  Note: ${err.message}`);
          }
        }

        // Insert all documents into target collection
        const result = await targetCollection.insertMany(documents);
        console.log(`  Inserted ${result.insertedCount} documents`);
      } else {
        console.log(`  No documents to copy`);
      }

      // Copy indexes
      const indexes = await sourceCollection.indexes();
      for (const index of indexes) {
        // Skip the default _id index
        if (index.name === '_id_') continue;

        try {
          const { key, ...options } = index;
          delete options.v; // Remove version field
          delete options.ns; // Remove namespace field
          await targetCollection.createIndex(key, options);
          console.log(`  Created index: ${index.name}`);
        } catch (err) {
          console.log(`  Warning: Could not create index ${index.name}: ${err.message}`);
        }
      }
    }

    console.log('\n========================================');
    console.log('Database clone completed successfully!');
    console.log('========================================');
    console.log(`Source: InkedWear`);
    console.log(`Target: InkedWear`);
    console.log(`Collections cloned: ${collections.filter(c => !c.name.startsWith('system.')).length}`);

  } catch (error) {
    console.error('Error cloning database:', error);
    throw error;
  } finally {
    if (sourceClient) {
      await sourceClient.close();
      console.log('\nClosed source database connection');
    }
    if (targetClient) {
      await targetClient.close();
      console.log('Closed target database connection');
    }
  }
}

// Run the clone
cloneDatabase()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Clone failed:', error);
    process.exit(1);
  });
