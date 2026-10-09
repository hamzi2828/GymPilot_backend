// src/gymfolio/controller/classExceptionController.js
//
// One-off timetable changes: a cancelled session, a closed day, a stand-in
// instructor, a room change. Cancelling a session cancels the bookings on
// it and tells the members.

const mongoose = require('mongoose');
const ClassException = require('../models/classExceptionModel');
const GymClass = require('../models/gymClassModel');
const ClassBooking = require('../models/classBookingModel');
const Trainer = require('../models/trainerModel');
const User = require('../../models/user');
const notify = require('../../services/gymNotifications');
const { afterResponse } = require('../../services/afterResponse');
const { refundSession } = require('../services/membershipService');
const PackageOrder = require('../models/packageOrderModel');
const T = require('../../attendance/services/timeUtils');

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

function view(e) {
  return {
    id: String(e._id),
    class_id: e.classId ? String(e.classId) : null,
    class_name: e.className || '',
    date: e.date,
    start_time: e.startTime || '',
    kind: e.kind,
    instructor_id: e.instructor ? String(e.instructor) : null,
    instructor_name: e.instructorName || '',
    room: e.room || '',
    note: e.note || '',
    created_at: e.createdAt
  };
}

/** Cancels every live booking the exception covers, giving credits back. */
async function cancelCoveredBookings(exception, by) {
  const filter = { sessionDate: exception.date, status: { $in: ['booked', 'waitlisted'] } };
  if (exception.classId) filter.classId = exception.classId;
  if (exception.startTime) filter.sessionStart = exception.startTime;
  const found = await ClassBooking.find(filter).select('_id').lean();
  let cancelled = 0;
  for (const { _id } of found) {
    // One conditional update per booking, as a member's own cancel is
    // (classBookingController.cancel). A member cancelling at the same
    // moment used to be cancelled here a second time from the copy read
    // above, and got the credit back twice; whoever makes the change gives
    // the credit back, and the booking is read as it stands when they do.
    const booking = await ClassBooking.findOneAndUpdate(
      { _id, status: { $in: ['booked', 'waitlisted'] } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: by || null,
          cancelReason: exception.note || 'Session cancelled by the gym',
          waitlistPosition: null
        }
      },
      { new: true }
    );
    if (!booking) continue;
    cancelled += 1;
    if (booking.creditUsed && booking.orderId) {
      const order = await PackageOrder.findById(booking.orderId);
      if (order) await refundSession(order).catch(() => {});
    }
    // Kept alive past the response on Vercel, the member lookup included.
    afterResponse(
      User.findById(booking.userId)
        .select('firstName lastName email phone notificationPreferences')
        .lean()
        .then((member) => notify.bookingCancelled(booking, member, true)),
      'session cancelled notice'
    );
  }
  return cancelled;
}

module.exports = {
  // GET /api/gymfolio/class-exceptions?from=&to=
  list: async (req, res) => {
    try {
      const today = T.dateKey();
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : today;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : T.shiftDateKey(today, 90);
      const rows = await ClassException.find({ date: { $gte: from, $lte: to } }).sort({ date: 1, startTime: 1 }).limit(500).lean();
      return res.json({ success: true, range: { from, to }, data: rows.map(view) });
    } catch (error) {
      console.error('[exceptions] list failed:', error);
      return fail(res, 500, 'Could not load timetable changes');
    }
  },

  // POST /api/gymfolio/class-exceptions
  // { classId|null, date, startTime|'', kind, instructorId, instructorName, room, note }
  create: async (req, res) => {
    try {
      const body = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) return fail(res, 400, 'date must be YYYY-MM-DD');
      if (!['cancelled', 'substitute'].includes(body.kind)) return fail(res, 400, 'kind must be cancelled or substitute');
      if (body.startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.startTime))) return fail(res, 400, 'startTime must be HH:MM');

      let gymClass = null;
      if (body.classId) {
        if (!isId(body.classId)) return fail(res, 400, 'Invalid classId');
        gymClass = await GymClass.findById(body.classId).select('name').lean();
        if (!gymClass) return fail(res, 404, 'Class not found');
      }
      if (body.kind === 'substitute' && !gymClass) return fail(res, 400, 'A substitute applies to one class');

      let instructor = null;
      if (body.instructorId) {
        if (!isId(body.instructorId)) return fail(res, 400, 'Invalid instructorId');
        instructor = await Trainer.findById(body.instructorId).select('name').lean();
        if (!instructor) return fail(res, 404, 'Trainer not found');
      }
      if (body.kind === 'substitute' && !instructor && !String(body.instructorName || '').trim() && !String(body.room || '').trim()) {
        return fail(res, 400, 'Name the stand-in instructor or the new room');
      }

      const exception = await ClassException.create({
        classId: gymClass ? gymClass._id : null,
        className: gymClass ? gymClass.name : '',
        date: body.date,
        startTime: body.startTime || '',
        kind: body.kind,
        instructor: instructor ? instructor._id : null,
        instructorName: instructor ? instructor.name : String(body.instructorName || '').trim(),
        room: String(body.room || '').trim(),
        note: String(body.note || '').trim().slice(0, 300),
        createdBy: actorId(req)
      });

      let cancelledBookings = 0;
      if (exception.kind === 'cancelled') cancelledBookings = await cancelCoveredBookings(exception, actorId(req));

      return res.status(201).json({
        success: true,
        message: exception.kind === 'cancelled' ? `Cancelled${cancelledBookings ? `; ${cancelledBookings} booking(s) cancelled and the members told` : ''}.` : 'Timetable change saved.',
        data: view(exception),
        cancelled_bookings: cancelledBookings
      });
    } catch (error) {
      console.error('[exceptions] create failed:', error);
      return fail(res, 500, 'Could not save the timetable change');
    }
  },

  // DELETE /api/gymfolio/class-exceptions/:id
  remove: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Not found');
      await ClassException.deleteOne({ _id: req.params.id });
      return res.json({ success: true, message: 'Removed. Bookings that were cancelled stay cancelled; members can book again.' });
    } catch (error) {
      console.error('[exceptions] delete failed:', error);
      return fail(res, 500, 'Could not remove the timetable change');
    }
  }
};
