// scripts/lib/tenantScript.js
//
// Shared plumbing for one-off scripts and seeders now that every gym has its
// own database. A script says which gym it is for with `--gym <slug>` (or
// DEFAULT_TENANT_SLUG in .env), and calls, right after connecting:
//
//     enterContext(await resolveGymContextFromArgs());
//
// That line has to sit in the script's own main function, not inside a
// helper: AsyncLocalStorage propagates a context entered with enterWith()
// to everything that follows in the SAME async function, but not back up to
// a caller. From then on every model call lands in that gym's database.

require('dotenv').config();
const mongoose = require('mongoose');

const Gym = require('../../src/platform/models/gymModel');
const { tenantContextFor, enterContext } = require('../../src/platform/tenantContext');

function argValue(flag, argv = process.argv) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function argValues(flag, argv = process.argv) {
  const values = [];
  argv.forEach((arg, index) => {
    if (arg === flag && index + 1 < argv.length) values.push(argv[index + 1]);
  });
  return values;
}

function hasFlag(flag, argv = process.argv) {
  return argv.includes(flag);
}

async function connect() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env.');
    process.exit(1);
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  }
}

async function listGymsBrief() {
  const gyms = await Gym.find({}).select('name slug status database.name').sort({ slug: 1 }).lean();
  if (!gyms.length) {
    console.error('  (no gyms registered yet -- see scripts/platform/registerExistingGym.js)');
    return;
  }
  for (const gym of gyms) console.error(`  ${gym.slug.padEnd(24)} ${gym.name.padEnd(30)} db=${gym.database.name}  ${gym.status}`);
}

/**
 * The gym named by --gym (or DEFAULT_TENANT_SLUG), with its database uri.
 * Exits with a listing of known gyms when none is given or found.
 */
async function resolveGymFromArgs({ required = true } = {}) {
  const slug = argValue('--gym') || process.env.DEFAULT_TENANT_SLUG || null;
  if (!slug) {
    if (!required) return null;
    console.error('\nWhich gym? Pass --gym <slug> (or set DEFAULT_TENANT_SLUG in .env). Known gyms:');
    await listGymsBrief();
    process.exit(1);
  }
  const gym = await Gym.findOne({ slug: String(slug).toLowerCase().trim() }).select('+database.uri').lean();
  if (!gym) {
    console.error(`\nNo gym with slug "${slug}". Known gyms:`);
    await listGymsBrief();
    process.exit(1);
  }
  return gym;
}

async function resolveGymContextFromArgs(options) {
  const gym = await resolveGymFromArgs(options);
  if (!gym) return null;
  const context = await tenantContextFor(gym);
  console.log(`Gym      : ${gym.name} (${gym.slug}) -> database "${gym.database.name}"`);
  return context;
}

/** argv without the `--gym <slug>` pair, for scripts that parse positionally. */
function stripGymArg(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--gym') {
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

module.exports = {
  connect,
  argValue,
  stripGymArg,
  argValues,
  hasFlag,
  resolveGymFromArgs,
  resolveGymContextFromArgs,
  enterContext: (context) => {
    if (context) enterContext(context);
    return context;
  }
};
