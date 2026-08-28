// src/models/activityLog.js

const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    action: { type: String, required: true }, // e.g., 'page_visit', 'create', 'update', 'delete'
    module: { type: String, required: true }, // e.g., 'Dashboard', 'POS', 'Sales', etc.
    description: { type: String, default: null }, // Additional details
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }, // Any extra data
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
}, { timestamps: true });

// Index for faster queries
activityLogSchema.index({ employee: 1, createdAt: -1 });
activityLogSchema.index({ module: 1 });

module.exports = mongoose.models.ActivityLog || mongoose.model('ActivityLog', activityLogSchema);
