// src/gymfolio/controller/ptController.js
//
// Personal training: trainers taking bookings, their free slots, and the
// appointments themselves -- booked by the member from the portal or by
// staff from the panel.

const mongoose = require('mongoose');
const Trainer = require('../models/trainerModel');
const PtSession = require('../models/ptSessionModel');
const User = require('../../models/user');
const pt = require('../services/ptService');
const { ptRules } = require('../services/bookingRules');
const T = require('../../attendance/services/timeUtils');

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

function handle(res, error, fallback) {
  if (error instanceof pt.PtError) return fail(res, error.status, error.message);
  if (error && error.name === 'MembershipError') return fail(res, error.status || 400, error.message);
  console.error(`[pt] ${fallback}:`, error);
  return fail(res, 500, fallback);
}

function view(s) {
  return {
    id: String(s._id),
    trainer_id: String(s.trainerId),
    trainer_name: s.trainerName,
    member_id: String(s.memberId),
    member_name: s.memberName,
    member_code: s.memberCode || '',
    date: s.date,
    start_time: s.startTime,
    end_time: s.endTime,
    duration_minutes: s.durationMinutes,
    status: s.status,
    credit_used: !!s.creditUsed,
    order_id: s.orderId ? String(s.orderId) : null,
    price: s.price || 0,
    currency: s.currency || '',
    commission: s.commission || { percent: 0, amount: 0 },
    notes: s.notes || '',
    booked_by: s.bookedBy,
    late_cancel: !!s.lateCancel,
    cancel_reason: s.cancelReason || '',
    created_at: s.createdAt
  };
}

function range(query) {
  const today = T.dateKey();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? String(query.from) : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? String(query.to) : T.shiftDateKey(from, 14);
  return from <= to ? { from, to } : { from: to, to: from };
}

module.exports = {
  // GET /api/gymfolio/pt/trainers   (public)
  trainers: async (req, res) => {
    try {
      const [rows, rules] = await Promise.all([
        Trainer.find({ isActive: true, acceptsPt: { $ne: false } }).sort({ order: 1, name: 1 }).select('name slug role image specialties experience ptRate availability').lean(),
        ptRules()
      ]);
      return res.json({
        success: true,
        rules: { slot_minutes: rules.slotMinutes, allow_member_booking: rules.allowMemberBooking, require_pack: rules.requirePack, cancel_hours: rules.cancelHours },
        data: rows.map((t) => ({ id: String(t._id), name: t.name, slug: t.slug, role: t.role, image: t.image || '', specialties: t.specialties || [], experience: t.experience || 0, rate: t.ptRate || 0, has_availability: (t.availability || []).some((w) => w && w.day && w.startTime) }))
      });
    } catch (error) {
      return handle(res, error, 'Could not load trainers');
    }
  },

  // GET /api/gymfolio/pt/availability?trainerId=&from=&to=
  availability: async (req, res) => {
    try {
      const { trainerId } = req.query;
      if (!isId(trainerId)) return fail(res, 400, 'A valid trainerId is required');
      const trainer = await Trainer.findById(trainerId).lean();
      if (!trainer || !trainer.isActive) return fail(res, 404, 'Trainer not found');
      const { from, to } = range(req.query);
      const slots = await pt.availability(trainer, from, to, { includeTaken: req.query.all === '1' });
      return res.json({ success: true, timezone: T.TIMEZONE, range: { from, to }, data: slots });
    } catch (error) {
      return handle(res, error, 'Could not load availability');
    }
  },

  // POST /api/gymfolio/pt/sessions   { trainerId, date, startTime, notes }   (member)
  // POST /api/gymfolio/pt/sessions/staff  { ...same, userId }               (staff)
  create: async (req, res) => {
    try {
      const rules = await ptRules();
      if (!req.isStaffBooking && !rules.allowMemberBooking) return fail(res, 403, 'Personal training is booked at the front desk at this gym');
      const body = req.body || {};
      const memberId = req.isStaffBooking && body.userId ? body.userId : actorId(req);
      const session = await pt.book({
        trainerId: body.trainerId,
        memberId,
        date: body.date,
        startTime: body.startTime,
        by: actorId(req),
        bookedBy: req.isStaffBooking ? 'staff' : 'member',
        notes: body.notes
      });
      return res.status(201).json({
        success: true,
        message: `Booked with ${session.trainerName} on ${T.dateLabelForKey(session.date)} at ${session.startTime}.${session.creditUsed ? ' One session was taken from your pack.' : ''}`,
        data: view(session)
      });
    } catch (error) {
      return handle(res, error, 'Could not book the session');
    }
  },

  // GET /api/gymfolio/pt/sessions/me?scope=upcoming|past
  mine: async (req, res) => {
    try {
      const today = T.dateKey();
      const scope = String(req.query.scope || 'upcoming');
      const filter = { memberId: actorId(req) };
      if (scope === 'upcoming') {
        filter.date = { $gte: today };
        filter.status = 'scheduled';
      } else if (scope === 'past') {
        filter.$or = [{ date: { $lt: today } }, { status: { $ne: 'scheduled' } }];
      }
      const rows = await PtSession.find(filter).sort({ date: scope === 'past' ? -1 : 1, startTime: 1 }).limit(200).lean();
      const pack = await pt.ptPackFor(actorId(req));
      const me = await User.findById(actorId(req)).select('assignedTrainerId').lean();
      const assigned = me && me.assignedTrainerId ? await Trainer.findById(me.assignedTrainerId).select('name slug image role').lean() : null;
      return res.json({
        success: true,
        data: rows.map(view),
        pack: pack ? { order_id: String(pack._id), name: pack.packageDetails && pack.packageDetails.name, total: pack.sessions.total, used: pack.sessions.used || 0, left: pack.sessions.total - (pack.sessions.used || 0), ends_at: pack.subscription && pack.subscription.endDate } : null,
        assigned_trainer: assigned ? { id: String(assigned._id), name: assigned.name, slug: assigned.slug, image: assigned.image || '', role: assigned.role } : null
      });
    } catch (error) {
      return handle(res, error, 'Could not load your sessions');
    }
  },

  // DELETE /api/gymfolio/pt/sessions/:id           (member: own)
  // DELETE /api/gymfolio/pt/sessions/staff/:id     (staff: any)
  cancel: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid session id');
      const found = await PtSession.findById(req.params.id);
      if (!found) return fail(res, 404, 'Session not found');
      if (!req.isStaffBooking && String(found.memberId) !== String(actorId(req))) return fail(res, 403, 'You can only cancel your own sessions');
      const session = await pt.cancel(found, { by: actorId(req), reason: (req.body || {}).reason, byStaff: !!req.isStaffBooking });
      return res.json({
        success: true,
        message: session.lateCancel ? 'Cancelled. This was a late cancellation, so the session credit was not returned.' : `Cancelled.${session.creditUsed ? ' The session credit is back on the pack.' : ''}`,
        data: view(session)
      });
    } catch (error) {
      return handle(res, error, 'Could not cancel the session');
    }
  },

  // GET /api/gymfolio/pt/sessions?from=&to=&trainerId=&memberId=&status=   (staff)
  list: async (req, res) => {
    try {
      const { from, to } = range(req.query);
      const filter = { date: { $gte: from, $lte: to } };
      if (isId(req.query.trainerId)) filter.trainerId = req.query.trainerId;
      if (isId(req.query.memberId)) filter.memberId = req.query.memberId;
      if (['scheduled', 'completed', 'cancelled', 'no_show'].includes(req.query.status)) filter.status = req.query.status;
      const rows = await PtSession.find(filter).sort({ date: 1, startTime: 1 }).limit(500).lean();
      return res.json({ success: true, range: { from, to }, data: rows.map(view) });
    } catch (error) {
      return handle(res, error, 'Could not load sessions');
    }
  },

  // PATCH /api/gymfolio/pt/sessions/:id/status   { status: completed|no_show|scheduled }
  setStatus: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid session id');
      const { status } = req.body || {};
      const session = await PtSession.findById(req.params.id);
      if (!session) return fail(res, 404, 'Session not found');
      if (status === 'completed') await pt.complete(session, { by: actorId(req) });
      else if (status === 'no_show') await pt.noShow(session);
      else if (status === 'scheduled') {
        if (session.status === 'cancelled') return fail(res, 409, 'Book a new session instead of reopening a cancelled one');
        session.status = 'scheduled';
        session.completedAt = null;
        session.commission = { percent: 0, amount: 0 };
        await session.save();
      } else return fail(res, 400, 'status must be completed, no_show or scheduled');
      return res.json({ success: true, message: 'Session updated.', data: view(session) });
    } catch (error) {
      return handle(res, error, 'Could not update the session');
    }
  },

  // GET /api/gymfolio/pt/summary?from=&to=   (staff)
  summary: async (req, res) => {
    try {
      const { from, to } = range(req.query);
      const rows = await pt.summary(from, to);
      return res.json({ success: true, range: { from, to }, data: rows });
    } catch (error) {
      return handle(res, error, 'Could not load the summary');
    }
  }
};
