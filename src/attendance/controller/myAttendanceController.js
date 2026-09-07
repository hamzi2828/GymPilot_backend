// src/attendance/controller/myAttendanceController.js
//
// A member looking at their own attendance. Separate from the admin controller
// for one reason that matters: this one is NOT permission-gated, so the query
// is pinned to the signed-in account's own id and can never be widened by a
// query parameter. There is no `personId` input here on purpose.
//
// Staff see the same screen. Their rows are filed under personType 'staff',
// so the lookup is by id alone and both kinds come back.

const mongoose = require('mongoose');

const Attendance = require('../models/attendanceModel');
const T = require('../services/timeUtils');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// Consecutive days ending today or yesterday. Yesterday still counts: a member
// who trained last night and has not been in yet this morning has not broken
// anything, and telling them they have would be both wrong and discouraging.
function currentStreak(dateKeys) {
  if (!dateKeys.size) return 0;

  const today = T.dateKey();
  const yesterday = T.shiftDateKey(today, -1);

  let cursor = dateKeys.has(today) ? today : dateKeys.has(yesterday) ? yesterday : null;
  if (!cursor) return 0;

  let streak = 0;
  while (dateKeys.has(cursor)) {
    streak += 1;
    cursor = T.shiftDateKey(cursor, -1);
  }
  return streak;
}

const User = require('../../models/user');
const { issueQrToken } = require('../services/qrToken');
const { ensureMemberCode, ensureUserStaffCode } = require('../services/peopleDirectory');

module.exports = {
  // GET /api/attendance/me/qr
  qr: async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user || user.isActive === false) return res.status(401).json({ success: false, message: 'Account not found' });

      const isStaff = !!(user.employment && user.employment.isStaff);
      const personType = isStaff ? 'staff' : 'member';
      const code = isStaff ? await ensureUserStaffCode(user) : await ensureMemberCode(user);
      const { token, expiresAt } = issueQrToken({ personType, personId: user._id });

      return res.json({
        success: true,
        data: {
          token,
          expires_at: expiresAt,
          person_type: personType,
          code,
          name: [user.firstName, user.lastName].filter(Boolean).join(' ')
        }
      });
    } catch (error) {
      console.error('[attendance] qr failed:', error);
      return res.status(500).json({ success: false, message: 'Could not create your check-in code' });
    }
  },
  // GET /api/attendance/me
  me: async (req, res) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ success: false, message: 'Authorization required' });
      }

      const personId = new mongoose.Types.ObjectId(String(req.user.id));
      const limit = Math.min(365, Math.max(1, parseInt(req.query.limit, 10) || 120));

      // ?month=YYYY-MM returns that month COMPLETE, rather than whatever part
      // of it falls inside the recent-visits window. Drilling into June and
      // being shown two thirds of June would be worse than not drilling in.
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : null;

      const visitFilter = month
        ? { personId, shiftDate: { $regex: '^' + month } }
        : { personId };

      const rows = await Attendance.find(visitFilter)
        .sort({ checkInAt: -1 })
        .limit(month ? 200 : limit)
        .lean();

      // Totals are over EVERY visit, not just the page above, so "12 visits" on
      // the summary and a shorter list below never contradict each other.
      const [totals] = await Attendance.aggregate([
        { $match: { personId } },
        {
          $group: {
            _id: null,
            visits: { $sum: 1 },
            minutes: { $sum: { $ifNull: ['$workedMinutes', 0] } },
            days: { $addToSet: '$shiftDate' },
            first: { $min: '$checkInAt' },
            last: { $max: '$checkInAt' }
          }
        }
      ]);

      const byMonth = await Attendance.aggregate([
        { $match: { personId } },
        {
          $group: {
            _id: { $substr: ['$shiftDate', 0, 7] },
            visits: { $sum: 1 },
            minutes: { $sum: { $ifNull: ['$workedMinutes', 0] } },
            days: { $addToSet: '$shiftDate' },
            // Which package(s) the month's visits were taken on, from the
            // snapshot written at check-in. Aggregated here rather than
            // derived in the browser: this runs over EVERY visit, whereas the
            // client only ever holds the recent window or one drilled month.
            packages: { $addToSet: '$membership.packageName' }
          }
        },
        { $sort: { _id: -1 } },
        { $limit: 24 }
      ]);

      // Asked directly rather than inferred from `rows`: those are filtered to
      // one month when drilling in, and "you are checked in right now" must not
      // depend on which month is on screen.
      const openVisit = await Attendance.exists({ personId, checkOutAt: null });

      const summary = totals || { visits: 0, minutes: 0, days: [], first: null, last: null };
      const dateKeys = new Set(summary.days || []);

      const thisMonth = byMonth.find((entry) => entry._id === T.dateKey().slice(0, 7));

      return res.json({
        success: true,
        timezone: T.TIMEZONE,
        today: T.dateKey(),

        summary: {
          visits: summary.visits,
          days_present: (summary.days || []).length,
          total_minutes: summary.minutes,
          total_label: T.durationLabel(summary.minutes) || '0 m',
          average_label: summary.visits ? T.durationLabel(Math.round(summary.minutes / summary.visits)) : null,
          first_visit_label: summary.first ? T.dateLabel(summary.first) : null,
          last_visit_label: summary.last ? `${T.dateLabel(summary.last)} · ${T.timeLabel(summary.last)}` : null,
          streak_days: currentStreak(dateKeys),
          this_month: {
            label: monthLabel(T.dateKey().slice(0, 7)),
            visits: thisMonth ? thisMonth.visits : 0,
            minutes: thisMonth ? thisMonth.minutes : 0,
            total_label: thisMonth ? T.durationLabel(thisMonth.minutes) || '0 m' : '0 m'
          },
          // Whether they are in the building right now, which is the one live
          // fact on this screen.
          checked_in_now: !!openVisit
        },

        // Echoed so the UI can title the drill-down without re-deriving it,
        // and so a month with no visits still says which month it is.
        selected_month: month
          ? (() => {
              const found = byMonth.find((entry) => entry._id === month);
              return {
                key: month,
                label: monthLabel(month),
                visits: found ? found.visits : 0,
                days: found ? (found.days || []).length : 0,
                minutes: found ? found.minutes : 0,
                total_label: found ? T.durationLabel(found.minutes) || '0 m' : '0 m',
                average_label:
                  found && found.visits ? T.durationLabel(Math.round(found.minutes / found.visits)) : null,
                packages: found ? (found.packages || []).filter(Boolean) : []
              };
            })()
          : null,

        months: byMonth.map((entry) => ({
          key: entry._id,
          label: monthLabel(entry._id),
          visits: entry.visits,
          days: (entry.days || []).length,
          minutes: entry.minutes,
          total_label: T.durationLabel(entry.minutes) || '0 m',
          average_label: entry.visits ? T.durationLabel(Math.round(entry.minutes / entry.visits)) : null,
          // Empty when the visits predate package snapshotting; the client
          // falls back to the member's package terms in that case.
          packages: (entry.packages || []).filter(Boolean)
        })),

        visits: rows.map((row) => ({
          id: String(row._id),
          shift_date: row.shiftDate,
          date_label: T.dateLabelForKey(row.shiftDate),
          day_name: T.weekdayNameForKey(row.shiftDate),
          check_in_time: T.timeLabel(row.checkInAt),
          check_out_time: T.timeLabel(row.checkOutAt),
          still_in: !row.checkOutAt,
          minutes: row.workedMinutes === undefined ? null : row.workedMinutes,
          duration_label: T.durationLabel(row.workedMinutes),
          // The package the visit was taken on, snapshotted at the time -- so a
          // visit on a since-expired package still says what it was used for.
          package_name: (row.membership && row.membership.packageName) || '',
          status: row.status || '',
          status_label: row.statusLabel || ''
        })),

        // Stated rather than implied: a member with no fingerprint enrolled has
        // an empty screen and no idea why.
        note: summary.visits
          ? null
          : 'Visits appear here once the front desk records them on the reader.'
      });
    } catch (error) {
      console.error('[attendance] my attendance failed:', error);
      return res.status(500).json({ success: false, message: 'Could not load your attendance' });
    }
  }
};
