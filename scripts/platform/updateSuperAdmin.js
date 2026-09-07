// Change a platform super admin's email, name or password.
//
//   node scripts/platform/updateSuperAdmin.js old@example.com --email new@example.com
//   node scripts/platform/updateSuperAdmin.js owner@example.com --password "a strong password"
//   node scripts/platform/updateSuperAdmin.js owner@example.com --name "Owner" --deactivate
//
// Companion to createSuperAdmin.js. The account is found by its current
// email (first argument); every other flag is optional.

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { connect, argValue, hasFlag } = require('../lib/tenantScript');
const SuperAdmin = require('../../src/platform/models/superAdminModel');

const MIN_PASSWORD_LENGTH = 10;

async function main() {
  const current = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const newEmail = argValue('--email');
  const password = argValue('--password');
  const name = argValue('--name');
  const deactivate = hasFlag('--deactivate');
  const activate = hasFlag('--activate');

  if (!current || (!newEmail && !password && name === null && !deactivate && !activate)) {
    console.error('Usage: node scripts/platform/updateSuperAdmin.js <current email> [--email new] [--password p] [--name n] [--activate|--deactivate]');
    process.exit(1);
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  await connect();

  const admin = await SuperAdmin.findOne({ email: String(current).toLowerCase().trim() }).select('+password');
  if (!admin) {
    console.error(`No super admin with the email ${current}.`);
    process.exit(1);
  }

  const changes = [];
  if (newEmail) {
    const normalised = String(newEmail).toLowerCase().trim();
    const taken = await SuperAdmin.findOne({ email: normalised, _id: { $ne: admin._id } }).select('_id').lean();
    if (taken) {
      console.error(`Another super admin already uses ${normalised}.`);
      process.exit(1);
    }
    admin.email = normalised;
    changes.push(`email -> ${normalised}`);
  }
  if (password) {
    admin.password = await bcrypt.hash(password, await bcrypt.genSalt(10));
    changes.push('password changed');
  }
  if (name !== null) {
    admin.name = name;
    changes.push(`name -> ${name || '(blank)'}`);
  }
  if (deactivate) {
    admin.isActive = false;
    changes.push('deactivated');
  }
  if (activate) {
    admin.isActive = true;
    changes.push('activated');
  }

  await admin.save();
  console.log(`\nUpdated super admin ${current}: ${changes.join(', ')}\n`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
