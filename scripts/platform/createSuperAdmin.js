// Create (or reset the password of) a platform super admin.
//
//   node scripts/platform/createSuperAdmin.js owner@gympilot.com "a strong password" --name "Your Name"
//
// Super admins live in the platform database, not in any gym's. They sign in
// at /login on the platform site (GymPilot_frontendAdmin) and see every gym,
// its plan and its numbers.
//
// On a host with no shell (Vercel), set SUPER_ADMIN_EMAIL and
// SUPER_ADMIN_PASSWORD in the environment instead: the first sign-in attempt
// creates the account when none exists yet.

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { connect, argValue } = require('../lib/tenantScript');
const SuperAdmin = require('../../src/platform/models/superAdminModel');

const MIN_PASSWORD_LENGTH = 10;

async function main() {
  const [email, password] = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('--') && all[i - 1] !== '--name');
  if (!email || !password) {
    console.error('Usage: node scripts/platform/createSuperAdmin.js <email> <password> [--name "Name"]');
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  await connect();

  const normalised = String(email).toLowerCase().trim();
  const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));
  const name = argValue('--name') || '';

  let admin = await SuperAdmin.findOne({ email: normalised }).select('+password');
  if (admin) {
    admin.password = hashed;
    admin.isActive = true;
    if (name) admin.name = name;
    await admin.save();
    console.log(`\nPassword reset for existing super admin ${admin.email}.`);
  } else {
    admin = await SuperAdmin.create({ email: normalised, password: hashed, name, isActive: true });
    console.log(`\nSuper admin created: ${admin.email}`);
  }
  console.log('Sign in at <platform site>/login\n');
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
