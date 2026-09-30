// src/attendance/services/liveBoard.js
//
// The office's live view of today (GET /api/attendance/live): who came in,
// in what order, and whether they are paid up. Pure functions over stored
// attendance rows, so the numbers are the ones the desk recorded at the
// moment each person walked in -- a renewal at noon does not turn a morning
// visit on an expired package into a paid one.

const { balanceDueLabel, currentVerdict } = require('./punchService');

// A visit is PAID when the member walked in on a paid membership that was
// still running: active (expiring soon included -- membershipFor answers
// 'active' for it), frozen (paid, and on hold), or cancelled but still inside
// what was paid for. Everything else is UNPAID: expired, never bought one,
// a card payment that failed, a transfer not yet confirmed, suspended, a
// paid term that had not started yet (membershipFor's 'pending').
//
// Money still owed on a running package (balance due) is paid -- the
// membership is live and the order is paid -- and counted separately.
const PAID_MEMBERSHIP = new Set(['active', 'frozen', 'cancelled']);

function isPaidVisit(row) {
  return row.personType === 'member' && PAID_MEMBERSHIP.has((row.membership && row.membership.status) || 'none');
}

function balanceOwed(row) {
  const due = Number((row.membership && row.membership.balanceDue) ?? 0);
  return Number.isFinite(due) && due > 0 ? due : 0;
}

// The Status column: one word the office can read across the room, and the
// desk's own verdict beside it for the detail.
//
//   key     paid | expiring | balance_due | frozen | cancelled | unpaid |
//           suspended | staff -- what the pill is coloured by
//   label   Paid, Expiring, Balance due £25, Frozen, Unpaid, Not started ...
//
// A problem outranks money owed (an expired member is "Unpaid" however much
// else they owe); money owed outranks "expiring" -- the row carries the
// balance separately either way.
function standingOf(row) {
  if (row.personType !== 'member') {
    // How the shift is going, in the desk's words: the arrival, or how it
    // ended once it has.
    return { key: 'staff', label: currentVerdict(row).label || 'Staff' };
  }

  if (!isPaidVisit(row)) {
    if (row.status === 'membership_suspended') return { key: 'suspended', label: 'Suspended' };
    // Paid for a term that had not started: not covered today, so counted
    // unpaid, but "Unpaid" would tell the office the money never came.
    if (row.membership && row.membership.startsOn) return { key: 'unpaid', label: 'Not started' };
    return { key: 'unpaid', label: 'Unpaid' };
  }
  if (row.status === 'membership_frozen') return { key: 'frozen', label: 'Frozen' };
  if (balanceOwed(row) > 0) return { key: 'balance_due', label: balanceDueLabel(row) };
  if (row.status === 'membership_cancelled') return { key: 'cancelled', label: 'Cancelled' };
  if (row.status === 'membership_expiring') return { key: 'expiring', label: 'Expiring' };
  return { key: 'paid', label: 'Paid' };
}

/**
 * Today's counts over the rows given (oldest first or not, it does not
 * matter): visits and who is in now, and the members -- each counted once,
 * by the latest of their visits -- who were paid up, not paid up, and, of
 * the paid, still owed money. `isOpen(row)` answers "still inside".
 */
function tally(rows, isOpen) {
  const latest = new Map();
  let inNow = 0;
  const staff = new Set();

  for (const row of rows) {
    if (isOpen(row)) inNow++;
    const key = String(row.personId);
    if (row.personType !== 'member') {
      staff.add(key);
      continue;
    }
    const seen = latest.get(key);
    if (!seen || new Date(row.checkInAt || 0) >= new Date(seen.checkInAt || 0)) latest.set(key, row);
  }

  let paid = 0;
  let unpaid = 0;
  let balanceDue = 0;
  for (const row of latest.values()) {
    if (!isPaidVisit(row)) {
      unpaid++;
      continue;
    }
    paid++;
    // Of the paid, those still owing: the figure sits beside the paid count
    // ("3 paid (1 owing)"). A lapsed member may owe on an old order too, but
    // they are unpaid -- the status column ranks the problem first -- and
    // counting them here read "0 paid (1 owing)".
    if (balanceOwed(row) > 0) balanceDue++;
  }

  return {
    visits: rows.length,
    members: latest.size,
    staff: staff.size,
    in_now: inNow,
    paid,
    unpaid,
    balance_due: balanceDue
  };
}

module.exports = { PAID_MEMBERSHIP, isPaidVisit, balanceOwed, standingOf, tally };
