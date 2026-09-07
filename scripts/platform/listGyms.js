// List every gym on the platform.
//
//   node scripts/platform/listGyms.js [--stats]

const mongoose = require('mongoose');
const { connect, hasFlag } = require('../lib/tenantScript');
const Gym = require('../../src/platform/models/gymModel');
const PlatformPlan = require('../../src/platform/models/platformPlanModel');
const { collectGymStats } = require('../../src/platform/tenantStats');

async function main() {
  await connect();

  const [gyms, plans] = await Promise.all([
    Gym.find({}).select('+database.uri').sort({ createdAt: 1 }).lean(),
    PlatformPlan.find({}).lean()
  ]);
  const planName = new Map(plans.map((p) => [String(p._id), p.name]));

  if (!gyms.length) {
    console.log('\nNo gyms registered yet. See scripts/platform/registerExistingGym.js and provisionGym.js.\n');
    return;
  }

  console.log(`\n${gyms.length} gym(s):\n`);
  for (const gym of gyms) {
    const sub = gym.subscription || {};
    const line =
      `  ${gym.slug.padEnd(22)} ${gym.name.padEnd(28)} ${gym.status.padEnd(10)} ` +
      `${(sub.status || '-').padEnd(10)} ${(planName.get(String(gym.plan)) || '(no plan)').padEnd(14)} ` +
      `db=${gym.database.name}${gym.database.uri ? ' (dedicated)' : ''}`;
    console.log(line);
    console.log(`  ${''.padEnd(22)} domains: ${gym.domains.map((d) => d.host).join(', ') || '(none)'}`);
    if (sub.currentPeriodEnd) console.log(`  ${''.padEnd(22)} period ends: ${new Date(sub.currentPeriodEnd).toISOString().slice(0, 10)}`);
    if (hasFlag('--stats')) {
      const stats = await collectGymStats(gym);
      console.log(`  ${''.padEnd(22)} stats: ${JSON.stringify(stats)}`);
    }
  }
  console.log('');
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
