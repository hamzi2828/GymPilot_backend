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

const Attendance = require('../models/attendanceModel');

// How far back a check-out may reach to find its own check-in. Longer than a
// working day so a night shift ending at 06:00 still closes the row it opened
// at 22:00, but short enough that a member who forgot to check out on Monday
// is not "checked out" by Tuesday morning's arrival. Also the point after
// which a visit stops counting as "still inside".
const OPEN_VISIT_HOURS = Number(process.env.ATTENDANCE_OPEN_VISIT_HOURS || 18);

function openVisitCutoff(now = new Date()) {
  return new Date(now.getTime() - OPEN_VISIT_HOURS * 60 * 60 * 1000);
}

// Filter (find / $match) for visits a scan could still close -- the people
// who are inside right now.
function openVisitMatch(now = new Date()) {
  return {
    checkOutAt: null,
    autoClosed: { $ne: true },
    checkInAt: { $gte: openVisitCutoff(now) }
  };
}

// The same test as an aggregation expression, for a $cond inside a $group.
function openVisitExpr(now = new Date()) {
  return {
    $and: [
      { $eq: ['$checkOutAt', null] },
      { $ne: ['$autoClosed', true] },
      { $gte: ['$checkInAt', openVisitCutoff(now)] }
    ]
  };
}

// Filter for visits that ended without a check-out: already marked by the
// job, or past the window and waiting for it.
function missedCheckOutMatch(now = new Date()) {
  return {
    checkOutAt: null,
    $or: [{ autoClosed: true }, { checkInAt: { $lt: openVisitCutoff(now) } }]
  };
}

// The same two questions for a row already in hand.
function isOpenVisit(row, now = new Date()) {
  if (!row || row.checkOutAt || row.autoClosed || !row.checkInAt) return false;
  return new Date(row.checkInAt).getTime() >= openVisitCutoff(now).getTime();
}

function missedCheckOut(row, now = new Date()) {
  if (!row || row.checkOutAt || !row.checkInAt) return false;
  return !isOpenVisit(row, now);
}

/**
 * Marks every visit in the CURRENT gym's database that is still open past
 * OPEN_VISIT_HOURS as autoClosed. Must run inside a tenant context
 * (runWithTenant / forEachActiveGym). Returns how many visits it closed --
 * or, with dryRun, how many it would have.
 */
async function closeStaleVisits({ now = new Date(), dryRun = false } = {}) {
  const filter = {
    checkOutAt: null,
    autoClosed: { $ne: true },
    checkInAt: { $lt: openVisitCutoff(now) }
  };

  if (dryRun) return Attendance.countDocuments(filter);

  const result = await Attendance.updateMany(filter, { $set: { autoClosed: true, autoClosedAt: now } });
  return (result && result.modifiedCount) || 0;
}

module.exports = {
  OPEN_VISIT_HOURS,
  openVisitCutoff,
  openVisitMatch,
  openVisitExpr,
  missedCheckOutMatch,
  isOpenVisit,
  missedCheckOut,
  closeStaleVisits
};
