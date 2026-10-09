// Take the old made-up homepage text off the websites of gyms created before
// the defaults were rewritten: "24/7 access for members", "Certified coaches
// on the floor at all times", "1200+ Active members", and the stock gallery
// photographs.
//
//   node scripts/cleanHomeSeed.js --gym demo            # report only
//   node scripts/cleanHomeSeed.js --gym demo --apply    # make the changes
//   node scripts/cleanHomeSeed.js --all [--apply]       # every gym
//
// A value is replaced only while it is still exactly what the gym was
// created with; anything the gym has rewritten is left alone. Seeded text
// becomes today's neutral default, seeded figures and stock photos are
// removed, and a stats band left with no figures is switched off. The rules,
// and the old text being looked for: scripts/lib/homeSeed.js.
//
// Dry by default: the report lists, per gym and per section, each value and
// what it would become -- read it before applying, because a gym that left
// a seeded line in place on purpose cannot be told apart from one that never
// looked. Safe to run again: a gym already cleaned has nothing left to
// change.

require('dotenv').config();
const mongoose = require('mongoose');
const { connect, hasFlag, resolveGymFromArgs } = require('./lib/tenantScript');
const { cleanHomeSeed } = require('./lib/homeSeed');
const Gym = require('../src/platform/models/gymModel');
const { runWithTenant, tenantContextFor } = require('../src/platform/tenantContext');

const APPLY = hasFlag('--apply');

const short = (value) => {
  const line = String(value).replace(/\s+/g, ' ');
  return line.length > 70 ? `${line.slice(0, 67)}...` : line;
};

async function clean(gym) {
  // Required inside the gym's context: the model is bound to its database.
  const HomeSection = require('../src/models/homeSectionModel');
  const { plans, count } = await cleanHomeSeed(HomeSection, { apply: APPLY });

  console.log(`\n${gym.name} (${gym.slug}) — ${count ? `${count} value(s) still from the old defaults` : 'nothing from the old defaults'}`);
  for (const plan of plans) {
    console.log(`  ${plan.key}`);
    for (const change of plan.changes) {
      console.log(`    ${change.field}: "${short(change.was)}"`);
      console.log(`      ${APPLY ? 'now' : 'would become'}: ${change.now.startsWith('(') ? change.now : `"${short(change.now)}"`}`);
    }
  }
  return { count };
}

async function main() {
  await connect();
  console.log(`Mode     : ${APPLY ? 'APPLY' : 'dry run (nothing will change)'}`);

  const gyms = hasFlag('--all')
    ? await Gym.find({}).select('+database.uri').sort({ slug: 1 }).lean()
    : [await resolveGymFromArgs()];

  let pending = 0;
  for (const gym of gyms) {
    try {
      const result = await runWithTenant(await tenantContextFor(gym), () => clean(gym));
      if (!APPLY) pending += result.count;
    } catch (error) {
      process.exitCode = 1;
      console.error(`  ${gym.slug}: FAILED — ${error.message}`);
    }
  }

  if (!APPLY && pending) console.log(`\nDry run — nothing was changed. Re-run with --apply to replace ${pending} value(s).`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
