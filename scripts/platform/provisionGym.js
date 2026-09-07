// Create a brand-new gym: platform record, its own database, system roles,
// settings, homepage, legal pages and the owner's administrator account.
//
//   node scripts/platform/provisionGym.js \
//        --name "Iron Works" --slug ironworks \
//        --domain ironworks.com --domain www.ironworks.com \
//        --owner-email owner@ironworks.com --owner-password "a strong password" \
//        --owner-first Jane --owner-last Doe \
//        --timezone Europe/London --currency GBP [--plan starter]
//
// The same thing the platform panel's "New gym" form does.

const mongoose = require('mongoose');
const { connect, argValue, argValues, hasFlag } = require('../lib/tenantScript');
const { provisionGym } = require('../../src/platform/provisioning');
const PlatformPlan = require('../../src/platform/models/platformPlanModel');

function usage(message) {
  if (message) console.error('\n' + message);
  console.error(`
Usage:
  node scripts/platform/provisionGym.js --name "Gym Name" [--slug slug]
        --owner-email x@y.com --owner-password "..." [--owner-first First] [--owner-last Last]
        [--domain host]... [--timezone Area/City] [--currency USD] [--country GB]
        [--plan <plan-slug>] [--db <database name>] [--uri <dedicated mongodb uri>]
`);
  process.exit(message ? 1 : 0);
}

async function main() {
  if (hasFlag('--help')) usage();

  const name = argValue('--name');
  if (!name) usage('--name is required.');
  if (!argValue('--owner-email') || !argValue('--owner-password')) usage('--owner-email and --owner-password are required.');

  await connect();

  let planId = null;
  const planSlug = argValue('--plan');
  if (planSlug) {
    const plan = await PlatformPlan.findOne({ slug: planSlug }).lean();
    if (!plan) usage(`No plan with slug "${planSlug}".`);
    planId = plan._id;
  }

  const { gym, seeded } = await provisionGym({
    name,
    slug: argValue('--slug') || undefined,
    domains: argValues('--domain'),
    database: { name: argValue('--db') || undefined, uri: argValue('--uri') || '' },
    owner: {
      email: argValue('--owner-email'),
      password: argValue('--owner-password'),
      firstName: argValue('--owner-first') || '',
      lastName: argValue('--owner-last') || '',
      phone: argValue('--owner-phone') || ''
    },
    planId,
    locale: {
      timezone: argValue('--timezone') || 'UTC',
      currency: argValue('--currency') || 'USD',
      country: argValue('--country') || ''
    }
  });

  console.log(`\nProvisioned "${gym.name}" (${gym.slug})`);
  console.log(`  database : ${gym.database.name}`);
  console.log(`  domains  : ${gym.domains.map((d) => d.host + (d.isPrimary ? ' (primary)' : '')).join(', ') || '(none yet)'}`);
  console.log(`  owner    : ${seeded.owner ? seeded.owner.email : '(none)'}`);
  console.log(`  plan     : ${planSlug || '(none)'}   subscription: ${gym.subscription.status}`);
  console.log('\nPoint the domain(s) at the website deployment and the gym is live.\n');
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    if (error.details) console.error(error.details);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
