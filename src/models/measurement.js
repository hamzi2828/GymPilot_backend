// src/models/measurement.js

const mongoose = require('mongoose');

const measurementSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    unit: { type: String, default: 'inches', trim: true }, // e.g., 'inches', 'cm'
    placeholder: { type: String, default: '', trim: true }, // e.g., 'e.g., 40'
    description: { type: String, default: '', trim: true }, // Help text for users
    isRequired: { type: Boolean, default: false }, // Whether this measurement is required
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 }, // For ordering measurements
  },
  { timestamps: true }
);

module.exports = mongoose.model('Measurement', measurementSchema);
