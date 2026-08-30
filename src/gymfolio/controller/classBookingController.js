// src/gymfolio/controller/classBookingController.js
//
// Booking a place in a class, giving it up, and the roster the front desk
// works from.
//
// One policy decision worth stating outright, because it is the kind of thing
// that looks like an oversight otherwise: a member whose package has lapsed is
// NOT refused a booking. The booking records what their membership looked like
// at the time and says so, and the roster shows it in red.
//
// That is the same stance the attendance module already takes at the front
// desk, and for the same reason: refusing loses the information that the
// person tried, whereas recording it puts the fact in front of a human who can
// act on it while the member is still reachable. A gym that wants a hard
// refusal has one place to add it -- `membershipGate` below.

const mongoose = require('mongoose');
const GymClass = require('../models/gymClassModel');
const ClassBooking = require('../models/classBookingModel');
const User = require('../../models/user');
const sessions = require('../services/classSessions');
const { membershipFor, ensureMemberCode } = require('../../attendance/services/peopleDirectory');
const notify = require('../../services/gymNotifications');
const T = require('../../attendance/services/timeUtils');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(res, code, message, extra = {}) {
  return res.status(code).json({ success: false, message, ...extra });
}

/**
 * Whether a lapsed membership blocks a booking. Currently never -- see the
 * note at the top of this file. Kept as one named function so the policy has
 * an obvious home rather than being spread through the handler.
 */
function membershipGate(/* membership */) {
  return null;
}

function bookingView(booking) {
  return {
    id: String(booking._id),
    class_id: String(booking.classId),
    class_name: booking.className,
    user_id: String(booking.userId),
    member_name: booking.memberName,
    member_code: booking.memberCode,
    date: booking.sessionDate,
    start_time: booking.sessionStart,
    end_time: booking.sessionEnd,
    instructor_name: booking.instructorName,
    status: booking.status,
    waitlist_position: booking.waitlistPosition,
    membership_status: booking.membershipStatus,
    booked_by: booking.bookedBy,
    notes: booking.notes || '',
    created_at: booking.createdAt,
    cancelled_at: booking.cancelledAt,
    attended_at: booking.attendedAt
  };
}

module.exports = {
  // -------------------------------------------------------------------------
  // GET /api/gymfolio/timetable   (public, richer when signed in)
  //
  // Every active class expanded over a date range. optionalAuth, so a signed-in
  // member additionally sees which sessions they already hold a place on --
  // and an anonymous visitor still gets a working timetable to browse.
  // -------------------------------------------------------------------------
  async timetable(req, res) {
    try {
      const userId = req.user ? req.user.id || req.user._id : null;
      const { range, sessions: list } = await sessions.timetable(req.query, userId);

      return res.json({
        success: true,
        range,
        timezone: T.TIMEZONE,
        horizon_days: sessions.BOOKING_HORIZON_DAYS,
        data: list
      });
    } catch (error) {
      console.error('timetable error:', error);
      return fail(res, 500, 'Could not load the timetable');
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/gymfolio/gym-classes/:id/sessions   (public)
  // -------------------------------------------------------------------------
  async classSessions(req, res) {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return fail(res, 400, 'Invalid class id');

      const gymClass = await GymClass.findById(id)
        .populate('schedule.instructor', 'name')
        .lean();
      if (!gymClass) return fail(res, 404, 'Class not found');

      const userId = req.user ? req.user.id || req.user._id : null;
      const list = await sessions.sessionsForClass(gymClass, req.query, userId);

      return res.json({ success: true, timezone: T.TIMEZONE, data: list });
    } catch (error) {
      console.error('classSessions error:', error);
      return fail(res, 500, 'Could not load sessions for this class');
    }
  },

  // -------------------------------------------------------------------------
  // POST /api/gymfolio/bookings   (member books themselves in)
  //
  // Body: { classId, date, startTime }
  // -------------------------------------------------------------------------
  async create(req, res) {
    try {
      const actorId = req.user && (req.user.id || req.user._id);
      if (!actorId) return fail(res, 401, 'Please sign in to book a class');

      const { classId, date, startTime } = req.body;

      if (!classId || !mongoose.Types.ObjectId.isValid(classId)) {
        return fail(res, 400, 'A valid classId is required');
      }
      if (!DATE_KEY.test(String(date || ''))) {
        return fail(res, 400, 'date must be in YYYY-MM-DD form');
      }
      if (!CLOCK.test(String(startTime || ''))) {
        return fail(res, 400, 'startTime must be in HH:MM form');
      }

      // An admin may book somebody else in; a member may only book themselves.
      // `targetUserId` is ignored unless the caller came through the staff
      // route, which is the only one that sets req.isStaffBooking.
      const targetUserId = req.isStaffBooking && req.body.userId ? req.body.userId : actorId;
      if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
        return fail(res, 400, 'Invalid member id');
      }

      const [gymClass, member] = await Promise.all([
        GymClass.findById(classId),
        User.findById(targetUserId)
      ]);

      if (!gymClass) return fail(res, 404, 'Class not found');
      if (!gymClass.isActive) return fail(res, 409, 'This class is not currently running');
      if (!member || member.isActive === false) return fail(res, 404, 'Member not found');

      // The slot must exist in the class's weekly template. This is what stops
      // a hand-crafted request booking a session that does not run.
      const slot = sessions.findSlot(gymClass, date, startTime);
      if (!slot) {
        return fail(
          res,
          409,
          `${gymClass.name} does not run at ${startTime} on ${T.weekdayNameForKey(date)}s`
        );
      }

      if (sessions.isClosed(date, startTime)) {
        return fail(
          res,
          409,
          `Booking for this session has closed. It opens ${sessions.CUTOFF_MINUTES} minutes before the class starts.`
        );
      }

      const membership = await membershipFor(member);
      const blocked = membershipGate(membership);
      if (blocked) return fail(res, 402, blocked);

      const capacity = Number(gymClass.capacity) || 0;
      const taken = await ClassBooking.countBooked(gymClass._id, date, startTime);
      const full = capacity > 0 && taken >= capacity;

      let waitlistPosition = null;
      if (full) {
        waitlistPosition = (await ClassBooking.countWaitlisted(gymClass._id, date, startTime)) + 1;
      }

      const booking = await ClassBooking.create({
        classId: gymClass._id,
        className: gymClass.name,
        userId: member._id,
        memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
        memberCode: await ensureMemberCode(member).catch(() => ''),
        sessionDate: date,
        sessionStart: startTime,
        sessionEnd: slot.endTime || '',
        instructorName: slot.instructorName || '',
        status: full ? 'waitlisted' : 'booked',
        waitlistPosition,
        bookedBy: req.isStaffBooking ? 'staff' : 'member',
        bookedByUserId: actorId,
        membershipStatus: membership.status,
        notes: req.body.notes ? String(req.body.notes).trim() : ''
      });

      // Fired, not awaited: a slow or misconfigured mail server must not hold
      // up the response to somebody standing in the gym with their phone out.
      notify.bookingCreated(booking, member);

      return res.status(201).json({
        success: true,
        message: full
          ? `${gymClass.name} is full — you are number ${waitlistPosition} on the waiting list and will be moved up automatically if someone cancels.`
          : `Booked into ${gymClass.name} on ${T.dateLabelForKey(date)} at ${startTime}.`,
        // Surfaced rather than swallowed: the member is booked either way, and
        // the desk should be told there is money to collect.
        membership_warning:
          membership.status === 'active'
            ? null
            : membership.status === 'expired'
            ? 'This membership has expired — please renew at the front desk.'
            : 'There is no membership on this account — please speak to the front desk.',
        data: bookingView(booking)
      });
    } catch (error) {
      // The partial unique index is what enforces "one live booking per member
      // per slot", so a duplicate arrives here as a write error rather than as
      // a race the handler had to guess about.
      if (error && error.code === 11000) {
        return fail(res, 409, 'You already have a place on this session.');
      }
      console.error('create booking error:', error);
      return fail(res, 500, 'Could not book this class', { error: error.message });
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/gymfolio/bookings/me
  // -------------------------------------------------------------------------
  async mine(req, res) {
    try {
      const userId = req.user && (req.user.id || req.user._id);
      if (!userId) return fail(res, 401, 'Authentication required');

      const today = T.dateKey();
      const scope = String(req.query.scope || 'upcoming');

      const filter = { userId };
      if (scope === 'upcoming') {
        filter.sessionDate = { $gte: today };
        filter.status = { $in: ['booked', 'waitlisted'] };
      } else if (scope === 'past') {
        filter.sessionDate = { $lt: today };
      }

      const rows = await ClassBooking.find(filter)
        .sort({ sessionDate: scope === 'past' ? -1 : 1, sessionStart: 1 })
        .limit(200)
        .lean();

      return res.json({
        success: true,
        data: rows.map(bookingView),
        counts: {
          upcoming: await ClassBooking.countDocuments({
            userId,
            sessionDate: { $gte: today },
            status: { $in: ['booked', 'waitlisted'] }
          })
        }
      });
    } catch (error) {
      console.error('my bookings error:', error);
      return fail(res, 500, 'Could not load your bookings');
    }
  },

  // -------------------------------------------------------------------------
  // DELETE /api/gymfolio/bookings/:id
  //
  // A member may cancel their own; staff holding the permission may cancel
  // anyone's. Cancelling frees a place, so the waiting list is promoted here.
  // -------------------------------------------------------------------------
  async cancel(req, res) {
    try {
      const actorId = req.user && (req.user.id || req.user._id);
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) return fail(res, 400, 'Invalid booking id');

      const booking = await ClassBooking.findById(id);
      if (!booking) return fail(res, 404, 'Booking not found');

      const isOwner = String(booking.userId) === String(actorId);
      if (!isOwner && !req.isStaffBooking) {
        return fail(res, 403, 'You can only cancel your own bookings');
      }

      if (['cancelled', 'attended', 'no_show'].includes(booking.status)) {
        return fail(res, 409, `This booking is already ${booking.status.replace('_', ' ')}.`);
      }

      const heldAPlace = booking.status === 'booked';

      booking.status = 'cancelled';
      booking.cancelledAt = new Date();
      booking.cancelledBy = actorId;
      booking.cancelReason = req.body && req.body.reason ? String(req.body.reason).trim() : '';
      booking.waitlistPosition = null;
      await booking.save();

      // Only a real place frees a place. Cancelling from the waiting list
      // promotes nobody.
      let promoted = null;
      if (heldAPlace) {
        promoted = await ClassBooking.promoteFromWaitlist(
          booking.classId,
          booking.sessionDate,
          booking.sessionStart
        );
      }

      // Two people to tell: whoever gave the place up, and whoever just got
      // it. The second matters more -- a member on a waiting list has no way
      // to know a place came free unless we say so.
      User.findById(booking.userId)
        .select('firstName lastName email')
        .lean()
        .then((member) => notify.bookingCancelled(booking, member, !!req.isStaffBooking))
        .catch(() => {});

      if (promoted) {
        User.findById(promoted.userId)
          .select('firstName lastName email')
          .lean()
          .then((member) => notify.bookingPromoted(promoted, member))
          .catch(() => {});
      }

      return res.json({
        success: true,
        message: 'Booking cancelled.',
        promoted: promoted
          ? { id: String(promoted._id), member_name: promoted.memberName }
          : null,
        data: bookingView(booking)
      });
    } catch (error) {
      console.error('cancel booking error:', error);
      return fail(res, 500, 'Could not cancel this booking');
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/gymfolio/bookings   (admin roster)
  // -------------------------------------------------------------------------
  async list(req, res) {
    try {
      const { date, classId, status, search } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

      const filter = {};
      if (DATE_KEY.test(String(date || ''))) filter.sessionDate = date;
      if (classId && mongoose.Types.ObjectId.isValid(classId)) filter.classId = classId;
      if (status) filter.status = status;
      if (search && String(search).trim()) {
        const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp(escaped, 'i');
        filter.$or = [{ memberName: rx }, { memberCode: rx }, { className: rx }];
      }

      const [rows, total] = await Promise.all([
        ClassBooking.find(filter)
          .sort({ sessionDate: -1, sessionStart: 1, waitlistPosition: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        ClassBooking.countDocuments(filter)
      ]);

      return res.json({
        success: true,
        data: rows.map(bookingView),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
      });
    } catch (error) {
      console.error('list bookings error:', error);
      return fail(res, 500, 'Could not load bookings');
    }
  },

  // -------------------------------------------------------------------------
  // PATCH /api/gymfolio/bookings/:id/status   (admin: attended / no_show)
  // -------------------------------------------------------------------------
  async setStatus(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) return fail(res, 400, 'Invalid booking id');
      if (!['attended', 'no_show', 'booked'].includes(status)) {
        return fail(res, 400, 'status must be attended, no_show or booked');
      }

      const booking = await ClassBooking.findById(id);
      if (!booking) return fail(res, 404, 'Booking not found');

      booking.status = status;
      booking.attendedAt = status === 'attended' ? new Date() : null;
      booking.markedBy = req.user && (req.user.id || req.user._id);
      await booking.save();

      return res.json({ success: true, message: 'Booking updated.', data: bookingView(booking) });
    } catch (error) {
      console.error('set booking status error:', error);
      return fail(res, 500, 'Could not update this booking');
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/gymfolio/bookings/session   (admin: one session's register)
  //
  // ?classId=&date=&startTime=
  // -------------------------------------------------------------------------
  async session(req, res) {
    try {
      const { classId, date, startTime } = req.query;

      if (!classId || !mongoose.Types.ObjectId.isValid(classId)) {
        return fail(res, 400, 'A valid classId is required');
      }
      if (!DATE_KEY.test(String(date || ''))) return fail(res, 400, 'date must be YYYY-MM-DD');
      if (!CLOCK.test(String(startTime || ''))) return fail(res, 400, 'startTime must be HH:MM');

      const gymClass = await GymClass.findById(classId).lean();
      if (!gymClass) return fail(res, 404, 'Class not found');

      const rows = await ClassBooking.find({ classId, sessionDate: date, sessionStart: startTime })
        .sort({ status: 1, waitlistPosition: 1, createdAt: 1 })
        .lean();

      const booked = rows.filter((r) => ['booked', 'attended', 'no_show'].includes(r.status));
      const waiting = rows.filter((r) => r.status === 'waitlisted');

      return res.json({
        success: true,
        session: {
          class_id: String(gymClass._id),
          class_name: gymClass.name,
          date,
          start_time: startTime,
          capacity: Number(gymClass.capacity) || 0,
          booked_count: booked.filter((r) => r.status !== 'no_show').length,
          waitlist_count: waiting.length
        },
        register: booked.map(bookingView),
        waitlist: waiting.map(bookingView)
      });
    } catch (error) {
      console.error('session register error:', error);
      return fail(res, 500, 'Could not load this session');
    }
  }
};
