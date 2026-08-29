// Grant, revoke and inspect front-desk attendance app access.
//
// Nobody can sign into GymPilot_desktopApp until an account is granted it --
// the two permissions default to false on every user, including existing ones,
// so deploying this feature gives nobody anything until you run this.
//
//   node scripts/attendanceAccess.js list
//   node scripts/attendanceAccess.js grant desk@thejymor.com --enroll --location "Johar Town"
//   node scripts/attendanceAccess.js revoke desk@thejymor.com
//
// `grant` without --enroll gives sign-in only: that account can record
// attendance but not register new fingerprints.
//
// `revoke` also kills the account's saved desktop tokens, so any front-desk PC
// still signed in as it drops back to the login screen on its next request
// rather than at the end of the 30-day token life.

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/user');
const DesktopToken = require('../src/attendance/models/desktopTokenModel');

function usage(message) {
  if (message) console.error('\n' + message);
  console.error(`
Usage:
  node scripts/attendanceAccess.js list
  node scripts/attendanceAccess.js grant  <email> [--enroll] [--location "Branch name"]
  node scripts/attendanceAccess.js revoke <email>

  --enroll     also allow registering fingerprints (needs the grant above)
  --location   branch shown on the punch receipt for punches this desk takes
`);
  process.exit(message ? 1 : 0);
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function describe(user) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || '(no name)';
  const flags = [
    user.allowAttendanceApp ? 'app' : null,
    user.allowFingerprintEnrollment ? 'enroll' : null
  ].filter(Boolean).join(' + ') || 'none';

  return `  ${user.email.padEnd(38)} ${name.padEnd(26)} ${flags}` +
    (user.attendanceLocation ? `  @ ${user.attendanceLocation}` : '');
}

(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') usage();

  await mongoose.connect(process.env.MONGO_URI);

  try {
    if (command === 'list') {
      const users = await User.find({
        $or: [{ allowAttendanceApp: true }, { allowFingerprintEnrollment: true }]
      }).sort({ email: 1 });

      if (!users.length) {
        console.log('\nNo account has attendance app access yet.');
        console.log('Grant one with:  node scripts/attendanceAccess.js grant <email> --enroll\n');
        return;
      }

      console.log(`\n${users.length} account(s) with attendance app access:\n`);
      for (const user of users) console.log(describe(user));

      const live = await DesktopToken.countDocuments({ revokedAt: null, expiresAt: { $gt: new Date() } });
      console.log(`\n${live} front-desk PC(s) currently signed in.\n`);
      return;
    }

    const email = args[0];
    if (!email || email.startsWith('--')) usage('An email address is required.');

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) usage(`No user found with email "${email}".`);

    if (command === 'grant') {
      user.allowAttendanceApp = true;
      if (args.includes('--enroll')) user.allowFingerprintEnrollment = true;

      const location = argValue(args, '--location');
      if (location) user.attendanceLocation = location;

      // A password login is what the desktop app performs. A Google-only
      // account would be granted access it can never actually use, so say so
      // now rather than at the desk.
      if (!user.password) {
        console.warn(
          `\nWARNING: ${user.email} has no password set (${user.provider} sign-in).\n` +
          '         The desktop app signs in with email + password, so this\n' +
          '         account will not be able to use it until one is set.'
        );
      }

      await user.save();
      console.log('\nGranted:');
      console.log(describe(user));
      console.log('');
      return;
    }

    if (command === 'revoke') {
      user.allowAttendanceApp = false;
      user.allowFingerprintEnrollment = false;
      await user.save();

      const result = await DesktopToken.revokeAllForUser(user._id);
      console.log(`\nRevoked access for ${user.email}.`);
      console.log(`${result.modifiedCount || 0} saved desktop session(s) killed.\n`);
      return;
    }

    usage(`Unknown command "${command}".`);
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
