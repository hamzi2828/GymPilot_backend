/**
 * SAFE Migration Script: Add colorCode to product variants
 *
 * This script ONLY adds colorCode to variants that don't have it.
 * It does NOT modify any other data.
 *
 * Usage:
 *   DRY RUN (preview only, no changes):
 *     node src/seeds/migrateColorCodes.js --dry-run
 *
 *   ACTUAL MIGRATION:
 *     node src/seeds/migrateColorCodes.js --execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Models
const Product = require('../models/product');
const Color = require('../models/color');

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run') || !args.includes('--execute');

async function migrateColorCodes() {
  console.log('\n========================================');
  console.log('  COLOR CODE MIGRATION SCRIPT');
  console.log('========================================');
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE (will update database)'}`);
  console.log('========================================\n');

  if (!isDryRun) {
    console.log('WARNING: This will modify the database!');
    console.log('Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGO_URI environment variable is not set');
    }
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB\n');

    // Step 1: Load all colors
    console.log('Step 1: Loading colors from database...');
    const colors = await Color.find({ active: true });
    const colorMap = new Map();

    colors.forEach(color => {
      // Store with lowercase key for case-insensitive matching
      if (color.hex) {
        colorMap.set(color.name.toLowerCase().trim(), color.hex);
      }
    });

    console.log(`  Found ${colors.length} active colors with hex codes:`);
    colors.forEach(c => {
      console.log(`    - ${c.name}: ${c.hex || '(no hex)'}`);
    });
    console.log('');

    // Step 2: Find products that need updating
    console.log('Step 2: Finding products with variants missing colorCode...');
    const products = await Product.find({
      productType: 'variant',
      'variants.0': { $exists: true }
    });

    console.log(`  Found ${products.length} variant products total\n`);

    // Step 3: Analyze what needs to be updated
    console.log('Step 3: Analyzing variants...\n');

    const updatePlan = [];
    const warnings = [];

    for (const product of products) {
      const variantsToUpdate = [];

      for (let i = 0; i < product.variants.length; i++) {
        const variant = product.variants[i];

        // Skip if colorCode already exists
        if (variant.colorCode) {
          continue;
        }

        // Try to find the color hex from our color map
        const colorNameLower = variant.color?.toLowerCase().trim();
        const hexCode = colorMap.get(colorNameLower);

        if (hexCode) {
          variantsToUpdate.push({
            index: i,
            variantId: variant.variantId,
            color: variant.color,
            newColorCode: hexCode
          });
        } else {
          warnings.push({
            productId: product._id,
            productName: product.name,
            variantColor: variant.color,
            message: `No matching color found in Color collection`
          });
        }
      }

      if (variantsToUpdate.length > 0) {
        updatePlan.push({
          productId: product._id,
          productName: product.name,
          variants: variantsToUpdate
        });
      }
    }

    // Step 4: Show the plan
    console.log('========================================');
    console.log('  UPDATE PLAN');
    console.log('========================================\n');

    if (updatePlan.length === 0) {
      console.log('No updates needed! All variants already have colorCode.\n');
    } else {
      console.log(`Products to update: ${updatePlan.length}\n`);

      let totalVariants = 0;
      for (const plan of updatePlan) {
        console.log(`Product: ${plan.productName}`);
        console.log(`  ID: ${plan.productId}`);
        for (const v of plan.variants) {
          console.log(`  - Variant "${v.color}" -> colorCode: "${v.newColorCode}"`);
          totalVariants++;
        }
        console.log('');
      }

      console.log(`Total variants to update: ${totalVariants}\n`);
    }

    // Show warnings
    if (warnings.length > 0) {
      console.log('========================================');
      console.log('  WARNINGS (variants that cannot be updated)');
      console.log('========================================\n');

      for (const w of warnings) {
        console.log(`Product: ${w.productName}`);
        console.log(`  Color: "${w.variantColor}" - ${w.message}`);
        console.log('');
      }
    }

    // Step 5: Execute updates (only if not dry run)
    if (!isDryRun && updatePlan.length > 0) {
      console.log('========================================');
      console.log('  EXECUTING UPDATES');
      console.log('========================================\n');

      // Create backup file before updating
      const backupDir = path.join(__dirname, '../../backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const backupFile = path.join(backupDir, `colorcode-migration-backup-${Date.now()}.json`);
      const backupData = [];

      for (const plan of updatePlan) {
        const product = await Product.findById(plan.productId);
        if (!product) continue;

        // Save backup of original variants
        backupData.push({
          productId: product._id.toString(),
          productName: product.name,
          originalVariants: JSON.parse(JSON.stringify(product.variants))
        });

        // Update only the colorCode field for specific variants
        for (const variantUpdate of plan.variants) {
          product.variants[variantUpdate.index].colorCode = variantUpdate.newColorCode;
        }

        await product.save();
        console.log(`  Updated: ${product.name}`);
      }

      // Save backup file
      fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
      console.log(`\nBackup saved to: ${backupFile}`);

      console.log('\n========================================');
      console.log('  MIGRATION COMPLETE');
      console.log('========================================');
      console.log(`Products updated: ${updatePlan.length}`);
      console.log(`Backup file: ${backupFile}`);
    } else if (isDryRun) {
      console.log('========================================');
      console.log('  DRY RUN COMPLETE');
      console.log('========================================');
      console.log('No changes were made.');
      console.log('To execute the migration, run:');
      console.log('  node src/seeds/migrateColorCodes.js --execute');
    }

  } catch (error) {
    console.error('\nMIGRATION FAILED:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

// Run migration
migrateColorCodes();
