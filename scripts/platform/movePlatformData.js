// scripts/platform/movePlatformData.js
//
//   node scripts/platform/movePlatformData.js --from gympilot_platform [--to GymPilot] [--drop-source]
//
// Copies the platform collections (gyms, platform_plans, super_admins,
// platform_audit_logs) from one database to another on the MONGO_URI
// cluster. Used once, to move the platform records into the main database
// after the naming changed (see src/platform/dbNames.js). Safe to re-run:
// documents that already exist in the destination are left alone.

require('dotenv').config();
const mongoose = require('mongoose');
const { platformDatabaseName } = require('../../src/platform/dbNames');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const from = argValue('--from');
  const to = argValue('--to') || platformDatabaseName();
  const dropSource = process.argv.includes('--drop-source');
  if (!from) {
    console.error('Usage: node scripts/platform/movePlatformData.js --from <database> [--to <database>] [--drop-source]');
    process.exit(1);
  }
  if (from === to) {
    console.error(`Source and destination are the same database (${to}); nothing to do.`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const client = mongoose.connection.getClient();
  const source = client.db(from);
  const target = client.db(to);

  const collections = (await source.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  if (!collections.length) {
    console.log(`No collections in ${from}.`);
  }

  for (const name of collections) {
    const docs = await source.collection(name).find({}).toArray();
    let copied = 0;
    let skipped = 0;
    if (docs.length) {
      try {
        const result = await target.collection(name).insertMany(docs, { ordered: false });
        copied = result.insertedCount;
      } catch (error) {
        // Duplicate keys: those documents are already over there.
        if (error.code === 11000 || (error.writeErrors && error.writeErrors.every((e) => e.code === 11000))) {
          copied = error.result ? error.result.insertedCount : docs.length - error.writeErrors.length;
          skipped = docs.length - copied;
        } else {
          throw error;
        }
      }
    }
    console.log(`${from}.${name} -> ${to}.${name}: ${copied} copied, ${skipped} already present`);
  }

  if (dropSource) {
    await source.dropDatabase();
    console.log(`Dropped ${from}.`);
  } else {
    console.log(`Left ${from} in place. Re-run with --drop-source once you have checked ${to}.`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
