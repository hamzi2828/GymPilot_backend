// Give every existing member a member ID ("GP-0184").
//
//   node scripts/assignMemberCodes.js --gym demo            # report only
//   node scripts/assignMemberCodes.js --gym demo --apply    # assign them
//   node scripts/assignMemberCodes.js --all [--apply]       # every gym
//
// Members made from now on get one when their account is created
// (assignMemberCode in src/attendance/services/peopleDirectory.js); older
// ones only got one the first time they were seen at the desk, so the Users
// list shows a gap for everybody who never was. This fills it, oldest member
// first, from the gym's own series -- the same counter the desk uses, so
// nothing already handed out changes. Staff are left alone (they are TR-).
// Dry by default; safe to run again: a member with an ID keeps it.

require('dotenv').config();
const mongoose = require('mongoose');
const { connect, hasFlag, resolveGymFromArgs } = require('./lib/tenantScript');
const Gym = require('../src/platform/models/gymModel');
const { runWithTenant, tenantContextFor } = require('../src/platform/tenantContext');

const APPLY = hasFlag('--apply');

async function backfill(gym) {
  // Required inside the gym's context: the models are bound to its database.
  const User = require('../src/models/user');
  const Role = require('../src/models/roleModel');
  const { assignMemberCode } = require('../src/attendance/services/peopleDirectory');

  // A member is an account on a member role that is not on the staff list;
  // the administrator role and every role marked as staff are not members.
  const staffRoles = await Role.find({ isStaff: true }).distinct('slug');
  const missing = await User.find({
    role: { $nin: [...staffRoles, 'admin'] },
    'employment.isStaff': { $ne: true },
    memberCode: { $not: { $type: 'string' } }
  })
    .select('firstName lastName email phone role employment memberCode createdAt')
    .sort({ createdAt: 1, _id: 1 });

  console.log(`\n${gym.name} (${gym.slug}) — ${missing.length} member(s) without an ID`);

  let assigned = 0;
  for (const user of missing) {
    const who = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.phone || String(user._id);
    if (!APPLY) {
      console.log(`  ${who}`);
      continue;
    }
    const code = await assignMemberCode(user);
    if (code) assigned += 1;
    console.log(`  ${String(code || '(failed)').padEnd(10)} ${who}`);
  }
  if (APPLY) console.log(`  assigned ${assigned} of ${missing.length}`);
  return { missing: missing.length, assigned };
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
      const result = await runWithTenant(await tenantContextFor(gym), () => backfill(gym));
      if (!APPLY) pending += result.missing;
    } catch (error) {
      process.exitCode = 1;
      console.error(`  ${gym.slug}: FAILED — ${error.message}`);
    }
  }

  if (!APPLY && pending) console.log(`\nDry run — nothing was changed. Re-run with --apply to give ${pending} member(s) an ID.`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
