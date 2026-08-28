const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// MongoDB connection
require('dotenv').config();
const MONGO_URI = process.env.MONGO_URI;

// User Schema (inline to avoid path issues)
const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: false, default: null },
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleId: { type: String, default: null, index: true },
    avatarUrl: { type: String, default: null },
    phone: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: null },
    role: { type: String, enum: ['user', 'admin', 'moderator'], default: 'user' },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

// Admin user data
const adminUser = {
    firstName: 'Gymwear',
    lastName: 'Admin',
    email: 'admin@gmail.com',
    password: 'Admin@123',
    role: 'admin',
    provider: 'local',
    isActive: true
};

async function createAdminUser() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        // Check if admin already exists
        const existingAdmin = await User.findOne({ email: adminUser.email });
        if (existingAdmin) {
            console.log('Admin user already exists:');
            console.log(`  Email: ${existingAdmin.email}`);
            console.log(`  Role: ${existingAdmin.role}`);
            await mongoose.disconnect();
            return;
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(adminUser.password, salt);

        // Create admin user
        const newAdmin = await User.create({
            ...adminUser,
            password: hashedPassword
        });

        console.log('Admin user created successfully!');
        console.log('--------------------------------');
        console.log(`  Email: ${newAdmin.email}`);
        console.log(`  Password: ${adminUser.password}`);
        console.log(`  Role: ${newAdmin.role}`);
        console.log('--------------------------------');

        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    } catch (error) {
        console.error('Error creating admin user:', error.message);
        await mongoose.disconnect();
        process.exit(1);
    }
}

createAdminUser();
