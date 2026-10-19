// Remove a gym from the platform.
//
//   node scripts/platform/deleteGym.js --gym <slug> --confirm <slug> [--drop-database]
//        [--subscription-cancelled] [--members-keep-paying]
//
// Without --drop-database the gym's data is left in place and only the
// platform record goes, so it can be re-registered later with
// registerExistingGym.js. With it, the database is dropped for good, and the
// gym's stored files (everything under `<slug>/` in the file store) with it.
//
// A gym that pays the platform by card has its Stripe subscription cancelled
// first; if Stripe will not cancel it, nothing is deleted. Cancel it in the
// Stripe dashboard, then run this again with --subscription-cancelled.
//
// A gym whose members still pay IT by card on a subscription is refused too:
// those are in the gym's own Stripe account and keep charging once the gym
// is gone. Have the owner cancel them, or pass --members-keep-paying.

const mongoose = require('mongoose');
const { connect, argValue, hasFlag } = require('../lib/tenantScript');
const Gym = require('../../src/platform/models/gymModel');
const { deleteGym } = require('../../src/platform/provisioning');

async function main() {
  const slug = argValue('--gym');
  const confirm = argValue('--confirm');
  if (!slug) {
    console.error('Usage: node scripts/platform/deleteGym.js --gym <slug> --confirm <slug> [--drop-database] [--subscription-cancelled] [--members-keep-paying]');
    process.exit(1);
  }

  await connect();

  const gym = await Gym.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!gym) {
    console.error(`No gym with slug "${slug}".`);
    process.exit(1);
  }

  const dropDatabase = hasFlag('--drop-database');
  const result = await deleteGym(gym, {
    confirmSlug: confirm,
    dropDatabase,
    subscriptionCancelledByHand: hasFlag('--subscription-cancelled'),
    memberSubscriptionsAcknowledged: hasFlag('--members-keep-paying')
  });

  console.log(`\nDeleted "${gym.name}" (${gym.slug}).`);
  if (result.billing) {
    console.log(
      result.billing.cancelled
        ? `Stripe subscription ${result.billing.subscriptionId} cancelled.`
        : `Stripe subscription ${result.billing.subscriptionId} was not cancelled from here (${result.billing.error}); you said it is cancelled already.`
    );
  }
  console.log(`Phone app sign-in names removed: ${result.memberLoginsRemoved}.`);
  if (dropDatabase) {
    console.log(`Stored files removed: ${result.filesRemoved}.`);
    if (result.filesLeft) console.log(`Some stored files could not be removed (${result.filesError}); they are still in the file store under "${gym.slug}/".`);
    if (result.filesSkipped) console.log(`Stored files were not removed: ${result.filesSkipped}.`);
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
