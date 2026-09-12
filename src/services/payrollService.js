// src/services/payrollService.js
//
// Turning the staff records, attendance and completed PT sessions into
// payslips for a period, and rendering one as a PDF.
//
// The arithmetic mirrors accounts/controller/accountsController.payrollFor
// -- salaried people cost their salary pro-rated to the period, hourly
// people cost the hours attendance recorded -- so a payslip and the accounts
// overview never disagree about what a month of wages is. On top of that a
// payslip carries what the overview does not: PT commission, unpaid leave,
// and the extra lines a manager types in.

const PDFDocument = require('pdfkit');
const User = require('../models/user');
const Trainer = require('../gymfolio/models/trainerModel');
const Attendance = require('../attendance/models/attendanceModel');
const PtSession = require('../gymfolio/models/ptSessionModel');
const LeaveRequest = require('../models/leaveRequestModel');
const Payslip = require('../models/payslipModel');
const Counter = require('../gymfolio/models/counterModel');
const Settings = require('../models/settings');
const L = require('../accounts/services/ledger');
const T = require('../attendance/services/timeUtils');

const CYCLE_DAYS = { weekly: 7, biweekly: 14, monthly: 30.44 };

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Inclusive days between two date keys, clipped to a period. */
function daysInside(from, to, periodFrom, periodTo) {
  const start = from > periodFrom ? from : periodFrom;
  const end = to < periodTo ? to : periodTo;
  if (start > end) return 0;
  let n = 0;
  let cursor = start;
  while (cursor <= end) {
    n += 1;
    cursor = T.shiftDateKey(cursor, 1);
  }
  return n;
}

/**
 * Drafts one person's payslip for a range. Returns the unsaved document
 * (or the existing one when it is past draft).
 */
async function draftFor(person, range, { createdBy = null } = {}) {
  const existing = await Payslip.findOne({ staffId: person._id, 'period.from': range.from, 'period.to': range.to, status: { $ne: 'void' } });
  if (existing && existing.status !== 'draft') return existing;

  const payroll = (person.employment && person.employment.payroll) || {};
  const basis = payroll.basis || 'salaried';
  const currency = String(payroll.currency || 'PKR').toUpperCase();
  const days = Math.max(1, Math.round((range.end - range.start) / L.DAY_MS));

  // Hours: punches filed against the staff account and against a trainer
  // profile linked to it.
  const trainer = await Trainer.findOne({ userId: person._id }).select('_id commissionPercent').lean();
  const punchIds = [person._id, ...(trainer ? [trainer._id] : [])];
  const worked = await Attendance.aggregate([
    { $match: { personType: 'staff', personId: { $in: punchIds }, checkInAt: { $gte: range.start, $lt: range.end }, workedMinutes: { $ne: null } } },
    { $group: { _id: null, minutes: { $sum: '$workedMinutes' } } }
  ]);
  const hours = round(((worked[0] && worked[0].minutes) || 0) / 60);

  let base = 0;
  let rate = 0;
  if (basis === 'hourly') {
    rate = Number(payroll.hourlyRate) || 0;
    base = round(hours * rate);
  } else {
    rate = Number(payroll.salary) || 0;
    base = round((rate / (CYCLE_DAYS[payroll.cycle] || 30.44)) * days);
  }

  // Unpaid leave comes off a salary; hourly people simply have no hours.
  let unpaidLeaveDays = 0;
  let unpaidLeaveDeduction = 0;
  if (basis === 'salaried') {
    const leaves = await LeaveRequest.find({ staffId: person._id, status: 'approved', unpaid: true, from: { $lte: range.to }, to: { $gte: range.from } }).lean();
    for (const leave of leaves) unpaidLeaveDays += daysInside(leave.from, leave.to, range.from, range.to);
    unpaidLeaveDeduction = round((rate / (CYCLE_DAYS[payroll.cycle] || 30.44)) * unpaidLeaveDays);
  }

  // PT commission from the sessions marked completed in the period.
  let ptSessions = 0;
  let ptCommission = 0;
  if (trainer) {
    const rows = await PtSession.aggregate([
      { $match: { trainerId: trainer._id, status: 'completed', date: { $gte: range.from, $lte: range.to } } },
      { $group: { _id: null, n: { $sum: 1 }, commission: { $sum: '$commission.amount' } } }
    ]);
    ptSessions = (rows[0] && rows[0].n) || 0;
    ptCommission = round((rows[0] && rows[0].commission) || 0);
  }

  const doc = existing || new Payslip({
    number: '',
    staffId: person._id,
    staffName: [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || person.email,
    jobTitle: (person.employment && person.employment.jobTitle) || '',
    period: { from: range.from, to: range.to, label: L.rangeLabel(range.from, range.to) },
    createdBy
  });
  doc.currency = currency;
  doc.basis = basis;
  doc.base = base;
  doc.hours = hours;
  doc.rate = rate;
  doc.unpaidLeaveDays = unpaidLeaveDays;
  doc.unpaidLeaveDeduction = unpaidLeaveDeduction;
  doc.ptSessions = ptSessions;
  doc.ptCommission = ptCommission;
  doc.recalculate();
  return doc;
}

/** Drafts (or refreshes drafts) for every active staff member. */
async function generate(range, { createdBy = null } = {}) {
  // `employment.payroll` is `select: false` on the model, but an inclusive
  // select of the whole `employment` block still returns it (the exclusion
  // only applies to default and exclusive projections), which is what the
  // pay calculation below relies on. Do not add `+employment.payroll` here:
  // naming both the parent and the child is a projection path collision.
  const staff = await User.find({ 'employment.isStaff': true, isActive: true }).select('firstName lastName email employment').lean();
  const year = range.to.slice(0, 4);
  const created = [];
  const refreshed = [];
  const kept = [];
  for (const person of staff) {
    const doc = await draftFor(person, range, { createdBy });
    if (doc.status !== 'draft') {
      kept.push(doc);
      continue;
    }
    const isNew = !doc.number;
    if (isNew) {
      const seq = await Counter.next(`payslip-${year}`);
      doc.number = `PAY-${year}-${String(seq).padStart(4, '0')}`;
    }
    await doc.save();
    (isNew ? created : refreshed).push(doc);
  }
  return { created, refreshed, kept };
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'USD' }).format(Number(amount) || 0);
  } catch {
    return `${currency} ${round(amount).toFixed(2)}`;
  }
}

/** A payslip as a PDF buffer. */
async function renderPayslipPdf(payslip) {
  const settings = (await Settings.getSettings().catch(() => null)) || {};
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Payslip ${payslip.number}` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const dark = '#18181b';
  const muted = '#71717a';
  const line = '#e4e4e7';
  const left = 50;
  const right = 545;
  const c = payslip.currency;

  doc.fillColor(dark).fontSize(20).font('Helvetica-Bold').text(settings.siteName || 'Payslip', left, 50);
  doc.fontSize(9).font('Helvetica').fillColor(muted);
  [settings.address, settings.mobileNumber].filter(Boolean).forEach((text, i) => doc.text(text, left, 76 + i * 12));
  doc.fillColor(dark).fontSize(22).font('Helvetica-Bold').text('PAYSLIP', 350, 50, { width: 195, align: 'right' });
  doc.fontSize(9).font('Helvetica').fillColor(muted);
  doc.text(`No. ${payslip.number}`, 350, 80, { width: 195, align: 'right' });
  doc.text(`Period ${payslip.period.label || `${payslip.period.from} – ${payslip.period.to}`}`, 350, 92, { width: 195, align: 'right' });
  doc.text(`Status ${payslip.status}${payslip.paidOn ? ` · paid ${T.dateLabel(payslip.paidOn)}` : ''}`, 350, 104, { width: 195, align: 'right' });

  let y = 140;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(line).stroke();
  y += 14;
  doc.fillColor(muted).fontSize(8).font('Helvetica-Bold').text('EMPLOYEE', left, y);
  doc.fillColor(dark).fontSize(11).font('Helvetica').text(payslip.staffName, left, y + 12);
  if (payslip.jobTitle) doc.fillColor(muted).fontSize(9).text(payslip.jobTitle, left, y + 27);

  y += 60;
  const row = (label, value, bold = false) => {
    doc.fillColor(dark).fontSize(10).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, left, y, { width: 330 });
    doc.text(value, 400, y, { width: 145, align: 'right' });
    y += 18;
  };
  doc.fillColor(muted).fontSize(8).font('Helvetica-Bold').text('EARNINGS', left, y);
  y += 14;
  row(payslip.basis === 'hourly' ? `Hours worked: ${payslip.hours} h × ${money(payslip.rate, c)}` : `Salary (pro-rated, ${payslip.rate ? money(payslip.rate, c) : '—'} per cycle)`, money(payslip.base, c));
  if (payslip.ptCommission) row(`Personal training commission (${payslip.ptSessions} session${payslip.ptSessions === 1 ? '' : 's'})`, money(payslip.ptCommission, c));
  for (const l of payslip.earnings || []) row(l.label, money(l.amount, c));
  row('Gross', money(payslip.gross, c), true);

  const hasDeductions = payslip.unpaidLeaveDeduction || (payslip.deductions || []).length;
  if (hasDeductions) {
    y += 8;
    doc.fillColor(muted).fontSize(8).font('Helvetica-Bold').text('DEDUCTIONS', left, y);
    y += 14;
    if (payslip.unpaidLeaveDeduction) row(`Unpaid leave (${payslip.unpaidLeaveDays} day${payslip.unpaidLeaveDays === 1 ? '' : 's'})`, `-${money(payslip.unpaidLeaveDeduction, c)}`);
    for (const l of payslip.deductions || []) row(l.label, `-${money(l.amount, c)}`);
  }

  y += 6;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(line).stroke();
  y += 10;
  row('NET PAY', money(payslip.net, c), true);
  if (payslip.notes) {
    y += 10;
    doc.fillColor(muted).fontSize(9).font('Helvetica').text(payslip.notes, left, y, { width: right - left });
  }
  doc.end();
  return done;
}

module.exports = { draftFor, generate, renderPayslipPdf, daysInside };
