// Give every existing account a username, and publish it to the platform
// directory the phone app signs in against.
//
//   node scripts/assignUsernames.js --gym demo --dry-run
//   node scripts/assignUsernames.js --gym demo
//   node scripts/assignUsernames.js --gym demo --repair
//
// Accounts created from now on get one automatically (a hook on the user
// model); this is only for the ones that already existed. Safe to re-run:
// an account that already has a username keeps it, and --repair just makes
// sure the directory row matches.

require('dotenv').config();
const mongoose = require('mongoose');
const { connect, hasFlag, resolveGymContextFromArgs, enterContext } = require('./lib/tenantScript');

async function main() {
  const dryRun = hasFlag('--dry-run');
  const repair = hasFlag('--repair');

  await connect();
  const context = enterContext(await resolveGymContextFromArgs());
  const gym = context.gym;

  // Required after entering the context: these models are bound to the gym's
  // database through it.
  const User = require('../src/models/user');
  const MemberDirectory = require('../src/platform/models/memberDirectoryModel');
  const { generateUsername } = require('../src/services/username');

  const users = await User.find({}).select('firstName lastName email username').sort({ createdAt: 1 });
  const missing = users.filter((u) => !u.username);

  console.log(`\n${gym.name} (${gym.slug}) — ${users.length} accounts, ${missing.length} without a username\n`);

  let created = 0;
  for (const user of missing) {
    const username = await generateUsername(user);
    console.log(`  ${String(user.email).padEnd(34)} → ${username}${dryRun ? '  (dry run)' : ''}`);
    if (!dryRun) {
      user.username = username;
      // The model's own hook publishes it to the directory on save.
      await user.save();
      created += 1;
    }
  }

  if (repair && !dryRun) {
    let republished = 0;
    for (const user of await User.find({ username: { $ne: null } }).select('username')) {
      await MemberDirectory.publish(user, gym);
      republished += 1;
    }
    console.log(`\n  directory rows checked: ${republished}`);
  }

  const listed = await MemberDirectory.countDocuments({ gymId: gym._id });
  console.log(`\n${dryRun ? 'Would create' : 'Created'} ${dryRun ? missing.length : created} username(s). ${listed} of this gym's accounts can sign in on the phone app.\n`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
