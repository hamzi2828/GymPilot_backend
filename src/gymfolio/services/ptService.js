// src/gymfolio/services/ptService.js
//
// Personal training: which slots a trainer has free, booking one, and what
// happens to the member's pack and the trainer's commission around it.
//
// A trainer's free time is their `availability` (weekday windows) cut into
// slots of the gym's chosen length, minus the appointments already made and
// the classes they teach. Nothing is pre-generated; it is computed for the
// range asked about, like class sessions are.

const mongoose = require('mongoose');
const Trainer = require('../models/trainerModel');
const GymClass = require('../models/gymClassModel');
const PtSession = require('../models/ptSessionModel');
const PackageOrder = require('../models/packageOrderModel');
const User = require('../../models/user');
const { ptRules } = require('./bookingRules');
const { localInstant, expand } = require('./classSessions');
const { consumeSession, refundSession } = require('./membershipService');
const { ensureMemberCode } = require('../../attendance/services/peopleDirectory');
const T = require('../../attendance/services/timeUtils');

class PtError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

function minutes(clock) {
  const [h, m] = String(clock || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function clock(total) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** Every date key from `from` to `to`, inclusive. */
function dateKeys(from, to) {
  const keys = [];
  let cursor = from;
  while (cursor <= to) {
    keys.push(cursor);
    cursor = T.shiftDateKey(cursor, 1);
  }
  return keys;
}

/**
 * The member's live PT pack, if they have one with credits left. Packs are
 * packages of kind pt_pack; an older pack without a kind counts when its
 * name says so.
 */
async function ptPackFor(memberId) {
  const now = new Date();
  const orders = await PackageOrder.find({
    userId: memberId,
    'payment.status': 'paid',
    status: { $in: ['active', 'past_due'] },
    'sessions.total': { $gt: 0 },
    'subscription.endDate': { $gte: now }
  })
    .sort({ 'subscription.endDate': 1 })
    .limit(10);
  return (
    orders.find((o) => {
      const kind = o.packageDetails && o.packageDetails.kind;
      const isPt = kind ? kind === 'pt_pack' : /\b(pt|personal)\b/i.test((o.packageDetails && o.packageDetails.name) || '');
      return isPt && (o.sessions.used || 0) < o.sessions.total;
    }) || null
  );
}

function perSessionValue(order) {
  const total = Number(order.sessions && order.sessions.total) || 0;
  const paid = Number(order.payment && order.payment.amount) || 0;
  return total > 0 ? Math.round((paid / total) * 100) / 100 : 0;
}

/**
 * Free slots for one trainer across a date range.
 * Returns [{ date, start_time, end_time, available, reason }].
 */
async function availability(trainer, from, to, { includeTaken = false } = {}) {
  const rules = await ptRules();
  const today = T.dateKey();
  const maxTo = T.shiftDateKey(today, rules.horizonDays);
  const start = from && from > today ? from : today;
  const end = to && to < maxTo ? to : maxTo;
  if (start > end) return [];

  const windows = Array.isArray(trainer.availability) ? trainer.availability.filter((w) => w && w.day && w.startTime && w.endTime) : [];
  if (!windows.length) return [];

  const [taken, classes] = await Promise.all([
    PtSession.find({ trainerId: trainer._id, date: { $gte: start, $lte: end }, status: { $in: ['scheduled', 'completed'] } })
      .select('date startTime endTime')
      .lean(),
    GymClass.find({ isActive: true, 'schedule.instructor': trainer._id }).select('name schedule').lean()
  ]);
  const takenByDate = new Map();
  for (const s of taken) {
    if (!takenByDate.has(s.date)) takenByDate.set(s.date, []);
    takenByDate.get(s.date).push([minutes(s.startTime), minutes(s.endTime || clock(minutes(s.startTime) + rules.slotMinutes))]);
  }
  // Classes this trainer teaches, so a slot never sits on top of one.
  for (const gymClass of classes) {
    const own = { ...gymClass, schedule: (gymClass.schedule || []).filter((slot) => slot.instructor && String(slot.instructor) === String(trainer._id)) };
    for (const session of expand(own, start, end)) {
      if (!takenByDate.has(session.date)) takenByDate.set(session.date, []);
      takenByDate.get(session.date).push([minutes(session.start_time), minutes(session.end_time || clock(minutes(session.start_time) + 60))]);
    }
  }

  const now = new Date();
  const slots = [];
  for (const date of dateKeys(start, end)) {
    const weekday = T.weekdayNameForKey(date);
    for (const w of windows.filter((x) => x.day === weekday)) {
      let cursor = minutes(w.startTime);
      const close = minutes(w.endTime);
      while (cursor + rules.slotMinutes <= close) {
        const slotStart = cursor;
        const slotEnd = cursor + rules.slotMinutes;
        const busy = (takenByDate.get(date) || []).some(([s, e]) => overlaps(slotStart, slotEnd, s, e));
        const past = localInstant(date, clock(slotStart)).getTime() <= now.getTime();
        if (!busy && !past) slots.push({ date, start_time: clock(slotStart), end_time: clock(slotEnd), available: true });
        else if (includeTaken) slots.push({ date, start_time: clock(slotStart), end_time: clock(slotEnd), available: false, reason: past ? 'past' : 'taken' });
        cursor += rules.slotMinutes;
      }
    }
  }
  return slots;
}

/** Books one slot. Throws PtError with a status when it cannot. */
async function book({ trainerId, memberId, date, startTime, by, bookedBy = 'member', notes = '' }) {
  if (!isId(trainerId)) throw new PtError('A valid trainer is required');
  if (!isId(memberId)) throw new PtError('A valid member is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new PtError('date must be YYYY-MM-DD');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime || ''))) throw new PtError('startTime must be HH:MM');

  const [trainer, member, rules] = await Promise.all([Trainer.findById(trainerId), User.findById(memberId), ptRules()]);
  if (!trainer || !trainer.isActive) throw new PtError('Trainer not found', 404);
  if (trainer.acceptsPt === false) throw new PtError(`${trainer.name} is not taking personal training bookings`, 409);
  if (!member || member.isActive === false) throw new PtError('Member not found', 404);

  const slots = await availability(trainer, date, date);
  const slot = slots.find((s) => s.date === date && s.start_time === startTime);
  if (!slot) throw new PtError(`${trainer.name} is not free at ${startTime} on ${T.dateLabelForKey(date)}`, 409);

  // Credits: a live PT pack pays for the session; otherwise the trainer's
  // rate is recorded for the desk to collect, unless the gym insists on a pack.
  const pack = await ptPackFor(member._id);
  if (!pack && rules.requirePack) throw new PtError('A personal training pack with sessions left is needed to book. Please buy one first.', 402);

  let price = Number(trainer.ptRate) || 0;
  let currency = (pack && pack.payment && pack.payment.currency) || '';
  if (pack) {
    await consumeSession(pack, { by, note: `PT with ${trainer.name} on ${date} ${startTime}` });
    price = perSessionValue(pack);
  }

  try {
    return await PtSession.create({
      trainerId: trainer._id,
      trainerName: trainer.name,
      memberId: member._id,
      memberName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
      memberCode: await ensureMemberCode(member).catch(() => ''),
      date,
      startTime,
      endTime: slot.end_time,
      durationMinutes: rules.slotMinutes,
      orderId: pack ? pack._id : null,
      creditUsed: !!pack,
      price,
      currency: currency.toUpperCase(),
      notes: String(notes || '').trim(),
      bookedBy,
      bookedByUserId: by || null
    });
  } catch (error) {
    // The slot was taken between the check and the write: give the credit back.
    if (pack) await refundSession(pack).catch(() => {});
    if (error && error.code === 11000) throw new PtError('That slot has just been taken', 409);
    throw error;
  }
}

async function cancel(session, { by, reason = '', byStaff = false }) {
  if (session.status !== 'scheduled') throw new PtError(`This session is already ${session.status.replace('_', ' ')}`, 409);
  const rules = await ptRules();
  const startsAt = localInstant(session.date, session.startTime);
  const late = startsAt.getTime() - rules.cancelHours * 3600 * 1000 < Date.now();

  session.status = 'cancelled';
  session.cancelledAt = new Date();
  session.cancelledBy = by || null;
  session.cancelReason = String(reason || '').trim();
  // Staff cancelling never costs the member a credit; a member cancelling
  // late does.
  session.lateCancel = late && !byStaff;
  if (session.creditUsed && session.orderId && !session.lateCancel) {
    const order = await PackageOrder.findById(session.orderId);
    if (order) await refundSession(order).catch(() => {});
  }
  await session.save();
  return session;
}

const isSet = (value) => value !== null && value !== undefined && value !== '';

/**
 * What a trainer earns per completed session: `{ basis: 'percent', value }`
 * of what the session was worth, or `{ basis: 'amount', value }` flat. The
 * trainer's own terms (commissionType / commissionValue), else a percent set
 * before those existed (commissionPercent), else the gym's default percent.
 */
function commissionTerms(trainer, defaultPercent = 0) {
  if (trainer && ['percent', 'amount'].includes(trainer.commissionType) && isSet(trainer.commissionValue)) {
    return { basis: trainer.commissionType, value: Number(trainer.commissionValue) || 0 };
  }
  if (trainer && isSet(trainer.commissionPercent)) return { basis: 'percent', value: Number(trainer.commissionPercent) || 0 };
  return { basis: 'percent', value: Number(defaultPercent) || 0 };
}

/** One session's commission under those terms: { basis, percent, amount }. */
function commissionFor(price, terms) {
  if (terms.basis === 'amount') return { basis: 'amount', percent: 0, amount: Math.round(terms.value * 100) / 100 };
  return { basis: 'percent', percent: terms.value, amount: Math.round((Number(price) || 0) * terms.value) / 100 };
}

/** Marks the session done and works out the trainer's cut. */
async function complete(session, { by } = {}) {
  if (!['scheduled', 'no_show'].includes(session.status)) throw new PtError(`This session is ${session.status}`, 409);
  const [trainer, rules] = await Promise.all([Trainer.findById(session.trainerId).lean(), ptRules()]);
  session.status = 'completed';
  session.completedAt = new Date();
  // A fixed amount is paid for the session whatever it was worth -- a free
  // taster included; a percent is of the pack's per-session value or the
  // trainer's rate, as before.
  session.commission = commissionFor(session.price, commissionTerms(trainer, rules.defaultCommissionPercent));
  session.markedBy = by || null;
  await session.save();
  return session;
}

async function noShow(session) {
  if (session.status !== 'scheduled') throw new PtError(`This session is ${session.status}`, 409);
  // The credit stays used: the trainer turned up.
  session.status = 'no_show';
  session.commission = { basis: 'percent', percent: 0, amount: 0 };
  await session.save();
  return session;
}

/** Sessions and commission per trainer over a range, for payroll. */
async function summary(from, to) {
  const rows = await PtSession.aggregate([
    { $match: { date: { $gte: from, $lte: to }, status: { $in: ['completed', 'no_show', 'scheduled', 'cancelled'] } } },
    {
      $group: {
        _id: { trainerId: '$trainerId', status: '$status' },
        trainerName: { $first: '$trainerName' },
        n: { $sum: 1 },
        value: { $sum: '$price' },
        commission: { $sum: '$commission.amount' }
      }
    }
  ]);
  const byTrainer = new Map();
  for (const row of rows) {
    const key = String(row._id.trainerId);
    const entry = byTrainer.get(key) || { trainer_id: key, trainer_name: row.trainerName, scheduled: 0, completed: 0, cancelled: 0, no_show: 0, value: 0, commission: 0 };
    entry[row._id.status] += row.n;
    if (row._id.status === 'completed') {
      entry.value += row.value;
      entry.commission += row.commission;
    }
    byTrainer.set(key, entry);
  }

  // Who pays the commission, and on what terms. A trainer linked to a staff
  // account is paid it on their payslip; one with no staff account never gets
  // a payslip, so what they have earned is payable by hand -- and says so,
  // rather than looking as if payroll will take care of it.
  const [trainers, rules] = await Promise.all([
    Trainer.find({ _id: { $in: [...byTrainer.keys()].filter(isId) } })
      .select('userId commissionType commissionValue commissionPercent')
      .lean(),
    ptRules()
  ]);
  const byId = new Map(trainers.map((trainer) => [String(trainer._id), trainer]));
  // Payslips are drafted for active staff accounts only (payrollService).
  const payrolled = new Set(
    (
      await User.find({ _id: { $in: trainers.map((trainer) => trainer.userId).filter(Boolean) }, 'employment.isStaff': true, isActive: true })
        .select('_id')
        .lean()
    ).map((user) => String(user._id))
  );
  for (const entry of byTrainer.values()) {
    const trainer = byId.get(entry.trainer_id) || null;
    entry.value = Math.round(entry.value * 100) / 100;
    entry.commission = Math.round(entry.commission * 100) / 100;
    entry.commission_terms = commissionTerms(trainer, rules.defaultCommissionPercent);
    entry.on_payroll = !!(trainer && trainer.userId && payrolled.has(String(trainer.userId)));
    entry.paid_by = entry.on_payroll ? 'payslip' : 'direct';
  }
  return [...byTrainer.values()].sort((a, b) => a.trainer_name.localeCompare(b.trainer_name));
}

module.exports = { PtError, availability, book, cancel, complete, noShow, summary, ptPackFor, perSessionValue, commissionTerms, commissionFor };
