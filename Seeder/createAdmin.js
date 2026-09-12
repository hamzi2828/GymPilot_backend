// createAdmin.js - Create (or promote) an administrator account for one gym
//
//   node Seeder/createAdmin.js --gym <slug> --email owner@yourgym.com --password '<strong password>'
//       [--first-name Ada] [--last-name Lovelace]
//
// or with the credentials in the environment:
//
//   ADMIN_EMAIL=owner@yourgym.com ADMIN_PASSWORD='<strong password>' node Seeder/createAdmin.js --gym <slug>
//
// There is no built-in account and no default password: the script refuses
// to run without an email and a password of its own, and never prints the
// password back. An account that already exists is promoted to admin rather
// than recreated, and its password is left alone.

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { argValue, enterContext, resolveGymContextFromArgs } = require('../scripts/lib/tenantScript');
const User = require('../src/models/user');

const MIN_PASSWORD_LENGTH = 8;

// Database connection
async function connectDB() {
  require('dotenv').config();
  const MONGO_URI = process.env.MONGO_URI;

  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log(`Connected to MongoDB Database: ${mongoose.connection.name}`);
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// The credentials come from the command line or the environment, never from
// this file.
function readCredentials() {
  require('dotenv').config();
  const email = String(argValue('--email') || process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = String(argValue('--password') || process.env.ADMIN_PASSWORD || '');
  const firstName = String(argValue('--first-name') || 'Admin').trim();
  const lastName = String(argValue('--last-name') || 'User').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('An email address is required: pass --email <address> or set ADMIN_EMAIL.');
    process.exit(1);
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`A password of at least ${MIN_PASSWORD_LENGTH} characters is required: pass --password <value> or set ADMIN_PASSWORD.`);
    process.exit(1);
  }

  return { email, password, firstName, lastName };
}

async function createAdmin() {
  const { email, password, firstName, lastName } = readCredentials();

  try {
    await connectDB();
    // Every gym has its own database: --gym <slug> picks which one.
    enterContext(await resolveGymContextFromArgs());
    console.log('Creating admin user...\n');

    // Check if admin already exists
    const existingAdmin = await User.findOne({ email });
    if (existingAdmin) {
      console.log(`Account already exists: ${existingAdmin.email} (role: ${existingAdmin.role})`);
      // Update role to admin if not already
      if (existingAdmin.role !== 'admin') {
        existingAdmin.role = 'admin';
        // Path-level, not a whole-object replace: the pay details are not
        // loaded by default and must not be blanked by this promotion.
        existingAdmin.set('employment.isStaff', true);
        await existingAdmin.save();
        console.log('Updated existing user role to admin.');
      }
      return;
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const admin = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      provider: 'local',
      role: 'admin',
      isActive: true,
      employment: { isStaff: true }
    });

    await admin.save();
    console.log('Admin user created successfully!');
    console.log(`  Email: ${email}`);
    console.log('  Role: admin');
    console.log('  Password: (the one you supplied; it is not shown here)');
  } catch (error) {
    console.error('Error creating admin:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed.');
  }
}

createAdmin();
