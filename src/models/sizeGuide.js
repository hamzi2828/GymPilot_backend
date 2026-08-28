// src/models/sizeGuide.js

const mongoose = require('mongoose');

const sizeGuideSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    imageUrl: { type: String, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SizeGuide', sizeGuideSchema);
