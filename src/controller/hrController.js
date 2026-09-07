// src/controller/hrController.js
//
// Leave requests and payslips: what staff ask for and what they are paid.
// Staff use the "my work" endpoints from the portal; managers use the
// admin ones from Operations → Staff.

const mongoose = require('mongoose');
const User = require('../models/user');
const LeaveRequest = require('../models/leaveRequestModel');
const Payslip = require('../models/payslipModel');
const Expense = require('../accounts/models/expenseModel');
const PtSession = require('../gymfolio/models/ptSessionModel');
const Trainer = require('../gymfolio/models/trainerModel');
const payroll = require('../services/payrollService');
const L = require('../accounts/services/ledger');
const T = require('../attendance/services/timeUtils');

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

async function actorName(req) {
  const me = await User.findById(actorId(req)).select('firstName lastName email').lean();
  return me ? [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email : '';
}

function leaveView(l) {
  return {
    id: String(l._id),
    staff_id: String(l.staffId),
    staff_name: l.staffName,
    type: l.type,
    from: l.from,
    to: l.to,
    days: l.days,
    reason: l.reason || '',
    status: l.status,
    unpaid: !!l.unpaid,
    decided_by: l.decidedByName || '',
    decided_at: l.decidedAt,
    decision_note: l.decisionNote || '',
    created_at: l.createdAt
  };
}

function payslipView(p) {
  return {
    id: String(p._id),
    number: p.number,
    staff_id: String(p.staffId),
    staff_name: p.staffName,
    job_title: p.jobTitle || '',
    period: p.period,
    currency: p.currency,
    basis: p.basis,
    base: p.base,
    hours: p.hours,
    rate: p.rate,
    unpaid_leave_days: p.unpaidLeaveDays,
    unpaid_leave_deduction: p.unpaidLeaveDeduction,
    pt_sessions: p.ptSessions,
    pt_commission: p.ptCommission,
    earnings: (p.earnings || []).map((l) => ({ id: String(l._id), label: l.label, amount: l.amount })),
    deductions: (p.deductions || []).map((l) => ({ id: String(l._id), label: l.label, amount: l.amount })),
    gross: p.gross,
    net: p.net,
    status: p.status,
    issued_at: p.issuedAt,
    paid_on: p.paidOn,
    payment_method: p.paymentMethod,
    reference: p.reference || '',
    notes: p.notes || '',
    created_at: p.createdAt
  };
}

function readLines(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .map((l) => ({ label: String((l && l.label) || '').trim().slice(0, 120), amount: Math.round((Number(l && l.amount) || 0) * 100) / 100 }))
    .filter((l) => l.label && l.amount)
    .slice(0, 20);
}

async function nextExpenseReference(incurredOn) {
  const prefix = `EXP-${T.dateKey(incurredOn).slice(0, 7).replace('-', '')}-`;
  const last = await Expense.findOne({ reference: new RegExp('^' + prefix) }).sort({ reference: -1 }).select('reference').lean();
  const n = last ? parseInt(String(last.reference).slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n || 1).padStart(4, '0')}`;
}

function inclusiveDays(from, to) {
  let n = 0;
  let cursor = from;
  while (cursor <= to && n < 366) {
    n += 1;
    cursor = T.shiftDateKey(cursor, 1);
  }
  return n;
}

module.exports = {
  // ---- staff self-service ----------------------------------------------------

  // GET /staff/me/work  -> my shifts, leave, payslips, PT summary
  myWork: async (req, res) => {
    try {
      const me = await User.findById(actorId(req)).select('firstName lastName employment').lean();
      if (!me || !me.employment || !me.employment.isStaff) return res.json({ success: true, data: null });
      const [leave, payslips, trainer] = await Promise.all([
        LeaveRequest.find({ staffId: me._id }).sort({ from: -1 }).limit(50).lean(),
        Payslip.find({ staffId: me._id, status: { $in: ['issued', 'paid'] } }).sort({ 'period.from': -1 }).limit(24).lean(),
        Trainer.findOne({ userId: me._id }).select('_id name').lean()
      ]);
      let pt = null;
      if (trainer) {
        const monthStart = `${T.dateKey().slice(0, 7)}-01`;
        const rows = await PtSession.aggregate([
          { $match: { trainerId: trainer._id, date: { $gte: monthStart }, status: { $in: ['scheduled', 'completed'] } } },
          { $group: { _id: '$status', n: { $sum: 1 }, commission: { $sum: '$commission.amount' } } }
        ]);
        pt = { scheduled: 0, completed: 0, commission: 0 };
        for (const r of rows) {
          pt[r._id] = r.n;
          if (r._id === 'completed') pt.commission = Math.round(r.commission * 100) / 100;
        }
      }
      return res.json({
        success: true,
        data: {
          job_title: (me.employment && me.employment.jobTitle) || '',
          schedule: (me.employment.schedule || []).map((s) => ({ day: s.day, start_time: s.startTime, end_time: s.endTime })),
          leave: leave.map(leaveView),
          payslips: payslips.map(payslipView),
          pt_this_month: pt
        }
      });
    } catch (error) {
      console.error('[hr] my work failed:', error);
      return fail(res, 500, 'Could not load your work details');
    }
  },

  // POST /staff/me/leave   { type, from, to, reason }
  requestLeave: async (req, res) => {
    try {
      const me = await User.findById(actorId(req)).select('firstName lastName email employment').lean();
      if (!me || !me.employment || !me.employment.isStaff) return fail(res, 403, 'Only staff accounts can request leave');
      const { type, from, to, reason } = req.body || {};
      if (!DATE_KEY.test(String(from || '')) || !DATE_KEY.test(String(to || ''))) return fail(res, 400, 'from and to must be YYYY-MM-DD');
      if (to < from) return fail(res, 400, 'The end date is before the start date');
      const overlap = await LeaveRequest.findOne({ staffId: me._id, status: { $in: ['pending', 'approved'] }, from: { $lte: to }, to: { $gte: from } });
      if (overlap) return fail(res, 409, `You already have ${overlap.status} leave from ${overlap.from} to ${overlap.to}`);
      const leave = await LeaveRequest.create({
        staffId: me._id,
        staffName: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email,
        type: LeaveRequest.TYPES.includes(type) ? type : 'annual',
        from,
        to,
        days: inclusiveDays(from, to),
        reason: String(reason || '').trim().slice(0, 500),
        unpaid: type === 'unpaid'
      });
      return res.status(201).json({ success: true, message: 'Leave requested. Your manager will be in touch.', data: leaveView(leave) });
    } catch (error) {
      console.error('[hr] request leave failed:', error);
      return fail(res, 500, 'Could not request leave');
    }
  },

  // DELETE /staff/me/leave/:id   (withdraw a pending request)
  withdrawLeave: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Request not found');
      const leave = await LeaveRequest.findOne({ _id: req.params.id, staffId: actorId(req) });
      if (!leave) return fail(res, 404, 'Request not found');
      if (leave.status !== 'pending') return fail(res, 409, `This request is already ${leave.status}`);
      leave.status = 'cancelled';
      await leave.save();
      return res.json({ success: true, message: 'Request withdrawn.', data: leaveView(leave) });
    } catch (error) {
      console.error('[hr] withdraw leave failed:', error);
      return fail(res, 500, 'Could not withdraw the request');
    }
  },

  // GET /staff/me/payslips/:id/pdf
  myPayslipPdf: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Payslip not found');
      const slip = await Payslip.findOne({ _id: req.params.id, staffId: actorId(req), status: { $in: ['issued', 'paid'] } });
      if (!slip) return fail(res, 404, 'Payslip not found');
      const pdf = await payroll.renderPayslipPdf(slip);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${slip.number}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      console.error('[hr] payslip pdf failed:', error);
      return fail(res, 500, 'Could not render the payslip');
    }
  },

  // ---- managers ------------------------------------------------------------------

  // GET /staff/leave?status=&from=&to=
  listLeave: async (req, res) => {
    try {
      const filter = {};
      if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) filter.status = req.query.status;
      if (isId(req.query.staffId)) filter.staffId = req.query.staffId;
      if (DATE_KEY.test(String(req.query.from || ''))) filter.to = { $gte: req.query.from };
      if (DATE_KEY.test(String(req.query.to || ''))) filter.from = { ...(filter.from || {}), $lte: req.query.to };
      const rows = await LeaveRequest.find(filter).sort({ status: 1, from: -1 }).limit(500).lean();
      const pending = await LeaveRequest.countDocuments({ status: 'pending' });
      return res.json({ success: true, pending, data: rows.map(leaveView) });
    } catch (error) {
      console.error('[hr] list leave failed:', error);
      return fail(res, 500, 'Could not load leave requests');
    }
  },

  // POST /staff/leave   { staffId, type, from, to, reason, approve }  -- recorded by a manager
  createLeave: async (req, res) => {
    try {
      const { staffId, type, from, to, reason, approve } = req.body || {};
      if (!isId(staffId)) return fail(res, 400, 'A valid staffId is required');
      const person = await User.findById(staffId).select('firstName lastName email employment').lean();
      if (!person || !person.employment || !person.employment.isStaff) return fail(res, 404, 'Staff member not found');
      if (!DATE_KEY.test(String(from || '')) || !DATE_KEY.test(String(to || ''))) return fail(res, 400, 'from and to must be YYYY-MM-DD');
      if (to < from) return fail(res, 400, 'The end date is before the start date');
      const approved = approve !== false && approve !== 'false';
      const leave = await LeaveRequest.create({
        staffId: person._id,
        staffName: [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email,
        type: LeaveRequest.TYPES.includes(type) ? type : 'annual',
        from,
        to,
        days: inclusiveDays(from, to),
        reason: String(reason || '').trim().slice(0, 500),
        unpaid: type === 'unpaid',
        status: approved ? 'approved' : 'pending',
        decidedBy: approved ? actorId(req) : null,
        decidedByName: approved ? await actorName(req) : '',
        decidedAt: approved ? new Date() : null
      });
      return res.status(201).json({ success: true, data: leaveView(leave) });
    } catch (error) {
      console.error('[hr] create leave failed:', error);
      return fail(res, 500, 'Could not record the leave');
    }
  },

  // PATCH /staff/leave/:id   { status: approved|rejected, note, unpaid }
  decideLeave: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Request not found');
      const { status, note, unpaid } = req.body || {};
      if (!['approved', 'rejected', 'pending'].includes(status)) return fail(res, 400, 'status must be approved, rejected or pending');
      const leave = await LeaveRequest.findById(req.params.id);
      if (!leave) return fail(res, 404, 'Request not found');
      leave.status = status;
      leave.decisionNote = String(note || '').trim().slice(0, 300);
      if (unpaid !== undefined) leave.unpaid = unpaid === true || unpaid === 'true';
      leave.decidedBy = status === 'pending' ? null : actorId(req);
      leave.decidedByName = status === 'pending' ? '' : await actorName(req);
      leave.decidedAt = status === 'pending' ? null : new Date();
      await leave.save();
      return res.json({ success: true, message: `Leave ${status}.`, data: leaveView(leave) });
    } catch (error) {
      console.error('[hr] decide leave failed:', error);
      return fail(res, 500, 'Could not update the request');
    }
  },

  // GET /staff/payslips?from=&to=&staffId=&status=
  listPayslips: async (req, res) => {
    try {
      const filter = {};
      if (isId(req.query.staffId)) filter.staffId = req.query.staffId;
      if (['draft', 'issued', 'paid', 'void'].includes(req.query.status)) filter.status = req.query.status;
      if (DATE_KEY.test(String(req.query.from || ''))) filter['period.from'] = { $gte: req.query.from };
      if (DATE_KEY.test(String(req.query.to || ''))) filter['period.to'] = { $lte: req.query.to };
      const rows = await Payslip.find(filter).sort({ 'period.from': -1, staffName: 1 }).limit(500).lean();
      return res.json({ success: true, data: rows.map(payslipView) });
    } catch (error) {
      console.error('[hr] list payslips failed:', error);
      return fail(res, 500, 'Could not load payslips');
    }
  },

  // POST /staff/payslips/generate   { from, to }
  generatePayslips: async (req, res) => {
    try {
      const range = L.readRange(req.body || {});
      const result = await payroll.generate(range, { createdBy: actorId(req) });
      return res.json({
        success: true,
        message: `${result.created.length} drafted, ${result.refreshed.length} refreshed, ${result.kept.length} already issued for ${L.rangeLabel(range.from, range.to)}.`,
        data: [...result.created, ...result.refreshed, ...result.kept].map(payslipView)
      });
    } catch (error) {
      console.error('[hr] generate payslips failed:', error);
      return fail(res, 500, 'Could not draft payslips');
    }
  },

  // PUT /staff/payslips/:id   { earnings, deductions, notes, base }
  updatePayslip: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Payslip not found');
      const slip = await Payslip.findById(req.params.id);
      if (!slip) return fail(res, 404, 'Payslip not found');
      if (slip.status === 'paid' || slip.status === 'void') return fail(res, 409, `A ${slip.status} payslip cannot be changed`);
      const body = req.body || {};
      const earnings = readLines(body.earnings);
      const deductions = readLines(body.deductions);
      if (earnings) slip.earnings = earnings;
      if (deductions) slip.deductions = deductions;
      if (body.base !== undefined) slip.base = Math.round((Number(body.base) || 0) * 100) / 100;
      if (body.ptCommission !== undefined) slip.ptCommission = Math.round((Number(body.ptCommission) || 0) * 100) / 100;
      if (body.notes !== undefined) slip.notes = String(body.notes).trim().slice(0, 1000);
      slip.recalculate();
      await slip.save();
      return res.json({ success: true, message: 'Payslip saved.', data: payslipView(slip) });
    } catch (error) {
      console.error('[hr] update payslip failed:', error);
      return fail(res, 500, 'Could not save the payslip');
    }
  },

  // POST /staff/payslips/:id/issue | pay | void
  setPayslipStatus: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Payslip not found');
      const action = req.params.action;
      const slip = await Payslip.findById(req.params.id);
      if (!slip) return fail(res, 404, 'Payslip not found');
      const body = req.body || {};

      if (action === 'issue') {
        if (slip.status !== 'draft') return fail(res, 409, `This payslip is ${slip.status}`);
        slip.status = 'issued';
        slip.issuedAt = new Date();
      } else if (action === 'pay') {
        if (!['draft', 'issued'].includes(slip.status)) return fail(res, 409, `This payslip is ${slip.status}`);
        slip.status = 'paid';
        slip.issuedAt = slip.issuedAt || new Date();
        slip.paidOn = body.paidOn ? new Date(body.paidOn) : new Date();
        slip.paymentMethod = ['cash', 'bank_transfer', 'card', 'cheque', 'online', 'other'].includes(body.paymentMethod) ? body.paymentMethod : 'bank_transfer';
        slip.reference = String(body.reference || '').trim().slice(0, 120);
        // Paying files the wage so the accounts overview has it.
        if (!slip.expenseId) {
          const expense = await Expense.create({
            reference: await nextExpenseReference(slip.paidOn),
            title: `Salary — ${slip.staffName} (${slip.period.label || slip.period.from})`,
            category: 'salaries',
            amount: slip.net,
            currency: slip.currency,
            incurredOn: slip.paidOn,
            status: 'paid',
            paidOn: slip.paidOn,
            paymentMethod: slip.paymentMethod,
            vendor: slip.staffName,
            staffId: slip.staffId,
            staffName: slip.staffName,
            notes: `Payslip ${slip.number}${slip.reference ? ` · ref ${slip.reference}` : ''}`,
            createdBy: actorId(req),
            createdByName: await actorName(req)
          });
          slip.expenseId = expense._id;
        }
      } else if (action === 'void') {
        if (slip.status === 'paid') return fail(res, 409, 'A paid payslip cannot be voided');
        slip.status = 'void';
      } else {
        return fail(res, 400, 'action must be issue, pay or void');
      }
      await slip.save();
      return res.json({ success: true, message: `Payslip ${slip.status}.`, data: payslipView(slip) });
    } catch (error) {
      console.error('[hr] payslip status failed:', error);
      return fail(res, 500, 'Could not update the payslip');
    }
  },

  // GET /staff/payslips/:id/pdf
  payslipPdf: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Payslip not found');
      const slip = await Payslip.findById(req.params.id);
      if (!slip) return fail(res, 404, 'Payslip not found');
      const pdf = await payroll.renderPayslipPdf(slip);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${slip.number}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      console.error('[hr] payslip pdf failed:', error);
      return fail(res, 500, 'Could not render the payslip');
    }
  },

  // GET /staff/roster?from=&to=   -> shifts per day with leave laid over
  roster: async (req, res) => {
    try {
      const today = T.dateKey();
      const from = DATE_KEY.test(String(req.query.from || '')) ? String(req.query.from) : today;
      const to = DATE_KEY.test(String(req.query.to || '')) ? String(req.query.to) : T.shiftDateKey(from, 6);
      const [staff, leave] = await Promise.all([
        User.find({ 'employment.isStaff': true, isActive: true }).select('firstName lastName email employment.jobTitle employment.schedule').lean(),
        LeaveRequest.find({ status: 'approved', from: { $lte: to }, to: { $gte: from } }).lean()
      ]);
      const days = [];
      let cursor = from;
      while (cursor <= to && days.length < 62) {
        const weekday = T.weekdayNameForKey(cursor);
        const day = { date: cursor, weekday, shifts: [], off: [] };
        for (const person of staff) {
          const name = [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email;
          const onLeave = leave.find((l) => String(l.staffId) === String(person._id) && l.from <= cursor && l.to >= cursor);
          const shifts = ((person.employment && person.employment.schedule) || []).filter((s) => s.day === weekday && s.startTime);
          if (onLeave) day.off.push({ staff_id: String(person._id), name, type: onLeave.type });
          else for (const s of shifts) day.shifts.push({ staff_id: String(person._id), name, job_title: (person.employment && person.employment.jobTitle) || '', start_time: s.startTime, end_time: s.endTime });
        }
        day.shifts.sort((a, b) => a.start_time.localeCompare(b.start_time));
        days.push(day);
        cursor = T.shiftDateKey(cursor, 1);
      }
      return res.json({ success: true, range: { from, to }, data: days });
    } catch (error) {
      console.error('[hr] roster failed:', error);
      return fail(res, 500, 'Could not load the roster');
    }
  }
};
