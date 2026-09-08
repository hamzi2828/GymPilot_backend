// Copy one database to another on the same cluster: every collection, its
// documents and its indexes. Nothing is deleted -- the source is left exactly
// as it was, so a rename is "copy, switch the env, check, then drop the old
// one by hand".
//
//   node scripts/platform/copyDatabase.js --from gymwear --to GymPilot --dry-run
//   node scripts/platform/copyDatabase.js --from gymwear --to GymPilot
//   node scripts/platform/copyDatabase.js --from gymwear --to GymPilot --overwrite
//
// A target that already holds documents is refused unless --overwrite is
// given, which drops the target's matching collections first.
//
// Views are recreated after the collections they read from. Capped
// collections, validators, TTL and unique indexes are all preserved.

require('dotenv').config();
const mongoose = require('mongoose');
const { argValue, hasFlag } = require('../lib/tenantScript');

const BATCH = 500;
const SYSTEM = ['admin', 'local', 'config'];

async function copyCollection(source, target, name, dryRun) {
  const cursor = source.collection(name).find({}, { batchSize: BATCH });
  let copied = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    if (!dryRun) await target.collection(name).insertMany(batch, { ordered: false });
    copied += batch.length;
    batch = [];
  };
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return copied;
}

async function copyIndexes(source, target, name, dryRun) {
  const indexes = await source.collection(name).indexes();
  const specs = indexes
    .filter((idx) => idx.name !== '_id_')
    .map((idx) => {
      // `v`, `ns` and `key` are the server's own; everything else (unique,
      // sparse, partialFilterExpression, expireAfterSeconds, collation,
      // weights, …) is part of what the index means and has to come along.
      const { v, ns, key, ...options } = idx; // eslint-disable-line no-unused-vars
      return { key, ...options };
    });
  if (!specs.length) return 0;
  if (!dryRun) await target.collection(name).createIndexes(specs);
  return specs.length;
}

async function main() {
  const from = argValue('--from');
  const to = argValue('--to');
  const dryRun = hasFlag('--dry-run');
  const overwrite = hasFlag('--overwrite');

  if (!from || !to) {
    console.error('Usage: node scripts/platform/copyDatabase.js --from <db> --to <db> [--dry-run] [--overwrite]');
    process.exit(1);
  }
  if (from === to) {
    console.error('--from and --to are the same database.');
    process.exit(1);
  }
  if (SYSTEM.includes(from) || SYSTEM.includes(to)) {
    console.error(`Refusing to touch MongoDB's own databases (${SYSTEM.join(', ')}).`);
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const client = mongoose.connection.getClient();
  const source = client.db(from);
  const target = client.db(to);

  const all = await source.listCollections().toArray();
  const collections = all.filter((c) => c.type !== 'view').sort((a, b) => a.name.localeCompare(b.name));
  const views = all.filter((c) => c.type === 'view');
  if (!collections.length && !views.length) {
    console.error(`\n${from} has no collections. Nothing to copy.`);
    process.exit(1);
  }

  // Anything already in the target?
  const existing = await target.listCollections({}, { nameOnly: true }).toArray();
  const clashes = [];
  for (const c of existing) {
    const n = await target.collection(c.name).estimatedDocumentCount();
    if (n > 0) clashes.push(`${c.name} (${n} docs)`);
  }
  if (clashes.length && !overwrite) {
    console.error(`\n${to} already holds data: ${clashes.slice(0, 8).join(', ')}${clashes.length > 8 ? ', …' : ''}`);
    console.error('Re-run with --overwrite to replace those collections, or pick another target.');
    process.exit(1);
  }

  console.log(`\n${dryRun ? 'DRY RUN — ' : ''}copying ${from} → ${to}`);
  console.log(`${collections.length} collections, ${views.length} views\n`);

  let totalDocs = 0;
  let totalIdx = 0;
  for (const info of collections) {
    const name = info.name;
    if (overwrite && !dryRun && existing.some((c) => c.name === name)) {
      await target.collection(name).drop().catch(() => {});
    }
    // Always created explicitly, never left to the first insert: an empty
    // collection is still part of the database, and capped collections and
    // validators live on the collection rather than on its documents.
    if (!dryRun) {
      await target.createCollection(name, info.options || {}).catch((e) => {
        if (e.codeName !== 'NamespaceExists') throw e;
      });
    }
    const docs = await copyCollection(source, target, name, dryRun);
    const idx = await copyIndexes(source, target, name, dryRun);
    totalDocs += docs;
    totalIdx += idx;
    console.log(`  ${name.padEnd(34)} ${String(docs).padStart(7)} docs  ${idx} indexes`);
  }

  for (const view of views) {
    if (!dryRun) {
      await target.collection(view.name).drop().catch(() => {});
      await target.createCollection(view.name, { viewOn: view.options.viewOn, pipeline: view.options.pipeline });
    }
    console.log(`  ${view.name.padEnd(34)} view on ${view.options.viewOn}`);
  }

  console.log(`\n${dryRun ? 'Would copy' : 'Copied'} ${totalDocs} documents and ${totalIdx} indexes into ${to}.`);
  if (!dryRun) {
    console.log('\nNow check the copy, point MONGO_URI / PLATFORM_DB_NAME / TENANT_DB_PREFIX at it,');
    console.log(`and only then drop ${from} by hand once you are happy.\n`);
  }
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
