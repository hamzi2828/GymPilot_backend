// src/gymfolio/services/classSessions.js
//
// Turns a class's weekly template into the dated sessions a member can
// actually book, and answers the questions the booking endpoints ask about
// them: does this slot exist, is it in the past, how many places are left.
//
// A GymClass carries `schedule: [{day, startTime, endTime, instructor}]` --
// "Tuesdays and Thursdays at 18:00". Nothing stores "Tuesday 3rd March at
// 18:00". This module expands the rule over a date range on demand, which is
// what lets a timetable be edited without migrating a table of pre-generated
// sessions.
//
// One-off changes to a particular week -- a cancelled session, a closed day,
// a stand-in instructor, a room change -- are ClassException rows and are
// laid over the expanded sessions here, so every reader sees the same week.
//
// How far ahead members may book and how close to the start booking closes
// come from the gym's booking rules (services/bookingRules.js).

const mongoose = require('mongoose');
const GymClass = require('../models/gymClassModel');
const ClassBooking = require('../models/classBookingModel');
const ClassException = require('../models/classExceptionModel');
const { bookingRules, DEFAULTS } = require('./bookingRules');
const T = require('../../attendance/services/timeUtils');

// The defaults, kept under their old names for the callers that report them.
const BOOKING_HORIZON_DAYS = DEFAULTS.horizonDays;
const CUTOFF_MINUTES = DEFAULTS.cutoffMinutes;

/** The gym's booking rules -- cached briefly per gym. */
async function rules() {
  return bookingRules();
}

/**
 * Every date within [from, to] falling on the given weekday.
 * Dates are 'YYYY-MM-DD' keys in the gym's timezone throughout.
 */
function datesForWeekday(from, to, weekday) {
  const dates = [];
  let cursor = from;
  // Bounded by the range itself; the caller clamps the range to the horizon.
  while (cursor <= to) {
    if (T.weekdayNameForKey(cursor) === weekday) dates.push(cursor);
    cursor = T.shiftDateKey(cursor, 1);
  }
  return dates;
}

/**
 * The UTC instant a local 'YYYY-MM-DD' + 'HH:MM' represents.
 *
 * Same trick the accounts ledger uses: read the wall-clock time as if it were
 * UTC, then correct by however far the gym's clock actually reads from that.
 * Gets DST right without hardcoding an offset.
 */
function localInstant(dateKey, clock) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = String(clock || '00:00').split(':').map(Number);

  const guess = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0, 0));
  const parts = T.localParts(guess);

  let drift = parts.hour * 60 + parts.minute - ((hh || 0) * 60 + (mm || 0));
  if (drift > 720) drift -= 1440;
  if (drift < -720) drift += 1440;

  return new Date(guess.getTime() - drift * 60000);
}

/** Has this session already started (or come within the cutoff)? */
function isClosed(sessionDate, sessionStart, now = new Date(), policy = null) {
  const cutoff = policy ? policy.cutoffMinutes : CUTOFF_MINUTES;
  const startsAt = localInstant(sessionDate, sessionStart);
  return startsAt.getTime() - cutoff * 60000 <= now.getTime();
}

/** The exceptions touching a date range, oldest first. */
async function exceptionsFor(from, to) {
  return ClassException.find({ date: { $gte: from, $lte: to } }).lean();
}

/** The exception that applies to one session, if any. Cancellations win. */
function exceptionFor(exceptions, classId, date, startTime) {
  if (!exceptions || !exceptions.length) return null;
  const hits = exceptions.filter((e) => ClassException.applies(e, classId, date, startTime));
  if (!hits.length) return null;
  return hits.find((e) => e.kind === 'cancelled') || hits[hits.length - 1];
}

/**
 * Expands one class's template across a date range, with any exceptions
 * for those dates laid over it.
 *
 * Returns sessions with no booking counts attached -- withCounts() adds those
 * in one query rather than one per session.
 */
function expand(gymClass, from, to, exceptions = []) {
  const schedule = Array.isArray(gymClass.schedule) ? gymClass.schedule : [];
  const sessions = [];

  for (const slot of schedule) {
    if (!slot || !slot.day || !slot.startTime) continue;

    for (const date of datesForWeekday(from, to, slot.day)) {
      const exception = exceptionFor(exceptions, gymClass._id, date, slot.startTime);
      const cancelled = !!(exception && exception.kind === 'cancelled');
      const substitute = !!(exception && exception.kind === 'substitute');
      sessions.push({
        class_id: String(gymClass._id),
        class_name: gymClass.name,
        class_slug: gymClass.slug || '',
        date,
        weekday: slot.day,
        start_time: slot.startTime,
        end_time: slot.endTime || '',
        instructor_name:
          (substitute && exception.instructorName) ||
          slot.instructorName ||
          (slot.instructor && slot.instructor.name) ||
          '',
        room: (substitute && exception.room) || gymClass.room || '',
        capacity: Number(gymClass.capacity) || 0,
        duration_minutes: Number(gymClass.duration) || null,
        difficulty: gymClass.difficulty || '',
        starts_at: localInstant(date, slot.startTime),
        is_cancelled: cancelled,
        is_substitute: substitute,
        change_note: exception ? exception.note || '' : ''
      });
    }
  }

  return sessions.sort(
    (a, b) => a.starts_at - b.starts_at || a.class_name.localeCompare(b.class_name)
  );
}

/**
 * Attaches booked/waitlisted counts and the derived availability fields.
 *
 * One aggregate for the whole set, because the alternative -- counting per
 * session -- is a query per row on a page that lists a month of classes.
 *
 * @param {string|null} forUserId when given, each session also says whether
 *        this member already holds a place on it
 */
async function withCounts(sessions, forUserId = null, policy = null) {
  if (!sessions.length) return [];
  const rulesNow = policy || (await rules());

  const classIds = [...new Set(sessions.map((s) => s.class_id))];
  const dates = [...new Set(sessions.map((s) => s.date))];

  const rows = await ClassBooking.aggregate([
    {
      $match: {
        classId: { $in: classIds.map((id) => new mongoose.Types.ObjectId(id)) },
        sessionDate: { $in: dates },
        status: { $in: ['booked', 'waitlisted', 'attended'] }
      }
    },
    {
      $group: {
        _id: {
          classId: '$classId',
          date: '$sessionDate',
          start: '$sessionStart',
          status: '$status'
        },
        n: { $sum: 1 }
      }
    }
  ]);

  const key = (classId, date, start) => `${classId}|${date}|${start}`;
  const counts = new Map();
  for (const row of rows) {
    const k = key(String(row._id.classId), row._id.date, row._id.start);
    const entry = counts.get(k) || { booked: 0, waitlisted: 0 };
    // 'attended' still occupies the place it was booked into.
    if (row._id.status === 'waitlisted') entry.waitlisted += row.n;
    else entry.booked += row.n;
    counts.set(k, entry);
  }

  // The member's own bookings across the same window, so the UI can show
  // "Booked" instead of offering a place they already hold.
  const mine = new Map();
  if (forUserId) {
    const own = await ClassBooking.find({
      userId: forUserId,
      sessionDate: { $in: dates },
      status: { $in: ['booked', 'waitlisted'] }
    })
      .select('classId sessionDate sessionStart status waitlistPosition')
      .lean();

    for (const b of own) {
      mine.set(key(String(b.classId), b.sessionDate, b.sessionStart), b);
    }
  }

  const now = new Date();

  return sessions.map((session) => {
    const k = key(session.class_id, session.date, session.start_time);
    const count = counts.get(k) || { booked: 0, waitlisted: 0 };
    const own = mine.get(k) || null;
    const capacity = session.capacity;
    const spotsLeft = Math.max(0, capacity - count.booked);
    const closed = isClosed(session.date, session.start_time, now, rulesNow);

    return {
      ...session,
      starts_at: session.starts_at.toISOString(),
      booked_count: count.booked,
      waitlist_count: count.waitlisted,
      spots_left: spotsLeft,
      is_full: capacity > 0 && spotsLeft === 0,
      // Past, or inside the cutoff. The UI greys these rather than hiding
      // them, so a timetable still reads as a timetable earlier in the day.
      is_closed: closed,
      can_book: !closed && !own && !session.is_cancelled,
      my_booking: own
        ? {
            id: String(own._id),
            status: own.status,
            waitlist_position: own.waitlistPosition
          }
        : null
    };
  });
}

/**
 * Clamps a requested range to something sane, defaulting to the booking
 * horizon starting today.
 */
function readRange(query = {}, policy = null) {
  const horizon = policy ? policy.horizonDays : BOOKING_HORIZON_DAYS;
  const today = T.dateKey();
  const maxTo = T.shiftDateKey(today, horizon);

  let from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? String(query.from) : today;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? String(query.to) : maxTo;

  if (from > to) [from, to] = [to, from];

  // Admins looking at a roster legitimately want past dates; members booking
  // do not. The caller decides by passing allowPast.
  if (!query.allowPast && from < today) from = today;
  if (to > maxTo && !query.allowPast) to = maxTo;

  return { from, to, today };
}

/**
 * Finds one slot in a class's template. Returns null when the class does not
 * run at that time on that weekday -- which is how a booking request for a
 * made-up session is refused.
 */
function findSlot(gymClass, sessionDate, sessionStart) {
  const weekday = T.weekdayNameForKey(sessionDate);
  const schedule = Array.isArray(gymClass.schedule) ? gymClass.schedule : [];
  return (
    schedule.find(
      (slot) => slot && slot.day === weekday && slot.startTime === sessionStart
    ) || null
  );
}

/** Sessions for one class over a range, counts included. */
async function sessionsForClass(gymClass, query = {}, forUserId = null) {
  const policy = await rules();
  const range = readRange(query, policy);
  const exceptions = await exceptionsFor(range.from, range.to);
  return withCounts(expand(gymClass, range.from, range.to, exceptions), forUserId, policy);
}

/** Sessions across every active class -- the public timetable. */
async function timetable(query = {}, forUserId = null) {
  const policy = await rules();
  const range = readRange(query, policy);

  const filter = { isActive: true };
  // A malformed id (a hand-edited ?class= link) filters to nothing rather
  // than failing the cast and answering 500.
  if (query.classId) filter._id = mongoose.Types.ObjectId.isValid(String(query.classId)) ? query.classId : null;
  if (query.category) filter.category = query.category;

  const [classes, exceptions] = await Promise.all([
    GymClass.find(filter)
      .select('name slug schedule capacity duration difficulty category room')
      .populate('schedule.instructor', 'name')
      .lean(),
    exceptionsFor(range.from, range.to)
  ]);

  const all = classes.flatMap((gymClass) => expand(gymClass, range.from, range.to, exceptions));
  const sessions = await withCounts(all, forUserId, policy);

  return { range, sessions, rules: policy };
}

module.exports = {
  BOOKING_HORIZON_DAYS,
  CUTOFF_MINUTES,
  rules,
  localInstant,
  isClosed,
  exceptionsFor,
  exceptionFor,
  expand,
  withCounts,
  readRange,
  findSlot,
  sessionsForClass,
  timetable
};
