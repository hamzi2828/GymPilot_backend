// src/attendance/services/staleVisits.js
//
// A visit nobody checked out of. The punch only looks back OPEN_VISIT_HOURS
// for the visit a scan should close, so past that point a visit can never be
// closed by the person it belongs to -- yet it still has checkOutAt: null,
// which every "who is inside right now" question used to read as "still in".
// A member who forgot to scan out on Monday was in the gym for good: the app
// told them so, and the office counted them.
//
// Both halves of the fix live here so they cannot drift apart:
//
//   * every "currently inside" question is bounded by the same window the
//     punch uses (openVisitMatch / openVisitExpr / isOpenVisit), so the answer
//     is right even on a day the job below has not run;
//   * closeStaleVisits(), run daily for each gym, marks those visits
//     autoClosed, so the row itself says what happened.
//
// An auto-closed visit gets no check-out time and no duration. Inventing one
// would put hours nobody recorded into payroll, totals and averages; it is
// shown as "No check-out", which is the truth.
//
// Staff get a shorter window than members, because staff are paid from these
// rows. With one window for everybody, a receptionist who forgot to scan out
// at 22:00 and came back at 09:00 was "checked out" by the morning scan -- and
// paid for a 17-hour shift. A staff visit is open until its rostered shift
// ends plus a grace (staffOpenUntil), stored on the row at check-in as
// `openUntil`, so the next day's scan starts a new visit and yesterday's shows
// as "No check-out" for the office to correct.
//
// A voided visit (see attendanceModel.js) is never open and never a missed
// check-out: it is not a visit at all.

const Attendance = require('../models/attendanceModel');
const T = require('./timeUtils');

const HOUR_MS = 60 * 60 * 1000;

// How far back a check-out may reach to find its own check-in. Longer than a
// working day so a night shift ending at 06:00 still closes the row it opened
// at 22:00, but short enough that a member who forgot to check out on Monday
// is not "checked out" by Tuesday morning's arrival. Also the point after
// which a visit stops counting as "still inside" -- and the longest any
// visit, staff included, is ever open.
const OPEN_VISIT_HOURS = Number(process.env.ATTENDANCE_OPEN_VISIT_HOURS || 18);

// How long past the rostered end a staff visit stays open: room for real
// overtime, not for the next morning.
const STAFF_SHIFT_GRACE_HOURS = Number(process.env.ATTENDANCE_STAFF_SHIFT_GRACE_HOURS || 4);

// A staff visit with no roster to go by -- not rostered that day, or arriving
// after the rostered shift had already ended -- stays open this long.
const STAFF_OPEN_HOURS = Number(process.env.ATTENDANCE_STAFF_OPEN_HOURS || 14);

function openVisitCutoff(now = new Date()) {
  return new Date(now.getTime() - OPEN_VISIT_HOURS * HOUR_MS);
}

// The instant a rostered shift ends, or null with no readable roster. A
// night shift's end is a smaller clock reading than its start: it ends on the
// day after the one the visit is filed under.
function rosteredEnd(schedule, shiftDate) {
  if (!schedule || !schedule.hasSchedule || !shiftDate) return null;
  const end = T.parseClock(schedule.endTime);
  if (end === null) return null;
  const start = T.parseClock(schedule.startTime);
  const day = start !== null && end < start ? T.shiftDateKey(shiftDate, 1) : shiftDate;
  return T.localInstant(day, Math.floor(end / 60), end % 60);
}

/**
 * When a staff visit that started at `checkInAt` stops being open: the
 * rostered end plus STAFF_SHIFT_GRACE_HOURS, or STAFF_OPEN_HOURS after the
 * check-in when there is no roster to go by. Never later than a member's
 * window, OPEN_VISIT_HOURS, so the daily job's cut-off still covers every
 * visit.
 */
function staffOpenUntil(schedule, checkInAt, shiftDate) {
  const inAt = new Date(checkInAt).getTime();
  const longest = inAt + OPEN_VISIT_HOURS * HOUR_MS;

  const end = rosteredEnd(schedule, shiftDate);
  const until = end && end.getTime() > inAt
    ? end.getTime() + STAFF_SHIFT_GRACE_HOURS * HOUR_MS
    : inAt + STAFF_OPEN_HOURS * HOUR_MS;

  return new Date(Math.min(until, longest));
}

// Filter (find / $match) for visits a scan could still close -- the people
// who are inside right now. `openUntil` only ever shortens the window: a row
// without one (a member, or a visit from before it existed) has the general
// window alone.
function openVisitMatch(now = new Date()) {
  return {
    checkOutAt: null,
    autoClosed: { $ne: true },
    voided: { $ne: true },
    checkInAt: { $gte: openVisitCutoff(now) },
    openUntil: { $not: { $lte: now } }
  };
}

// The same test as an aggregation expression, for a $cond inside a $group.
// ($ifNull because a missing field compares below every date here, where in
// a find it simply fails to match.)
function openVisitExpr(now = new Date()) {
  return {
    $and: [
      { $eq: ['$checkOutAt', null] },
      { $ne: ['$autoClosed', true] },
      { $ne: ['$voided', true] },
      { $gte: ['$checkInAt', openVisitCutoff(now)] },
      { $or: [{ $eq: [{ $ifNull: ['$openUntil', null] }, null] }, { $gt: ['$openUntil', now] }] }
    ]
  };
}

// Filter for visits that ended without a check-out: already marked by the
// job, or past the window and waiting for it.
function missedCheckOutMatch(now = new Date()) {
  return {
    checkOutAt: null,
    voided: { $ne: true },
    $or: [{ autoClosed: true }, { checkInAt: { $lt: openVisitCutoff(now) } }, { openUntil: { $lte: now } }]
  };
}

// The same two questions for a row already in hand.
function isOpenVisit(row, now = new Date()) {
  if (!row || row.checkOutAt || row.autoClosed || row.voided || !row.checkInAt) return false;
  if (row.openUntil && new Date(row.openUntil).getTime() <= now.getTime()) return false;
  return new Date(row.checkInAt).getTime() >= openVisitCutoff(now).getTime();
}

function missedCheckOut(row, now = new Date()) {
  if (!row || row.checkOutAt || row.voided || !row.checkInAt) return false;
  return !isOpenVisit(row, now);
}

/**
 * Marks every visit in the CURRENT gym's database that is still open past
 * OPEN_VISIT_HOURS as autoClosed. Must run inside a tenant context
 * (runWithTenant / forEachActiveGym). Returns how many visits it closed --
 * or, with dryRun, how many it would have.
 *
 * A staff visit past its own, shorter window is already treated as ended by
 * every helper above; it is marked here once it is past OPEN_VISIT_HOURS too,
 * which staffOpenUntil guarantees is never later.
 */
async function closeStaleVisits({ now = new Date(), dryRun = false } = {}) {
  const filter = {
    checkOutAt: null,
    autoClosed: { $ne: true },
    voided: { $ne: true },
    checkInAt: { $lt: openVisitCutoff(now) }
  };

  if (dryRun) return Attendance.countDocuments(filter);

  // The visit also gives up the `open` flag (see attendanceModel.js), so the
  // one-open-visit index never holds a visit that is over.
  const result = await Attendance.updateMany(filter, {
    $set: { autoClosed: true, autoClosedAt: now },
    $unset: { open: '' }
  });
  return (result && result.modifiedCount) || 0;
}

module.exports = {
  OPEN_VISIT_HOURS,
  STAFF_SHIFT_GRACE_HOURS,
  STAFF_OPEN_HOURS,
  staffOpenUntil,
  openVisitCutoff,
  openVisitMatch,
  openVisitExpr,
  missedCheckOutMatch,
  isOpenVisit,
  missedCheckOut,
  closeStaleVisits
};
