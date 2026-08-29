// src/models/roleModel.js
//
// A named set of sidebar permissions, plus whether holding it makes someone
// staff. Roles are data rather than code so a gym can invent "Night Duty
// Manager" without a deploy.
//
// The slug is what lands in User.role and in the JWT, which is why the two
// original values ('user', 'admin') are preserved as slugs: every existing
// check of `role === 'admin'` keeps working after this collection appears.

const mongoose = require('mongoose');
const { fullPermissionMap } = require('../config/permissions');

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // Lowercase, hyphenated, unique. Stored on the user and in their token.
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },

    description: { type: String, default: '', trim: true },

    // Staff roles get payroll, a roster and attendance; member roles do not.
    // This is the line between "someone who trains here" and "someone who
    // works here", and it is the only thing that distinguishes them.
    isStaff: { type: Boolean, default: true },

    // { tabKey: 'none' | 'view' | 'manage' } for every tab in the catalogue.
    permissions: {
      type: Map,
      of: String,
      default: () => fullPermissionMap()
    },

    // System roles cannot be deleted or have their slug changed: 'admin' is
    // the only way back in if permissions are misconfigured, and 'user' is
    // what every member signs up as.
    isSystem: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },

    // Sort order in the pickers, so the important roles are not alphabetised
    // to the bottom.
    order: { type: Number, default: 0 }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application. See the note
    // in src/attendance/models/attendanceModel.js.
    collection: 'gym_roles'
  }
);

roleSchema.index({ isStaff: 1, isActive: 1 });

module.exports = mongoose.models.Role || mongoose.model('Role', roleSchema);
