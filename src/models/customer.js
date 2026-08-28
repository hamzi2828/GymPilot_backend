// src/models/customer.js

const mongoose = require('mongoose');

const sizePreferenceSchema = new mongoose.Schema({
    category: { type: String, trim: true },  // e.g., 'Tops', 'Bottoms', 'Shoes'
    size: { type: String, trim: true }       // e.g., 'M', 'L', '32', '10'
}, { _id: false });

const customerSchema = new mongoose.Schema({
    customerCode: {
        type: String,
        unique: true,
        sparse: true,
        trim: true
    },
    customerType: {
        type: String,
        enum: ['walk-in', 'online', 'wholesale', 'corporate'],
        default: 'walk-in'
    },
    source: {
        type: String,
        enum: ['facebook', 'instagram', 'tiktok', 'word-of-mouth', 'website', 'other', ''],
        default: ''
    },
    firstName: {
        type: String,
        required: true,
        trim: true
    },
    lastName: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        sparse: true,
        lowercase: true,
        trim: true
    },
    phone: {
        type: String,
        required: true,
        trim: true
    },
    alternatePhone: {
        type: String,
        default: '',
        trim: true
    },
    address: {
        street: { type: String, default: '', trim: true },
        city: { type: String, default: '', trim: true },
        state: { type: String, default: '', trim: true },
        zipCode: { type: String, default: '', trim: true },
        country: { type: String, default: '', trim: true }
    },
    sizePreferences: [sizePreferenceSchema],
    stylePreferences: [{
        type: String,
        trim: true
    }],
    notes: {
        type: String,
        default: '',
        trim: true
    },
    totalOrders: {
        type: Number,
        default: 0
    },
    totalSpent: {
        type: Number,
        default: 0
    },
    lastOrderDate: {
        type: Date,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.models.Customer || mongoose.model('Customer', customerSchema);
