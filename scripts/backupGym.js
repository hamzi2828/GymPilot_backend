// Back up one gym's database (or every gym's) to compressed JSON files.
//
//   node scripts/backupGym.js --gym thejymor [--out backups]
//   node scripts/backupGym.js --all         [--out backups]
//
// Writes backups/<slug>/<timestamp>/<collection>.jsonl.gz -- one document
// per line, in MongoDB Extended JSON, so `mongoimport --gzip` restores it:
//
//   gunzip -c backups/thejymor/2026-09-07T05-00-00/users.jsonl.gz | \
//     mongoimport --uri "$MONGO_URI" --db gymwear --collection users
//
// Schedule it (cron, Task Scheduler, a GitHub Action) and copy the folder
// somewhere off the server; the file is only a backup once it lives
// elsewhere.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { connect, argValue, hasFlag, resolveGymFromArgs } = require('./lib/tenantScript');
const Gym = require('../src/platform/models/gymModel');
const { getTenantConnection } = require('../src/platform/connections');

async function backupGym(gym, outRoot) {
  const connection = await getTenantConnection(gym);
  await connection.asPromise();
  const db = connection.db || connection.getClient().db(gym.database.name);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(outRoot, gym.slug, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const collections = (await db.listCollections().toArray()).filter((c) => !c.name.startsWith('system.'));
  let documents = 0;
  for (const info of collections) {
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(path.join(dir, `${info.name}.jsonl.gz`));
    gzip.pipe(out);
    const cursor = db.collection(info.name).find({});
    let count = 0;
    for await (const doc of cursor) {
      gzip.write(`${EJSON.stringify(doc, { relaxed: false })}\n`);
      count += 1;
    }
    await new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      gzip.end();
    });
    documents += count;
    console.log(`  ${info.name.padEnd(28)} ${count} document(s)`);
  }

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ gym: gym.slug, database: gym.database.name, takenAt: new Date().toISOString(), collections: collections.map((c) => c.name), documents }, null, 2)
  );
  console.log(`Backed up ${gym.slug} (${documents} documents) to ${dir}\n`);
  return dir;
}

async function main() {
  await connect();
  const outRoot = path.resolve(argValue('--out') || 'backups');

  if (hasFlag('--all')) {
    const gyms = await Gym.find({}).select('+database.uri').lean();
    for (const gym of gyms) {
      console.log(`\n${gym.name} (${gym.slug})`);
      await backupGym(gym, outRoot);
    }
    return;
  }

  const gym = await resolveGymFromArgs();
  console.log(`\n${gym.name} (${gym.slug})`);
  await backupGym(gym, outRoot);
}

main()
  .catch((error) => {
    console.error('\nBackup failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
