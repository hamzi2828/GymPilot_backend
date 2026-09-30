// src/gymfolio/models/ptSessionModel.js
//
// A one-to-one appointment between a trainer and a member. Booked from the
// portal against the trainer's availability, or by staff. A session on a
// PT pack uses one of its credits; the trainer's commission is worked out
// when the session is marked completed.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const ptSessionSchema = new mongoose.Schema(
  {
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer', required: true, index: true },
    trainerName: { type: String, default: '' },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    memberName: { type: String, default: '' },
    memberCode: { type: String, default: '' },

    // Local calendar date and clock, like class bookings.
    date: { type: String, required: true, index: true, validate: { validator: (v) => DATE_KEY.test(v), message: 'date must be YYYY-MM-DD' } },
    startTime: { type: String, required: true, validate: { validator: (v) => CLOCK.test(v), message: 'startTime must be HH:MM' } },
    endTime: { type: String, default: '' },
    durationMinutes: { type: Number, default: 60 },

    status: { type: String, enum: ['scheduled', 'completed', 'cancelled', 'no_show'], default: 'scheduled', index: true },

    // The PT pack the session was taken from, if any.
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageOrder', default: null },
    creditUsed: { type: Boolean, default: false },
    // What the session is worth: the pack's per-session value, or the
    // trainer's rate when paid separately.
    price: { type: Number, default: 0 },
    currency: { type: String, default: '' },
    commission: {
      // 'percent' of the session's price, or a fixed 'amount' per session
      // (the trainer's terms when it was completed; ptService.commissionFor).
      basis: { type: String, enum: ['percent', 'amount'], default: 'percent' },
      percent: { type: Number, default: 0 },
      amount: { type: Number, default: 0 }
    },

    notes: { type: String, default: '', trim: true },
    bookedBy: { type: String, enum: ['member', 'staff'], default: 'member' },
    bookedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '', trim: true },
    lateCancel: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    reminderSentAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    collection: 'gym_pt_sessions'
  }
);

// One live appointment per trainer per slot.
ptSessionSchema.index(
  { trainerId: 1, date: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['scheduled', 'completed'] } } }
);
ptSessionSchema.index({ memberId: 1, date: -1 });
ptSessionSchema.index({ date: 1, status: 1 });

module.exports = tenantModel('PtSession', ptSessionSchema);
