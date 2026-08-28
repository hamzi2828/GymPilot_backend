const mongoose = require('mongoose');

const citySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { _id: true, timestamps: true });

const stateSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    cities: [citySchema]
}, { _id: true, timestamps: true });

const countySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        unique: true
    },
    code: {
        type: String,
        trim: true,
        uppercase: true
    },
    cities: [stateSchema], // Keep as 'cities' for database compatibility
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Index for faster queries
countySchema.index({ name: 1 });
countySchema.index({ isActive: 1 });

module.exports = mongoose.model('Country', countySchema); // Keep model name for DB compatibility
