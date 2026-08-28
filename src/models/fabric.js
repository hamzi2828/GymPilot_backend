// src/models/fabric.js

const mongoose = require('mongoose');

const fabricSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    description: { type: String, default: '', trim: true },
    imageUrl: { type: String, default: null },
    pricePerMeter: { type: Number, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Fabric', fabricSchema);
