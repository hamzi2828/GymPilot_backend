// src/gymfolio/controller/classBookingController.js
//
// Booking a place in a class, giving it up, and the roster the front desk
// works from.
//
// The gym's booking rules (Settings → General → Booking rules; see
// services/bookingRules.js) decide the policy questions here: how far ahead
// members may book, when booking closes, whether a lapsed membership is
// refused or merely flagged, whether a session pack pays for a place, how
// late a cancellation may be before the credit is lost, and whether repeat
// no-shows are paused. Every one of them defaults to the behaviour the gym
// had before the rules existed: record, warn, never refuse.

const mongoose = require('mongoose');
const GymClass = require('../models/gymClassModel');
const ClassBooking = require('../models/classBookingModel');
const PackageOrder = require('../models/packageOrderModel');
const User = require('../../models/user');
const sessions = require('../services/classSessions');
const { consumeSession, refundSession } = require('../services/membershipService');
const { membershipFor, ensureMemberCode } = require('../../attendance/services/peopleDirectory');
const notify = require('../../services/gymNotifications');
const { afterResponse } = require('../../services/afterResponse');
const T = require('../../attendance/services/timeUtils');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(res, code, message, extra = {}) {
  return res.status(code).json({ success: false, message, ...extra });
}

/**
 * Whether a lapsed membership blocks a booking. Only when the gym has
 * switched requireActiveMembership on; otherwise the booking records what
 * the membership looked like and the roster shows it in red.
 */
function membershipGate(membership, rules) {
  if (!rules.requireActiveMembership || membership.status === 'active') return null;
  return (
    MEMBERSHIP_PROBLEMS[membership.status] ||
    'An active membership is needed to book classes — please speak to the front desk.'
  );
}

// What to tell a member whose membership is not simply active, keyed by what
// peopleDirectory.membershipFor answered. Used both to refuse a booking (when
// the gym requires an active membership) and to flag one that went ahead.
const MEMBERSHIP_PROBLEMS = {
  expired: 'Your membership has expired — please renew before booking.',
  cancelled: 'Your membership has been cancelled — please renew before booking.',
  suspended: 'Your membership is suspended — please speak to the front desk.',
  frozen: 'Your membership is frozen — resume it before booking.',
  past_due: 'Your last payment failed — please update your card.',
  pending: 'Your membership is awaiting payment confirmation.',
  none: 'There is no membership on this account — please speak to the front desk.'
};

/**
 * Repeat no-shows pause booking for a while, when the gym has asked for
 * that (noShowStrikes > 0). Returns the message to show, or null.
 */
async function noShowBlock(userId, rules) {
  if (!rules.noShowStrikes) return null;
  const since = T.shiftDateKey(T.dateKey(), -rules.noShowWindowDays);
  const misses = await ClassBooking.find({ userId, status: 'no_show', sessionDate: { $gte: since } })
    .sort({ sessionDate: -1 })
    .select('sessionDate')
    .lean();
  if (misses.length < rules.noShowStrikes) return null;
  const until = T.shiftDateKey(misses[0].sessionDate, rules.noShowBanDays);
  if (until <= T.dateKey()) return null;
  return `Booking is paused until ${T.dateLabelForKey(until)} after ${misses.length} missed classes. Please speak to the front desk.`;
}

/**
 * Takes one credit from a session pack for a place, when the member is on
 * one and the gym uses credits. Throws MembershipError when the pack is
 * empty. Memberships that are not packs cost nothing per class.
 */
async function takeCredit(membership, rules, by, note) {
  if (!rules.useCredits || membership.sessionsLeft === null || membership.sessionsLeft === undefined || !membership.orderId) {
    return { creditUsed: false, orderId: null };
  }
  const order = await PackageOrder.findById(membership.orderId);
  if (!order || !order.sessions || !order.sessions.total) return { creditUsed: false, orderId: null };
  // A personal-training pack pays for PT sessions, not for classes.
  if (order.packageDetails && order.packageDetails.kind === 'pt_pack') return { creditUsed: false, orderId: null };
  await consumeSession(order, { by, note });
  return { creditUsed: true, orderId: order._id };
}

async function giveCreditBack(booking) {
  if (!booking.creditUsed || !booking.orderId) return;
  const order = await PackageOrder.findById(booking.orderId);
  if (order) await refundSession(order).catch(() => {});
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
    credit_used: !!booking.creditUsed,
    late_cancel: !!booking.lateCancel,
    notes: booking.notes || '',
    created_at: booking.createdAt,
    cancelled_at: booking.cancelledAt,
    attended_at: booking.attendedAt
  };
}

function rulesView(rules) {
  return {
    horizon_days: rules.horizonDays,
    cutoff_minutes: rules.cutoffMinutes,
    cancel_hours: rules.cancelHours,
    require_active_membership: rules.requireActiveMembership,
    use_credits: rules.useCredits
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
      const { range, sessions: list, rules } = await sessions.timetable(req.query, userId);

      return res.json({
        success: true,
        range,
        timezone: T.TIMEZONE,
        horizon_days: rules.horizonDays,
        rules: rulesView(rules),
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
    let credit = { creditUsed: false, orderId: null };
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

      const [gymClass, member, rules] = await Promise.all([
        GymClass.findById(classId),
        User.findById(targetUserId),
        sessions.rules()
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

      // A session the gym has called off for that day.
      const exception = sessions.exceptionFor(await sessions.exceptionsFor(date, date), gymClass._id, date, startTime);
      if (exception && exception.kind === 'cancelled') {
        return fail(res, 409, `This session has been cancelled${exception.note ? `: ${exception.note}` : ''}.`);
      }

      // Members book within the horizon; staff may book further out.
      if (!req.isStaffBooking && date > T.shiftDateKey(T.dateKey(), rules.horizonDays)) {
        return fail(res, 409, `Classes can be booked up to ${rules.horizonDays} days ahead.`);
      }

      if (sessions.isClosed(date, startTime, new Date(), rules)) {
        return fail(
          res,
          409,
          rules.cutoffMinutes
            ? `Booking for this session has closed. It closes ${rules.cutoffMinutes} minutes before the class starts.`
            : 'This session has already started.'
        );
      }

      const membership = await membershipFor(member);
      const blocked = membershipGate(membership, rules);
      if (blocked) return fail(res, 402, blocked);

      if (!req.isStaffBooking) {
        const paused = await noShowBlock(member._id, rules);
        if (paused) return fail(res, 403, paused);
      }

      // The places still free, by seat number ([] when the session is full).
      // A class without a capacity does not number its places.
      const capacity = Number(gymClass.capacity) || 0;
      const seats = capacity > 0 ? await ClassBooking.freeSeats(gymClass._id, date, startTime, capacity) : [];
      let full = capacity > 0 && !seats.length;

      // A place on a session pack costs a credit; the waiting list costs
      // nothing until a place actually comes free.
      if (!full) credit = await takeCredit(membership, rules, actorId, `${gymClass.name} ${date} ${startTime}`);

      const fields = {
        classId: gymClass._id,
        className: gymClass.name,
        userId: member._id,
        memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
        memberCode: await ensureMemberCode(member).catch(() => ''),
        sessionDate: date,
        sessionStart: startTime,
        sessionEnd: slot.endTime || '',
        instructorName: (exception && exception.kind === 'substitute' && exception.instructorName) || slot.instructorName || '',
        bookedBy: req.isStaffBooking ? 'staff' : 'member',
        bookedByUserId: actorId,
        membershipStatus: membership.status,
        notes: req.body.notes ? String(req.body.notes).trim() : ''
      };
      const place = { status: 'booked', creditUsed: credit.creditUsed, orderId: credit.orderId };

      // Two members after the last place both find it free above. Each
      // writes its booking holding that place's number, and the unique index
      // on the number lets exactly one of them have it; the other tries the
      // next free number. Every free place is taken, and a class never ends
      // up with more people than places.
      let booking = null;
      if (!capacity) booking = await ClassBooking.create({ ...fields, ...place });
      for (const seat of seats) {
        try {
          booking = await ClassBooking.create({ ...fields, ...place, seat });
          break;
        } catch (error) {
          if (!ClassBooking.seatTaken(error)) throw error;
        }
      }

      // Full -- or every free place went to somebody else a moment ago, which
      // is exactly as if it had been full, so the credit goes back: the
      // waiting list costs nothing until a place comes free.
      let waitlistPosition = null;
      if (!booking) {
        if (credit.creditUsed) {
          const spent = credit;
          credit = { creditUsed: false, orderId: null };
          await giveCreditBack({ creditUsed: true, orderId: spent.orderId }).catch(() => {});
        }
        full = true;
        waitlistPosition = (await ClassBooking.countWaitlisted(gymClass._id, date, startTime)) + 1;
        booking = await ClassBooking.create({ ...fields, status: 'waitlisted', waitlistPosition });
      }

      // Not awaited: a slow or misconfigured mail server must not hold up the
      // response to somebody standing in the gym with their phone out. Kept
      // alive past the response on Vercel (services/afterResponse.js).
      afterResponse(notify.bookingCreated(booking, member), 'booking notice');

      return res.status(201).json({
        success: true,
        message: full
          ? `${gymClass.name} is full — you are number ${waitlistPosition} on the waiting list and will be moved up automatically if someone cancels.`
          : `Booked into ${gymClass.name} on ${T.dateLabelForKey(date)} at ${startTime}.${credit.creditUsed ? ' One session was taken from your pack.' : ''}`,
        // Surfaced rather than swallowed: the member is booked either way, and
        // the desk should be told there is money to collect.
        membership_warning:
          membership.status === 'active'
            ? null
            : MEMBERSHIP_PROBLEMS[membership.status] || MEMBERSHIP_PROBLEMS.none,
        data: bookingView(booking)
      });
    } catch (error) {
      // A credit taken for a place that was never written goes back.
      if (credit.creditUsed && credit.orderId) {
        PackageOrder.findById(credit.orderId).then((order) => order && refundSession(order)).catch(() => {});
      }
      if (error && error.name === 'MembershipError') return fail(res, 402, error.message);
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

      const [rows, rules] = await Promise.all([
        ClassBooking.find(filter)
          .sort({ sessionDate: scope === 'past' ? -1 : 1, sessionStart: 1 })
          .limit(200)
          .lean(),
        sessions.rules()
      ]);

      return res.json({
        success: true,
        rules: rulesView(rules),
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

      const [found, rules] = await Promise.all([ClassBooking.findById(id), sessions.rules()]);
      let booking = found;
      if (!booking) return fail(res, 404, 'Booking not found');

      const isOwner = String(booking.userId) === String(actorId);
      if (!isOwner && !req.isStaffBooking) {
        return fail(res, 403, 'You can only cancel your own bookings');
      }

      if (['cancelled', 'attended', 'no_show'].includes(booking.status)) {
        return fail(res, 409, `This booking is already ${booking.status.replace('_', ' ')}.`);
      }

      const heldAPlace = booking.status === 'booked';

      // Inside the cancel-by window a member keeps nothing: the place is
      // freed but the credit stays used. Staff cancelling never costs the
      // member anything.
      const startsAt = sessions.localInstant(booking.sessionDate, booking.sessionStart);
      const late = rules.cancelHours > 0 && startsAt.getTime() - rules.cancelHours * 3600 * 1000 < Date.now();

      // One conditional update from the status read above to cancelled. Two
      // cancels arriving together (a double tap, the member and the desk)
      // used to both get through -- the credit went back twice and two people
      // were promoted into one freed place. Only the one that makes the
      // change carries on.
      const cancelled = await ClassBooking.findOneAndUpdate(
        { _id: booking._id, status: booking.status },
        {
          $set: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelledBy: actorId || null,
            cancelReason: req.body && req.body.reason ? String(req.body.reason).trim() : '',
            waitlistPosition: null,
            lateCancel: late && !req.isStaffBooking
          }
        },
        { new: true }
      );
      if (!cancelled) {
        const current = await ClassBooking.findById(booking._id).select('status').lean();
        const status = current ? current.status : 'cancelled';
        // Still live, just not as read a moment ago (promoted off the
        // waiting list, say): nothing was cancelled, so ask for another go.
        if (['booked', 'waitlisted'].includes(status)) {
          return fail(res, 409, 'This booking changed a moment ago. Please try again.');
        }
        return fail(res, 409, `This booking is already ${status.replace('_', ' ')}.`);
      }
      booking = cancelled;

      if (!booking.lateCancel) await giveCreditBack(booking);

      // Only a real place frees a place. Cancelling from the waiting list
      // promotes nobody.
      let promoted = null;
      if (heldAPlace) {
        // The freed place is taken by its seat number, which needs the
        // class's capacity to know which numbers there are.
        const gymClass = await GymClass.findById(booking.classId).select('capacity').lean();
        promoted = await ClassBooking.promoteFromWaitlist(
          booking.classId,
          booking.sessionDate,
          booking.sessionStart,
          Number(gymClass && gymClass.capacity) || 0
        );
        // The promoted member's pack pays for the place now that they have it.
        if (promoted) {
          try {
            const promotedUser = await User.findById(promoted.userId);
            if (promotedUser) {
              const credit = await takeCredit(await membershipFor(promotedUser), rules, actorId, `${promoted.className} ${promoted.sessionDate} ${promoted.sessionStart} (from waiting list)`);
              if (credit.creditUsed) {
                promoted.creditUsed = true;
                promoted.orderId = credit.orderId;
                await promoted.save();
              }
            }
          } catch (error) {
            // An empty pack does not lose them the place they waited for; the
            // desk sees the booking without a credit and can sort it out.
            console.error('[bookings] credit on promotion failed:', error.message);
          }
        }
      }

      // Two people to tell: whoever gave the place up, and whoever just got
      // it. The second matters more -- a member on a waiting list has no way
      // to know a place came free unless we say so.
      // Both run after the response, the member lookup included -- on Vercel
      // a lookup still in flight when the response goes would never send.
      afterResponse(
        User.findById(booking.userId)
          .select('firstName lastName email')
          .lean()
          .then((member) => notify.bookingCancelled(booking, member, !!req.isStaffBooking)),
        'booking cancelled notice'
      );

      if (promoted) {
        afterResponse(
          User.findById(promoted.userId)
            .select('firstName lastName email')
            .lean()
            .then((member) => notify.bookingPromoted(promoted, member)),
          'booking promoted notice'
        );
      }

      return res.json({
        success: true,
        message: booking.lateCancel
          ? `Cancelled. This was inside the ${rules.cancelHours}-hour window, so the session credit stays used.`
          : `Booking cancelled.${booking.creditUsed ? ' The session credit is back on the pack.' : ''}`,
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

      // Put back into a place by hand -- from a no-show, a cancellation or
      // the waiting list. The seat number it had may belong to somebody else
      // by now, so it goes back without one; it still counts as a place
      // taken (see ClassBooking.freeSeats), the desk having overridden.
      const holdsAPlace = (s) => ['booked', 'attended'].includes(s);
      if (holdsAPlace(status) && !holdsAPlace(booking.status)) booking.seat = undefined;

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
