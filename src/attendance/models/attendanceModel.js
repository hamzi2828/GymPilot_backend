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
    // The site the desk account is set up for (its attendanceLocation), so a
    // visit that starts at one branch and ends at another says so.
    location: { type: String, default: '' },
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

// The times on the row at one moment, for either side of a correction.
const visitTimesSchema = new mongoose.Schema(
  {
    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
    workedMinutes: { type: Number, default: null }
  },
  { _id: false }
);

// One administrator correction (controller/attendanceCorrectionController.js):
// who made it, when, why, and the times either side of it.
const correctionSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ['edit', 'void'], required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note: { type: String, default: '' },
    before: { type: visitTimesSchema, default: () => ({}) },
    after: { type: visitTimesSchema, default: () => ({}) }
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
      // active    -- paid and in date
      // expiring  -- paid, in date, ending within the warning window
      // expired   -- had a package, its end date has passed
      // none      -- never bought one
      // frozen / past_due / suspended / cancelled -- the order's own state,
      //           reported as such so the desk can say so
      // pending   -- unpaid order awaiting payment confirmation (bank transfer),
      //             or, with `startsOn`, a paid one that has not started yet
      //
      // A superset of everything peopleDirectory.membershipFor can answer:
      // an enum narrower than the source crashed the punch with a validation
      // error the moment a frozen member walked in.
      status: {
        type: String,
        enum: ['active', 'expiring', 'expired', 'none', 'frozen', 'past_due', 'pending', 'suspended', 'cancelled'],
        default: 'none'
      },
      // When a paid membership that had not started yet was due to start
      // (status 'pending'); null otherwise. Not covered, not lapsed: the
      // check-out and the day's board say "starts on" from this.
      startsOn: { type: Date, default: null },
      // Money still owed on that package when they walked in (the order's
      // payment.balanceDue) and the currency it is in. Kept with the visit so
      // the check-out repeats the check-in's "Balance due", and so the day's
      // board can say who owed what without re-reading every order.
      balanceDue: { type: Number, default: 0 },
      currency: { type: String, default: '' }
    },

    // Staff: the rostered shift this punch was judged against, taken from the
    // trainer's availability for that weekday.
    schedule: {
      startTime: { type: String, default: '' },  // 'HH:MM'
      endTime: { type: String, default: '' },
      hasSchedule: { type: Boolean, default: false }
    },

    // Staff: the ARRIVAL verdict -- on_time | late | early | no_schedule --
    // kept for good once written. Members: the membership_* verdict.
    status: { type: String, default: '' },
    statusLabel: { type: String, default: '' },
    // Signed minutes away from the rostered start: negative = early,
    // positive = late. Kept as a number so reports can aggregate it.
    varianceMinutes: { type: Number, default: null },

    // Staff: how the shift ENDED -- on_time | early (left early) | overtime |
    // no_schedule -- written at check-out. Separate fields rather than the
    // three above: someone who arrived late and left on time was still late,
    // and overwriting the arrival is how "late" came to count only the staff
    // who had not gone home yet. Rows closed before these existed carry the
    // departure in `status` instead.
    departureStatus: { type: String, default: '' },
    departureLabel: { type: String, default: '' },
    departureVarianceMinutes: { type: Number, default: null },

    // Nobody checked out, and the visit is past the point a scan could still
    // close it (services/staleVisits.js). No check-out time and no duration
    // are invented for it: an hours total should not include hours nobody
    // recorded.
    autoClosed: { type: Boolean, default: false },
    autoClosedAt: { type: Date, default: null },

    // True on the one visit a scan would close, and absent on every other row:
    // set at check-in, removed at check-out, when the daily job auto-closes the
    // visit, and when a later check-in finds it past the window. It exists for
    // the unique index below and for nothing else -- "is this visit open" is
    // still answered from checkOutAt and the window (services/staleVisits.js),
    // because rows written before the flag existed, and by the seeder, do not
    // carry it.
    open: { type: Boolean },

    // Staff: the last moment a scan may still close this visit -- the rostered
    // shift's end plus a grace, or a fixed span when there is no roster
    // (staleVisits.staffOpenUntil). Written at check-in so the window can be
    // asked of the database. Null for members, whose window is
    // OPEN_VISIT_HOURS alone, and on rows written before it existed.
    openUntil: { type: Date, default: null },

    // A visit that should never have been recorded -- the wrong person picked
    // at the desk, a test scan -- voided by an administrator. The row stays
    // for the record, but no read counts it (see the middleware below).
    voided: { type: Boolean, default: false },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: '' },

    // Every administrator correction to this visit, oldest first. A punch is
    // evidence: a correction does not erase what the desk recorded, it is
    // written down beside it.
    edits: { type: [correctionSchema], default: [] }
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
// "Who is inside right now" and the daily sweep of forgotten visits both ask
// for the open rows first; without this they would walk the whole history.
attendanceSchema.index({ checkOutAt: 1, autoClosed: 1, checkInAt: -1 });

// One open visit per person. Two scans that arrive together -- the
// fingerprint desk and the kiosk QR, or a finger left on the reader -- both
// find no open visit and both go to check the person in; the second insert
// fails here, and punchService answers it as the repeat scan it is.
//
// Partial on `open: true` (equality on a boolean, which every MongoDB version
// accepts in a partial index), so finished visits and rows from before the
// flag existed are not in it at all, and the index builds on a gym's existing
// history without a migration.
attendanceSchema.index(
  { personType: 1, personId: 1 },
  { unique: true, partialFilterExpression: { open: true }, name: 'one_open_visit_per_person' }
);

// A voided visit is left out of every read of this model -- find, count,
// distinct and aggregate -- so the punch log's totals, "inside now", the
// dashboard, reports, a member's own history and both payroll paths stop
// counting it the moment it is voided, without each of them having to
// remember to ask. A read that means to see voided rows says so, either by
// filtering on `voided` itself or with the withVoided option:
//
//   Attendance.find(filter).setOptions({ withVoided: true })
//   Attendance.aggregate(pipeline).option({ withVoided: true })
//
// Writes are not scoped: the few that could touch a voided row (the daily
// close of forgotten visits) say `voided` in their own filter.
const NOT_VOIDED = { voided: { $ne: true } };

// Stages MongoDB requires to come first in a pipeline; the filter goes after.
const FIRST_STAGES = ['$geoNear', '$search', '$searchMeta', '$vectorSearch', '$collStats', '$indexStats'];

attendanceSchema.pre(['find', 'findOne', 'countDocuments', 'distinct'], function excludeVoided() {
  const options = this.getOptions();
  if (options.withVoided) {
    // Ours, not the driver's: taken off before the query is sent.
    delete options.withVoided;
    return;
  }
  if (Object.prototype.hasOwnProperty.call(this.getFilter(), 'voided')) return;
  this.where(NOT_VOIDED);
});

attendanceSchema.pre('aggregate', function excludeVoided() {
  if (this.options && this.options.withVoided) {
    delete this.options.withVoided;
    return;
  }
  const pipeline = this.pipeline();
  const first = pipeline[0] || {};
  const at = FIRST_STAGES.some((stage) => stage in first) ? 1 : 0;
  pipeline.splice(at, 0, { $match: { ...NOT_VOIDED } });
});

module.exports =
  tenantModel('Attendance', attendanceSchema);
