// Register a database that ALREADY holds a gym as a tenant of the platform.
//
// This is the migration step for the deployment that existed before the
// platform did: its data stays exactly where it is (the database named in
// MONGO_URI, or whichever you pass), and the platform learns which domains
// lead to it. Nothing in that database is modified except that any missing
// system roles / homepage sections / legal pages are filled in, the same way
// the running app already does on first use.
//
//   node scripts/platform/registerExistingGym.js \
//        --name "The Jymor" --slug thejymor --db GymPilot \
//        --domain thejymor.com --domain localhost:3000 \
//        --timezone Asia/Karachi --currency PKR \
//        [--owner-email owner@thejymor.com] [--plan <plan-slug>]
//
// Then set DEFAULT_TENANT_SLUG=<slug> in .env so requests that carry no
// recognisable domain (plain localhost, curl) still reach this gym.

const mongoose = require('mongoose');
const { connect, argValue, argValues, hasFlag } = require('../lib/tenantScript');
const { provisionGym } = require('../../src/platform/provisioning');
const PlatformPlan = require('../../src/platform/models/platformPlanModel');

function usage(message) {
  if (message) console.error('\n' + message);
  console.error(`
Usage:
  node scripts/platform/registerExistingGym.js --name "Gym Name" --slug <slug> --db <database name>
        [--domain host]... [--timezone Area/City] [--currency USD]
        [--owner-email x@y.com] [--owner-first First] [--owner-last Last]
        [--owner-password "..."]   (creates/promotes an administrator in the gym)
        [--plan <plan-slug>] [--uri <dedicated mongodb uri>]
`);
  process.exit(message ? 1 : 0);
}

async function main() {
  if (hasFlag('--help')) usage();

  const name = argValue('--name');
  const slug = argValue('--slug');
  const db = argValue('--db') || null;
  if (!name || !slug) usage('--name and --slug are required.');

  await connect();

  const databaseName = db || mongoose.connection.name;
  if (!databaseName) usage('Could not tell which database to register; pass --db.');

  let planId = null;
  const planSlug = argValue('--plan');
  if (planSlug) {
    const plan = await PlatformPlan.findOne({ slug: planSlug }).lean();
    if (!plan) usage(`No plan with slug "${planSlug}".`);
    planId = plan._id;
  }

  const ownerEmail = argValue('--owner-email');
  const { gym, seeded } = await provisionGym({
    name,
    slug,
    adoptExisting: true,
    domains: argValues('--domain'),
    database: { name: databaseName, uri: argValue('--uri') || '' },
    owner: ownerEmail
      ? {
          email: ownerEmail,
          firstName: argValue('--owner-first') || '',
          lastName: argValue('--owner-last') || '',
          password: argValue('--owner-password') || null
        }
      : null,
    planId,
    locale: {
      timezone: argValue('--timezone') || process.env.ATTENDANCE_TIMEZONE || 'UTC',
      currency: argValue('--currency') || process.env.ACCOUNTS_CURRENCY || 'USD',
      country: argValue('--country') || ''
    },
    subscription: { status: 'active' }
  });

  console.log(`\nRegistered "${gym.name}" (${gym.slug})`);
  console.log(`  database : ${gym.database.name}`);
  console.log(`  domains  : ${gym.domains.map((d) => d.host + (d.isPrimary ? ' (primary)' : '')).join(', ') || '(none yet)'}`);
  console.log(`  timezone : ${gym.locale.timezone}   currency: ${gym.locale.currency}`);
  if (seeded.owner) console.log(`  owner    : ${seeded.owner.email} (administrator)`);
  console.log(`\nAdd to .env:  DEFAULT_TENANT_SLUG=${gym.slug}\n`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    if (error.details) console.error(error.details);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
