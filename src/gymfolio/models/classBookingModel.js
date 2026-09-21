// src/gymfolio/models/classBookingModel.js
//
// One member's place in one running of one class.
//
// The thing to understand here is that a GymClass does not have sessions --
// it has a weekly TEMPLATE (`schedule`: [{day, startTime, endTime}]). "Spin,
// Tuesdays at 18:00" is a rule, not an event, and there is no document
// anywhere for "Spin on Tuesday 3rd March".
//
// Rather than materialise every future session into its own collection --
// which means a job to create them, a decision about how far ahead, and a
// migration every time a timetable changes -- a booking simply names the slot
// it is for: the class, the date, and the start time. Sessions are computed
// from the template when they need to be listed, and this collection is the
// only thing that has to be stored.
//
// The consequence to keep in mind: editing a class's schedule does not move
// bookings that were made against the old times. `sessionEnd` and
// `instructorName` are snapshotted here so a booking still reads correctly
// after the timetable is rewritten, and cancelSessionBookings() exists for
// when a slot is removed outright.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const classBookingSchema = new mongoose.Schema(
  {
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GymClass',
      required: true,
      index: true
    },
    // Snapshotted so a cancelled or renamed class still reads correctly on a
    // member's history.
    className: { type: String, default: '' },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    memberName: { type: String, default: '' },
    memberCode: { type: String, default: '' },

    // ---- Which running of the class -------------------------------------
    //
    // 'YYYY-MM-DD' in the gym's local timezone, NOT a Date. A date is a
    // calendar fact here ("the Tuesday class"), and storing it as an instant
    // means every read has to undo a timezone conversion to get back to the
    // day everyone actually said.
    sessionDate: {
      type: String,
      required: true,
      index: true,
      validate: {
        validator: (v) => DATE_KEY.test(v),
        message: 'sessionDate must be YYYY-MM-DD'
      }
    },
    // 'HH:MM', 24-hour. Together with sessionDate this identifies the slot,
    // which is why both are in the unique index below.
    sessionStart: {
      type: String,
      required: true,
      validate: {
        validator: (v) => CLOCK.test(v),
        message: 'sessionStart must be HH:MM'
      }
    },
    sessionEnd: { type: String, default: '' },
    instructorName: { type: String, default: '' },

    // ---- State ------------------------------------------------------------
    //
    // booked     -- holds a place
    // waitlisted -- the session was full; promoted automatically on a cancel
    // cancelled  -- gave the place up, by the member or an admin
    // attended   -- turned up (set from the front desk or the admin roster)
    // no_show    -- did not turn up; kept distinct from 'cancelled' because a
    //               gym that never distinguishes them cannot see who is
    //               quietly wasting places other members wanted
    status: {
      type: String,
      enum: ['booked', 'waitlisted', 'cancelled', 'attended', 'no_show'],
      default: 'booked',
      index: true
    },

    // Position in the queue, 1-based. Null for anyone actually holding a
    // place. Kept as a stored number rather than derived from createdAt so
    // an admin can reorder a queue if they have a reason to.
    waitlistPosition: { type: Number, default: null },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '', trim: true },

    attendedAt: { type: Date, default: null },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Who made the booking. A member booking themselves in is the normal
    // case; the front desk booking someone in is the other one, and telling
    // them apart matters when a member disputes a no-show.
    bookedBy: {
      type: String,
      enum: ['member', 'staff'],
      default: 'member'
    },
    bookedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // What the member's membership looked like when they booked. Snapshotted
    // for the same reason attendance snapshots it: a renewal next week must
    // not rewrite the fact that this booking was taken on an expired package.
    //
    // The same superset the attendance row uses: whatever
    // peopleDirectory.membershipFor can answer must be storable here, or a
    // frozen member's booking fails validation instead of being recorded.
    membershipStatus: {
      type: String,
      enum: ['active', 'expiring', 'expired', 'none', 'frozen', 'past_due', 'pending', 'suspended', 'cancelled'],
      default: 'none'
    },

    // A session-pack credit was taken for this place (booking rules →
    // useCredits). Given back when the booking is cancelled in time.
    creditUsed: { type: Boolean, default: false },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageOrder', default: null },
    // Cancelled inside the cancel-by window: the credit stays used.
    lateCancel: { type: Boolean, default: false },

    // When the day-before reminder was sent, or null if it has not been.
    // Same idempotence guard as PackageOrder.remindersSent: the cron may run
    // more than once and must not email the same member twice.
    reminderSentAt: { type: Date, default: null },

    notes: { type: String, default: '', trim: true }
  },
  {
    timestamps: true,
    // Prefixed like every other collection in this project: the database is
    // shared with another application. See attendanceModel.js.
    collection: 'gym_class_bookings'
  }
);

// One live booking per member per slot.
//
// Partial on purpose: it applies only to bookings that still hold or await a
// place. Without the filter, a member who cancelled and changed their mind
// could never re-book the same session, because the cancelled row would
// collide with the new one.
classBookingSchema.index(
  { classId: 1, sessionDate: 1, sessionStart: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['booked', 'waitlisted'] } }
  }
);

// The count behind every capacity check.
classBookingSchema.index({ classId: 1, sessionDate: 1, sessionStart: 1, status: 1 });
// A member's own list, newest session first.
classBookingSchema.index({ userId: 1, sessionDate: -1 });
// The admin roster for a given day.
classBookingSchema.index({ sessionDate: -1, status: 1 });
// The nightly reminder sweep: tomorrow's live bookings not yet reminded.
classBookingSchema.index({ sessionDate: 1, status: 1, reminderSentAt: 1 });

/** Places actually taken for one slot. Waitlisted people are not in it. */
classBookingSchema.statics.countBooked = function (classId, sessionDate, sessionStart) {
  return this.countDocuments({
    classId,
    sessionDate,
    sessionStart,
    status: { $in: ['booked', 'attended'] }
  });
};

/** How many are queued for one slot. */
classBookingSchema.statics.countWaitlisted = function (classId, sessionDate, sessionStart) {
  return this.countDocuments({
    classId,
    sessionDate,
    sessionStart,
    status: 'waitlisted'
  });
};

/**
 * Moves the front of the queue into the place a cancellation just freed.
 *
 * Promotes ONE person and renumbers the rest, which is the whole reason
 * waitlistPosition is stored: after this runs the queue is still 1..n with no
 * gaps, so "you are third in line" stays true without recomputing it on read.
 *
 * Returns the promoted booking, or null if nobody was waiting.
 */
classBookingSchema.statics.promoteFromWaitlist = async function (classId, sessionDate, sessionStart) {
  // Taken off the queue with one conditional update, so two places freed at
  // the same moment go to two different people rather than both to the
  // front of the queue.
  const next = await this.findOneAndUpdate(
    { classId, sessionDate, sessionStart, status: 'waitlisted' },
    { $set: { status: 'booked', waitlistPosition: null } },
    { sort: { waitlistPosition: 1, createdAt: 1 }, new: true }
  );

  if (!next) return null;

  // Close the gap left behind, so positions stay contiguous.
  const remaining = await this.find({
    classId,
    sessionDate,
    sessionStart,
    status: 'waitlisted'
  }).sort({ waitlistPosition: 1, createdAt: 1 });

  for (let i = 0; i < remaining.length; i++) {
    const position = i + 1;
    if (remaining[i].waitlistPosition !== position) {
      remaining[i].waitlistPosition = position;
      await remaining[i].save();
    }
  }

  return next;
};

module.exports =
  tenantModel('ClassBooking', classBookingSchema);
