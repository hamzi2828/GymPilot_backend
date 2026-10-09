// Remove a gym from the platform.
//
//   node scripts/platform/deleteGym.js --gym <slug> --confirm <slug> [--drop-database] [--subscription-cancelled]
//
// Without --drop-database the gym's data is left in place and only the
// platform record goes, so it can be re-registered later with
// registerExistingGym.js. With it, the database is dropped for good.
//
// A gym that pays the platform by card has its Stripe subscription cancelled
// first; if Stripe will not cancel it, nothing is deleted. Cancel it in the
// Stripe dashboard, then run this again with --subscription-cancelled.

const mongoose = require('mongoose');
const { connect, argValue, hasFlag } = require('../lib/tenantScript');
const Gym = require('../../src/platform/models/gymModel');
const { deleteGym } = require('../../src/platform/provisioning');

async function main() {
  const slug = argValue('--gym');
  const confirm = argValue('--confirm');
  if (!slug) {
    console.error('Usage: node scripts/platform/deleteGym.js --gym <slug> --confirm <slug> [--drop-database] [--subscription-cancelled]');
    process.exit(1);
  }

  await connect();

  const gym = await Gym.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!gym) {
    console.error(`No gym with slug "${slug}".`);
    process.exit(1);
  }

  const dropDatabase = hasFlag('--drop-database');
  const result = await deleteGym(gym, { confirmSlug: confirm, dropDatabase, subscriptionCancelledByHand: hasFlag('--subscription-cancelled') });

  console.log(`\nDeleted "${gym.name}" (${gym.slug}).`);
  if (result.billing) {
    console.log(
      result.billing.cancelled
        ? `Stripe subscription ${result.billing.subscriptionId} cancelled.`
        : `Stripe subscription ${result.billing.subscriptionId} was not cancelled from here (${result.billing.error}); you said it is cancelled already.`
    );
  }
  console.log(`Stored backups removed: ${result.backupsRemoved}.`);
  if (result.backupsLeft) {
    console.log(`${result.backupsLeft} stored backup(s) could not be removed (${result.backupsError}); they are still listed in platform_backups.`);
  }
  console.log(dropDatabase ? `Database "${gym.database.name}" dropped.\n` : `Database "${gym.database.name}" kept.\n`);
  return result;
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
