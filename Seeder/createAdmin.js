// createAdmin.js - Create admin user

const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('../scripts/lib/tenantScript');
const bcrypt = require('bcryptjs');
const User = require('../src/models/user');

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

// Admin credentials
const adminData = {
  firstName: 'Admin',
  lastName: 'User',
  email: 'admin@gymwear.com',
  password: 'admin123',
  provider: 'local',
  role: 'admin',
  isActive: true,
};

async function createAdmin() {
  try {
    await connectDB();
    // Every gym has its own database: --gym <slug> picks which one.
    enterContext(await resolveGymContextFromArgs());
    console.log('Creating admin user...\n');

    // Check if admin already exists
    const existingAdmin = await User.findOne({ email: adminData.email });
    if (existingAdmin) {
      console.log(`Admin already exists: ${existingAdmin.email} (role: ${existingAdmin.role})`);
      // Update role to admin if not already
      if (existingAdmin.role !== 'admin') {
        existingAdmin.role = 'admin';
        await existingAdmin.save();
        console.log('Updated existing user role to admin.');
      }
      return;
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(adminData.password, salt);

    const admin = new User({
      ...adminData,
      password: hashedPassword,
    });

    await admin.save();
    console.log('Admin user created successfully!');
    console.log(`  Email: ${adminData.email}`);
    console.log(`  Password: ${adminData.password}`);
    console.log(`  Role: ${adminData.role}`);
  } catch (error) {
    console.error('Error creating admin:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed.');
  }
}

createAdmin();
