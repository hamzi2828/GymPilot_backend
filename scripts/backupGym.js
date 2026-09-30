// Back up one gym's database (or every gym's) to a compressed archive.
//
//   node scripts/backupGym.js --gym demo [--out backups]
//   node scripts/backupGym.js --all         [--out backups]
//
// Writes backups/<slug>/<slug>-backup-<timestamp>.tar.gz -- the same archive
// the owner downloads from Settings → Data & backup and the daily backup
// stores (src/services/backupService.js): backup.json, then per collection
// its definition (collections/<name>.json: options and indexes) and its
// documents (collections/<name>.jsonl, one Extended JSON document per line),
// and manifest.json with the counts. --all adds backups/_platform/…: the
// platform's own collections (gyms, plans, super admins, …), which no gym's
// archive carries.
//
// Restore a gym from Settings → Data & backup (upload the file), or by hand,
// one collection at a time, with mongoimport:
//
//   tar -xzf demo-backup-2026-09-07-0500.tar.gz
//   mongoimport --uri "$MONGO_URI" --db GymPilot --collection users \
//     --file collections/users.jsonl
//
// Schedule it (cron, Task Scheduler, a GitHub Action) and copy the folder
// somewhere off the server; the file is only a backup once it lives
// elsewhere. On Vercel the daily backup does this for every gym
// (/api/jobs/backups).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect, argValue, hasFlag, resolveGymFromArgs } = require('./lib/tenantScript');
const Gym = require('../src/platform/models/gymModel');
const { runWithTenant } = require('../src/platform/tenantContext');
const { platformDatabaseName } = require('../src/platform/dbNames');
const backups = require('../src/services/backupService');

function describe(manifest, file) {
  for (const c of manifest.collections) console.log(`  ${c.name.padEnd(28)} ${c.documents} document(s)`);
  console.log(`Backed up ${manifest.gym ? manifest.gym.slug : 'the platform'} (${manifest.documents} documents) to ${file}\n`);
}

async function backupGym(gym, outRoot) {
  const now = new Date();
  const dir = path.join(outRoot, gym.slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backups.archiveFileName(gym.slug, now));
  // Inside the gym's context: the database is the gym's, and a Settings
  // secret still in plaintext is sealed with the gym's own key.
  const manifest = await runWithTenant(gym, () => backups.writeGymArchive({ trigger: 'cli', now }, fs.createWriteStream(file)));
  describe(manifest, file);
  return file;
}

async function backupPlatform(outRoot) {
  const now = new Date();
  const dir = path.join(outRoot, '_platform');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backups.archiveFileName('platform', now));
  const db = mongoose.connection.getClient().db(platformDatabaseName());
  const manifest = await backups.writeArchive(
    { db, gym: null, trigger: 'cli', now, select: (info) => (!info.type || info.type === 'collection') && backups.isPlatformCollection(info.name) },
    fs.createWriteStream(file)
  );
  describe(manifest, file);
  return file;
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
    console.log('\nThe platform');
    await backupPlatform(outRoot);
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
