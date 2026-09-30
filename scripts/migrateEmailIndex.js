// Let members have no email address: replace the old "every account has a
// unique email" index with one that is unique only among accounts that have
// an email.
//
//   node scripts/migrateEmailIndex.js --gym demo            # report only
//   node scripts/migrateEmailIndex.js --gym demo --apply    # make the change
//   node scripts/migrateEmailIndex.js --all [--apply]       # every gym
//
// Until it has run on a gym, that gym can hold one member without an email
// but refuses a second ("needs a one-off update"). New gyms get the new index
// from the start. What it does and in which order: scripts/lib/emailIndex.js.
// Dry by default; safe to run again -- a gym already migrated is reported as
// up to date and left alone.

require('dotenv').config();
const mongoose = require('mongoose');
const { connect, hasFlag, resolveGymFromArgs } = require('./lib/tenantScript');
const { migrateEmailIndex } = require('./lib/emailIndex');
const Gym = require('../src/platform/models/gymModel');
const { getTenantConnection } = require('../src/platform/connections');

const APPLY = hasFlag('--apply');

function describe(result) {
  if (!result.exists) return 'no users collection yet (the app creates the new index with it)';
  if (result.upToDate) return 'up to date';
  const steps = [];
  if (result.drop.length) steps.push(`drop ${result.drop.join(', ')}`);
  if (result.blanks) steps.push(`clear ${result.blanks} blank email(s)`);
  if (result.create) steps.push('create email_1 (unique when present)');
  return `${result.applied ? 'done' : 'would'}: ${steps.join(', then ')}`;
}

async function migrateGym(gym) {
  const connection = await getTenantConnection(gym);
  await connection.asPromise();
  const db = connection.db || connection.getClient().db(gym.database.name);
  const result = await migrateEmailIndex(db.collection('users'), { apply: APPLY });
  const now = (result.current || []).map((i) => `${i.name}${i.unique ? ' unique' : ''}${i.partial ? ' partial' : ''}`).join('; ') || 'none';
  console.log(`  ${gym.slug.padEnd(24)} indexes on email: ${now}`);
  console.log(`  ${''.padEnd(24)} ${describe(result)}`);
  return result;
}

async function main() {
  await connect();
  console.log(`Mode     : ${APPLY ? 'APPLY' : 'dry run (nothing will change)'}\n`);

  const gyms = hasFlag('--all')
    ? await Gym.find({}).select('+database.uri').sort({ slug: 1 }).lean()
    : [await resolveGymFromArgs()];

  let pending = 0;
  for (const gym of gyms) {
    try {
      const result = await migrateGym(gym);
      if (!result.upToDate && result.exists && !result.applied) pending += 1;
    } catch (error) {
      process.exitCode = 1;
      console.error(`  ${gym.slug.padEnd(24)} FAILED: ${error.message}`);
    }
  }

  if (!APPLY && pending) {
    console.log(`\nDry run — nothing was changed. ${pending} gym(s) need it; re-run with --apply.`);
  }
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
