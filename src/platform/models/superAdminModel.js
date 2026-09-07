// src/platform/models/superAdminModel.js
//
// The people who run the platform. A separate collection from any gym's
// users on purpose: a gym administrator's credentials must never be able to
// open the panel that lists every other gym.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const superAdminSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null }
  },
  {
    timestamps: true,
    collection: 'super_admins'
  }
);

module.exports = platformModel('SuperAdmin', superAdminSchema);
