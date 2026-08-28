// src/models/employee.js

const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: null },
    cnic: { type: String, default: null }, // National ID
    position: { type: String, default: null }, // Job title
    department: { type: String, default: null },
    role: { type: String, enum: ['employee', 'manager', 'supervisor', 'admin'], default: 'employee' },
    salary: { type: Number, required: true },
    hireDate: { type: Date, default: Date.now },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: ['male', 'female', 'other'], default: null },
    address: {
        street: { type: String, default: null },
        city: { type: String, default: null },
        state: { type: String, default: null },
        zipCode: { type: String, default: null },
        country: { type: String, default: 'Pakistan' }
    },
    emergencyContact: {
        name: { type: String, default: null },
        phone: { type: String, default: null },
        relationship: { type: String, default: null }
    },
    bankDetails: {
        accountTitle: { type: String, default: null },
        accountNumber: { type: String, default: null },
        bankName: { type: String, default: null }
    },
    notes: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

// Virtual for full name
employeeSchema.virtual('name').get(function() {
    return `${this.firstName} ${this.lastName}`.trim();
});

// Ensure virtuals are included in JSON
employeeSchema.set('toJSON', { virtuals: true });
employeeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Employee || mongoose.model('Employee', employeeSchema);
