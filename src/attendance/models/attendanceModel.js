// src/attendance/models/attendanceModel.js
//
// One row per person per shift day, holding both halves of the visit. A
// check-out updates the row its check-in created rather than inserting a
// second row, so "how long were they here" is a subtraction on one document.
//
// Attribution is stored per half, never overwritten: a member can check in at
// one desk and out at another, and both desks stay legible in the record.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

// Who took this half of the punch, and from where. Repeated for in and out.
const punchContextSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    device: { type: String, default: '' },   // front-desk PC hostname
    osUser: { type: String, default: '' },   // Windows account on that PC
    clientApp: { type: String, default: '' },
    ip: { type: String, default: '' },
    // How the person was identified. Recorded because a hand-picked punch is
    // a weaker claim than a matched fingerprint, and an audit should be able
    // to tell them apart.
    method: {
      type: String,
      // qr: scanned from the member's account page; code: their member
      // number typed at a kiosk or desk.
      enum: ['fingerprint', 'manual', 'qr', 'code'],
      default: 'fingerprint'
    }
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    personType: {
      type: String,
      enum: ['member', 'staff'],
      required: true,
      index: true
    },
    personId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    // Snapshotted so a historic row still reads correctly after a rename or
    // a deleted account.
    personName: { type: String, default: '' },
    personCode: { type: String, default: '' },

    // 'YYYY-MM-DD' -- the day the visit is FILED against, which is not always
    // the calendar day of the check-out (a night shift ending at 02:00
    // belongs to the day it started).
    shiftDate: { type: String, required: true, index: true },

    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
    checkIn: { type: punchContextSchema, default: () => ({}) },
    checkOut: { type: punchContextSchema, default: () => ({}) },

    workedMinutes: { type: Number, default: null },

    // Members: what their membership looked like at the moment they walked
    // in. Snapshotted because a renewal tomorrow must not rewrite the fact
    // that today's visit was on an expired package.
    membership: {
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageOrder', default: null },
      packageName: { type: String, default: '' },
      endDate: { type: Date, default: null },
      // active   -- paid and in date
      // expired  -- had a package, its end date has passed
      // none     -- never bought one
      status: { type: String, enum: ['active', 'expired', 'none'], default: 'none' }
    },

    // Staff: the rostered shift this punch was judged against, taken from the
    // trainer's availability for that weekday.
    schedule: {
      startTime: { type: String, default: '' },  // 'HH:MM'
      endTime: { type: String, default: '' },
      hasSchedule: { type: Boolean, default: false }
    },

    // on_time | late | early | overtime | no_schedule  (staff)
    // membership_active | membership_expired | membership_none  (members)
    status: { type: String, default: '' },
    statusLabel: { type: String, default: '' },
    // Signed minutes away from the rostered time: negative = early,
    // positive = late. Kept as a number so reports can aggregate it.
    varianceMinutes: { type: Number, default: null }
  },
  {
    timestamps: true,
    // Explicit, and NOT the 'attendances' Mongoose would derive by default.
    //
    // This database is shared with another application, which already owns an
    // `attendances` collection carrying a unique index on { employee, date }.
    // Documents written by this schema have neither field, so the second one
    // inserted collides with the first on { null, null } and the punch fails.
    // Every collection in this module is prefixed for the same reason.
    collection: 'gym_attendance'
  }
);

// The lookup every punch starts with: "is this person already open today?"
attendanceSchema.index({ personType: 1, personId: 1, shiftDate: -1 });
attendanceSchema.index({ shiftDate: -1, personType: 1 });
attendanceSchema.index({ checkInAt: -1 });

module.exports =
  tenantModel('Attendance', attendanceSchema);
