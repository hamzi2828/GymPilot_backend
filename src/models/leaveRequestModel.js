// src/models/leaveRequestModel.js
//
// A staff member's request for time off, and what was decided about it.
// Dates are local calendar keys like every other roster date.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ['annual', 'sick', 'unpaid', 'other'];

const leaveRequestSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    staffName: { type: String, default: '' },
    type: { type: String, enum: TYPES, default: 'annual' },
    from: { type: String, required: true, validate: { validator: (v) => DATE_KEY.test(v), message: 'from must be YYYY-MM-DD' }, index: true },
    to: { type: String, required: true, validate: { validator: (v) => DATE_KEY.test(v), message: 'to must be YYYY-MM-DD' } },
    days: { type: Number, default: 1, min: 0.5 },
    reason: { type: String, default: '', trim: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByName: { type: String, default: '' },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '', trim: true },
    // Unpaid leave is taken off a salaried payslip for the period.
    unpaid: { type: Boolean, default: false }
  },
  {
    timestamps: true,
    collection: 'gym_leave_requests'
  }
);

leaveRequestSchema.index({ staffId: 1, from: -1 });
leaveRequestSchema.statics.TYPES = TYPES;

module.exports = tenantModel('LeaveRequest', leaveRequestSchema);
