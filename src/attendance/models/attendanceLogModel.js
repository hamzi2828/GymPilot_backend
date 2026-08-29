// src/attendance/models/attendanceLogModel.js
//
// Append-only audit trail for the desktop app. One row per event, never
// updated, so the attendance table can be corrected later without erasing
// what actually happened at the reader.
//
// Template downloads are logged as deliberately as punches: that endpoint
// hands decrypted biometric templates to a front-desk PC, and there should be
// a record of every time it did.

const mongoose = require('mongoose');

const attendanceLogSchema = new mongoose.Schema(
  {
    event: {
      type: String,
      enum: [
        'login',
        'login_denied',
        'logout',
        'template_download',
        'enroll',
        'punch',
        'punch_denied'
      ],
      required: true,
      index: true
    },

    // The signed-in front-desk account that caused the event.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    userEmail: { type: String, default: '' },

    // Who the event was ABOUT, when that differs from who caused it -- the
    // member or trainer whose finger was scanned.
    personType: { type: String, enum: ['member', 'staff', null], default: null },
    personId: { type: mongoose.Schema.Types.ObjectId, default: null },
    personName: { type: String, default: '' },

    action: { type: String, default: '' },     // check_in | check_out | ignore
    method: { type: String, default: '' },     // fingerprint | manual
    success: { type: Boolean, default: true },
    message: { type: String, default: '' },

    device: { type: String, default: '' },
    osUser: { type: String, default: '' },
    clientApp: { type: String, default: '' },
    ip: { type: String, default: '' },

    // Free-form extras per event type (template counts, finger index, the
    // status verdict) without giving every one of them a column.
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application. See the
    // note in attendanceModel.js.
    collection: 'gym_attendance_logs'
  }
);

attendanceLogSchema.index({ createdAt: -1 });
attendanceLogSchema.index({ userId: 1, createdAt: -1 });
attendanceLogSchema.index({ personType: 1, personId: 1, createdAt: -1 });

// Logging must never be the reason a punch fails, so every call site fires
// this without awaiting a result and swallows its errors here.
attendanceLogSchema.statics.record = function (entry) {
  return this.create(entry).catch((err) => {
    console.error('[attendance] audit log write failed:', err.message);
    return null;
  });
};

module.exports =
  mongoose.models.AttendanceLog || mongoose.model('AttendanceLog', attendanceLogSchema);
