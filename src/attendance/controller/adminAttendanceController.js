// src/attendance/controller/adminAttendanceController.js
//
// The admin panel's read-only window onto attendance. The front desk records
// punches through /api/desktop; this is the same data seen from the office,
// which needs three things the desk does not:
//
//   * a range wider than "today"   -- every query here is filtered, not global
//   * the people who did NOT turn up -- /people lists the whole roster, not
//     just the rows attendance happened to produce
//   * one person's full history    -- /person/:type/:id
//
// Every time and date is formatted server-side through timeUtils, for the
// same reason the desktop app never formats its own: the gym's local day is
// the one that matters, and a browser in another timezone (or this backend on
// Vercel, running UTC) would otherwise draw a different one.

const mongoose = require('mongoose');

const Attendance = require('../models/attendanceModel');
const Fingerprint = require('../models/fingerprintModel');
const User = require('../../models/user');
const Trainer = require('../../gymfolio/models/trainerModel');
const { fullName, membershipsFor } = require('../services/peopleDirectory');
const { membershipVerdict, currentVerdict, balanceDueLabel } = require('../services/punchService');
const { standingOf, isPaidVisit, balanceOwed, tally } = require('../services/liveBoard');
const { correctionFields } = require('./attendanceCorrectionController');
const {
  openVisitMatch,
  openVisitExpr,
  missedCheckOutMatch,
  isOpenVisit,
  missedCheckOut
} = require('../services/staleVisits');
const T = require('../services/timeUtils');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// A roster scan is bounded so one very large gym cannot turn the People tab
// into an unbounded read of every account that ever signed up.
const MAX_ROSTER = 3000;

// Today's visits the live view reads. Far past any real day at one gym; a
// bound so a runaway import cannot turn a 15-second refresh into a scan of
// thousands of rows.
const MAX_LIVE = 2000;

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

// Defaults to today..today, which is what the desk sees. A `from` with no `to`
// runs to today rather than to the end of time.
function readRange(query) {
  const today = T.dateKey();
  let to = DATE_KEY.test(String(query.to || '')) ? String(query.to) : today;
  let from = DATE_KEY.test(String(query.from || '')) ? String(query.from) : to;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  return { from, to };
}

function rangeLabel(from, to) {
  if (from === to) {
    const suffix = from === T.dateKey() ? ' (today)' : '';
    return T.weekdayNameForKey(from) + ', ' + T.dateLabelForKey(from) + suffix;
  }
  return T.dateLabelForKey(from) + ' — ' + T.dateLabelForKey(to);
}

function escapeRx(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readPaging(query, defaultLimit, maxLimit) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit || 200, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

// A staff departure verdict lives in its own field (see punchService), but is
// picked from the same Status list. These names cannot collide with an
// arrival verdict, which is what lets one dropdown ask both questions.
const DEPARTURE_FILTERS = { left_early: 'early', overtime: 'overtime' };

// The WHERE the punch log is built from. `presence` and `status` are
// deliberately separate filters: "still inside" is a fact about the row and
// "late" is a verdict about it, and an operator asks the two at different
// moments.
function buildMatch(query, now = new Date()) {
  const { from, to } = readRange(query);
  const match = { shiftDate: { $gte: from, $lte: to } };
  // Clauses that each carry their own $or, ANDed so they cannot overwrite
  // one another.
  const and = [];

  if (query.personType === 'member' || query.personType === 'staff') {
    match.personType = query.personType;
  }

  if (query.status && query.status !== 'all') {
    const status = String(query.status);
    if (DEPARTURE_FILTERS[status]) match.departureStatus = DEPARTURE_FILTERS[status];
    else match.status = status;
  }

  // "Still in" is bounded by the punch's own window: a visit nobody checked
  // out of last week is a missed check-out, not somebody inside.
  if (query.presence === 'in') Object.assign(match, openVisitMatch(now));
  if (query.presence === 'out') match.checkOutAt = { $ne: null };
  if (query.presence === 'missed') and.push(missedCheckOutMatch(now));

  const term = String(query.q || '').trim();
  if (term) {
    const rx = new RegExp(escapeRx(term), 'i');
    and.push({ $or: [{ personName: rx }, { personCode: rx }] });
  }

  if (and.length) match.$and = and;

  if (query.personId && OBJECT_ID.test(String(query.personId))) {
    match.personId = toObjectId(query.personId);
  }

  return { match, from, to };
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function punchContext(context) {
  if (!context) return null;
  return {
    name: context.byName || '',
    device: context.device || '',
    os_user: context.osUser || '',
    method: context.method || '',
    ip: context.ip || '',
    location: context.location || ''
  };
}

// The same fields the desktop receipt renders, in the same vocabulary, so a
// row read in the office and a receipt read at the desk cannot disagree.
//
// For staff, `status` is the ARRIVAL verdict and `departure_*` how the shift
// ended. A visit nobody checked out of has `no_check_out` and neither a time
// out nor a duration.
function shapeRecord(row, now = new Date()) {
  const membership = row.membership || {};
  const schedule = row.schedule || {};

  return {
    id: String(row._id),
    person_type: row.personType,
    person_id: String(row.personId),
    person_name: row.personName || '',
    person_code: row.personCode || '',

    shift_date: row.shiftDate,
    day_name: T.weekdayNameForKey(row.shiftDate),
    date_label: T.dateLabelForKey(row.shiftDate),

    check_in_at: row.checkInAt || null,
    check_out_at: row.checkOutAt || null,
    check_in_time: T.timeLabel(row.checkInAt),
    check_out_time: T.timeLabel(row.checkOutAt),
    still_in: isOpenVisit(row, now),
    no_check_out: missedCheckOut(row, now),
    auto_closed_at: row.autoClosedAt || null,

    worked_minutes: row.workedMinutes === undefined ? null : row.workedMinutes,
    worked_label: T.durationLabel(row.workedMinutes),

    status: row.status || '',
    status_label: row.statusLabel || '',
    variance_minutes: row.varianceMinutes === undefined ? null : row.varianceMinutes,
    departure_status: row.departureStatus || '',
    departure_label: row.departureLabel || '',
    departure_variance_minutes:
      row.departureVarianceMinutes === undefined ? null : row.departureVarianceMinutes,

    membership: {
      status: membership.status || 'none',
      package_name: membership.packageName || '',
      end_date_label: membership.endDate ? T.dateLabel(membership.endDate) : null
    },
    schedule: {
      has_schedule: !!schedule.hasSchedule,
      start_time: schedule.startTime || '',
      end_time: schedule.endTime || '',
      label: schedule.hasSchedule ? schedule.startTime + ' - ' + schedule.endTime : 'Not rostered'
    },

    check_in_by: punchContext(row.checkIn),
    check_out_by: punchContext(row.checkOut),
    recorded_at: row.updatedAt || row.createdAt || null,
    // Edited / voided markers and the latest correction, for the log.
    ...correctionFields(row)
  };
}

// Counted over the WHOLE filtered set rather than the page: a summary that
// changed when you turned the page would be worse than no summary.
async function summarise(match, now = new Date()) {
  const result = await Attendance.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              visits: { $sum: 1 },
              minutes: { $sum: { $ifNull: ['$workedMinutes', 0] } },
              closed: { $sum: { $cond: [{ $eq: ['$checkOutAt', null] }, 0, 1] } },
              openNow: { $sum: { $cond: [openVisitExpr(now), 1, 0] } }
            }
          }
        ],
        byType: [{ $group: { _id: '$personType', count: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        byDeparture: [
          { $match: { departureStatus: { $nin: [null, ''] } } },
          { $group: { _id: '$departureStatus', count: { $sum: 1 } } }
        ],
        people: [{ $group: { _id: { t: '$personType', p: '$personId' } } }, { $count: 'n' }]
      }
    }
  ]);

  const facet = result[0] || {};
  const totals = (facet.totals && facet.totals[0]) || { visits: 0, minutes: 0, closed: 0, openNow: 0 };

  const byType = {};
  for (const entry of facet.byType || []) byType[entry._id] = entry.count;

  const byStatus = {};
  for (const entry of facet.byStatus || []) byStatus[entry._id || 'unknown'] = entry.count;

  const byDeparture = {};
  for (const entry of facet.byDeparture || []) byDeparture[entry._id] = entry.count;

  // The departure filters' counts, under the names the Status list uses for
  // them (DEPARTURE_FILTERS), so every option can say how many it will show.
  for (const [name, departure] of Object.entries(DEPARTURE_FILTERS)) {
    byStatus[name] = byDeparture[departure] || 0;
  }

  const uniquePeople = (facet.people && facet.people[0] && facet.people[0].n) || 0;
  const stillIn = totals.openNow || 0;
  // Everything neither checked out nor still inside ended without a
  // check-out, whether or not the daily job has marked it yet.
  const noCheckOut = totals.visits - totals.closed - stillIn;

  // Averaged over CLOSED visits only -- an open one has no duration yet, and
  // counting it as zero would drag the average down all day.
  const avgMinutes = totals.closed ? Math.round(totals.minutes / totals.closed) : null;

  return {
    visits: totals.visits,
    members: byType.member || 0,
    staff: byType.staff || 0,
    unique_people: uniquePeople,
    still_in: stillIn,
    no_check_out: noCheckOut,
    completed: totals.closed,
    total_minutes: totals.minutes,
    total_label: T.durationLabel(totals.minutes) || '0 m',
    avg_minutes: avgMinutes,
    avg_label: avgMinutes === null ? null : T.durationLabel(avgMinutes),
    // Arrivals, now that check-out no longer overwrites them: every late start
    // in the range, not only the staff still on shift.
    late: byStatus.late || 0,
    on_time: byStatus.on_time || 0,
    left_early: byDeparture.early || 0,
    overtime: byDeparture.overtime || 0,
    // The visits the desk would have stopped: counted as the desk counts
    // "lapsed" (expired, none, suspended), so the two screens agree.
    membership_issues:
      (byStatus.membership_expired || 0) + (byStatus.membership_none || 0) + (byStatus.membership_suspended || 0),
    expiring_soon: byStatus.membership_expiring || 0,
    by_status: byStatus
  };
}

// ---------------------------------------------------------------------------
// Membership, batched
//
// membershipFor() in peopleDirectory answers for one person at the cost of one
// query, which is right at a desk serving one person at a time. A roster page
// asks about twenty-five at once, so membershipsFor() asks once for all of
// them -- with the SAME rules, and the label is the one the desk's receipt
// prints (membershipVerdict). A cancelled plan with days left is "Cancelled ·
// N days left" here too, and a suspended one is "Suspended", not "Active".
// ---------------------------------------------------------------------------

// `status` is membershipFor's own answer (active | frozen | past_due |
// pending | suspended | cancelled | expired | none); `verdict` is the desk's
// colour key for it (membership_active, membership_cancelled...).
function membershipSummary(membership) {
  const verdict = membershipVerdict(membership);
  return {
    status: membership.status,
    label: verdict.label,
    verdict: verdict.status,
    package_name: membership.packageName || '',
    end_label: membership.endDate ? T.dateLabel(membership.endDate) : null,
    days_left: membership.daysLeft,
    sessions_left: membership.sessionsLeft
  };
}

async function membershipIndex(users) {
  const index = new Map();
  for (const [id, membership] of await membershipsFor(users)) {
    index.set(id, membershipSummary(membership));
  }
  return index;
}

module.exports = {
  // -------------------------------------------------------------------------
  // GET /api/attendance/records
  //
  // The punch log: one row per visit, newest first, with the summary for the
  // whole filtered range attached.
  // -------------------------------------------------------------------------
  records: async (req, res) => {
    try {
      const now = new Date();
      const { match, from, to } = buildMatch(req.query, now);
      const { page, limit, skip } = readPaging(req.query, 25, 500);
      // ?summary=0 skips the range summary -- for the CSV export, which walks
      // every page and would otherwise recount the whole range on each one.
      const wantSummary = req.query.summary !== '0';

      // The log lists voided visits too (marked, so the office can see what
      // was voided and why); the summary leaves them out, like every total.
      const [rows, total, summary] = await Promise.all([
        Attendance.find(match).setOptions({ withVoided: true }).sort({ checkInAt: -1, updatedAt: -1 }).skip(skip).limit(limit).lean(),
        Attendance.countDocuments(match).setOptions({ withVoided: true }),
        wantSummary ? summarise(match, now) : null
      ]);

      return res.json({
        success: true,
        timezone: T.TIMEZONE,
        range: { from, to, label: rangeLabel(from, to), today: T.dateKey() },
        summary,
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        records: rows.map((row) => shapeRecord(row, now))
      });
    } catch (err) {
      console.error('[attendance] admin records failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load attendance records.' });
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/attendance/people
  //
  // The roster view: every member and trainer, whether or not they turned up
  // in the range. The most useful attendance question a gym asks is usually
  // about the people who are MISSING from the punch log, and they are
  // invisible in a view built only from attendance rows.
  // -------------------------------------------------------------------------
  people: async (req, res) => {
    try {
      const { from, to } = readRange(req.query);
      const { page, limit, skip } = readPaging(req.query, 25, 500);
      const personType =
        req.query.personType === 'member' || req.query.personType === 'staff'
          ? req.query.personType
          : null;

      const term = String(req.query.q || '').trim();
      const rx = term ? new RegExp(escapeRx(term), 'i') : null;

      // Members are accounts that are not staff and not administrators; staff
      // are Trainer records PLUS accounts holding a staff role. Splitting on
      // employment.isStaff rather than on role keeps a promoted member out of
      // the member list the moment they are promoted.
      const userFilter = { role: { $ne: 'admin' }, 'employment.isStaff': { $ne: true } };
      const staffUserFilter = { 'employment.isStaff': true };
      const trainerFilter = {};

      if (rx) {
        const nameMatch = [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }];
        userFilter.$or = [...nameMatch, { memberCode: rx }];
        staffUserFilter.$or = [...nameMatch, { staffCode: rx }, { 'employment.jobTitle': rx }];
        trainerFilter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { staffCode: rx }];
      }

      const [users, trainers, staffUsers] = await Promise.all([
        personType === 'staff'
          ? []
          : User.find(userFilter)
              .select('firstName lastName email phone memberCode isActive createdAt')
              .limit(MAX_ROSTER)
              .lean(),
        personType === 'member'
          ? []
          : Trainer.find(trainerFilter)
              .select('name email phone staffCode role isActive availability')
              .limit(MAX_ROSTER)
              .lean(),
        personType === 'member'
          ? []
          : User.find(staffUserFilter)
              .select('firstName lastName email phone staffCode isActive employment')
              .limit(MAX_ROSTER)
              .lean()
      ]);

      // One pass over the range, grouped per person. Sorted ascending first so
      // $last is genuinely the most recent punch rather than an arbitrary one.
      const rangeMatch = { shiftDate: { $gte: from, $lte: to } };
      if (personType) rangeMatch.personType = personType;

      const rollups = await Attendance.aggregate([
        { $match: rangeMatch },
        { $sort: { checkInAt: 1 } },
        {
          $group: {
            _id: { personType: '$personType', personId: '$personId' },
            visits: { $sum: 1 },
            minutes: { $sum: { $ifNull: ['$workedMinutes', 0] } },
            days: { $addToSet: '$shiftDate' },
            // Inside right now -- bounded, so a forgotten check-out from last
            // week does not keep somebody "in the gym".
            open: { $sum: { $cond: [openVisitExpr(new Date()), 1, 0] } },
            lastCheckIn: { $last: '$checkInAt' },
            lastStatus: { $last: '$status' },
            lastStatusLabel: { $last: '$statusLabel' },
            lastShiftDate: { $last: '$shiftDate' }
          }
        }
      ]);

      const rollupIndex = new Map();
      for (const entry of rollups) {
        rollupIndex.set(entry._id.personType + ':' + String(entry._id.personId), entry);
      }

      const roster = users
        .map((user) => ({
          person_type: 'member',
          person_id: String(user._id),
          name: fullName(user),
          code: user.memberCode || '',
          email: user.email || '',
          phone: user.phone || '',
          meta: '',
          is_active: user.isActive !== false,
          record: user
        }))
        .concat(
          trainers.map((trainer) => ({
            person_type: 'staff',
            person_id: String(trainer._id),
            name: trainer.name || 'Trainer',
            code: trainer.staffCode || '',
            email: trainer.email || '',
            phone: trainer.phone || '',
            meta: trainer.role || '',
            is_active: trainer.isActive !== false,
            record: trainer
          }))
        )
        .concat(
          staffUsers.map((user) => ({
            person_type: 'staff',
            person_id: String(user._id),
            name: fullName(user),
            code: user.staffCode || '',
            email: user.email || '',
            phone: user.phone || '',
            meta: (user.employment && user.employment.jobTitle) || 'Staff',
            is_active: user.isActive !== false,
            // Normalised to the trainer shape so the roster below counts
            // rostered days the same way for both kinds of staff.
            record: Object.assign({}, user, {
              availability: (user.employment && user.employment.schedule) || []
            })
          }))
        );

      const merged = roster.map((person) => {
        const roll = rollupIndex.get(person.person_type + ':' + person.person_id);
        const visits = roll ? roll.visits : 0;
        const minutes = roll ? roll.minutes : 0;

        return Object.assign({}, person, {
          visits,
          days_present: roll ? (roll.days || []).length : 0,
          total_minutes: minutes,
          total_label: T.durationLabel(minutes) || '0 m',
          avg_label: visits ? T.durationLabel(Math.round(minutes / visits)) : null,
          still_in: roll ? roll.open > 0 : false,
          last_check_in_at: roll ? roll.lastCheckIn : null,
          last_seen_label: roll
            ? T.dateLabelForKey(roll.lastShiftDate) + ' · ' + (T.timeLabel(roll.lastCheckIn) || '—')
            : null,
          last_status: roll ? roll.lastStatus || '' : '',
          last_status_label: roll ? roll.lastStatusLabel || '' : ''
        });
      });

      // "Who has not been in" is a first-class question, so absence is a
      // filter rather than something to eyeball in a sorted column.
      const attended = String(req.query.attended || 'all');
      const filtered = merged.filter((person) => {
        if (attended === 'attended') return person.visits > 0;
        if (attended === 'absent') return person.visits === 0;
        if (attended === 'in') return person.still_in;
        return true;
      });

      const sort = String(req.query.sort || 'last_seen');
      filtered.sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'visits') return b.visits - a.visits || a.name.localeCompare(b.name);
        if (sort === 'time') return b.total_minutes - a.total_minutes || a.name.localeCompare(b.name);
        const at = a.last_check_in_at ? new Date(a.last_check_in_at).getTime() : -1;
        const bt = b.last_check_in_at ? new Date(b.last_check_in_at).getTime() : -1;
        return bt - at || a.name.localeCompare(b.name);
      });

      const total = filtered.length;
      const slice = filtered.slice(skip, skip + limit);
      const sliceIds = slice.map((person) => person.record._id);

      // Only the visible page pays for membership, last-ever-visit and
      // fingerprint lookups.
      const [memberships, everSeen, enrolments] = await Promise.all([
        membershipIndex(slice.filter((p) => p.person_type === 'member').map((p) => p.record)),
        sliceIds.length
          ? Attendance.aggregate([
              { $match: { personId: { $in: sliceIds } } },
              { $sort: { checkInAt: 1 } },
              {
                $group: {
                  _id: { personType: '$personType', personId: '$personId' },
                  lastCheckIn: { $last: '$checkInAt' },
                  lastShiftDate: { $last: '$shiftDate' },
                  visits: { $sum: 1 },
                  minutes: { $sum: { $ifNull: ['$workedMinutes', 0] } }
                }
              }
            ])
          : [],
        sliceIds.length
          ? Fingerprint.aggregate([
              { $match: { isActive: true, personId: { $in: sliceIds } } },
              {
                $group: {
                  _id: { personType: '$personType', personId: '$personId' },
                  fingers: { $sum: 1 }
                }
              }
            ])
          : []
      ]);

      const everIndex = new Map();
      for (const entry of everSeen) {
        everIndex.set(entry._id.personType + ':' + String(entry._id.personId), entry);
      }
      const fingerIndex = new Map();
      for (const entry of enrolments) {
        fingerIndex.set(entry._id.personType + ':' + String(entry._id.personId), entry.fingers);
      }

      const data = slice.map((person) => {
        const key = person.person_type + ':' + person.person_id;
        const ever = everIndex.get(key);
        const trainer = person.person_type === 'staff' ? person.record : null;

        const shaped = Object.assign({}, person, {
          membership:
            person.person_type === 'member'
              ? memberships.get(person.person_id) ||
                membershipSummary({ status: 'none', packageName: '', endDate: null, daysLeft: null, sessionsLeft: null })
              : null,
          schedule_days:
            trainer && Array.isArray(trainer.availability) ? trainer.availability.length : null,
          fingerprints: fingerIndex.get(key) || 0,
          lifetime_visits: ever ? ever.visits : 0,
          lifetime_label: ever ? T.durationLabel(ever.minutes) || '0 m' : '0 m',
          ever_seen_label: ever
            ? T.dateLabelForKey(ever.lastShiftDate) + ' · ' + (T.timeLabel(ever.lastCheckIn) || '—')
            : null
        });

        delete shaped.record;
        return shaped;
      });

      return res.json({
        success: true,
        timezone: T.TIMEZONE,
        range: { from, to, label: rangeLabel(from, to), today: T.dateKey() },
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        counts: {
          roster: merged.length,
          attended: merged.filter((p) => p.visits > 0).length,
          absent: merged.filter((p) => p.visits === 0).length,
          in_now: merged.filter((p) => p.still_in).length
        },
        people: data
      });
    } catch (err) {
      console.error('[attendance] admin people failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load the attendance roster.' });
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/attendance/person/:personType/:personId
  //
  // One person's history, carrying the same per-visit detail the desk receipt
  // shows -- including "Nth visit this month", which is why month totals are
  // aggregated separately rather than counted from the returned page.
  // -------------------------------------------------------------------------
  person: async (req, res) => {
    try {
      const { personType, personId } = req.params;

      if (personType !== 'member' && personType !== 'staff') {
        return res.status(400).json({ success: false, message: 'Unknown person type.' });
      }
      if (!OBJECT_ID.test(String(personId))) {
        return res.status(400).json({ success: false, message: 'Invalid person id.' });
      }

      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
      const owner = { personType, personId: toObjectId(personId) };

      const filter = Object.assign({}, owner);
      if (DATE_KEY.test(String(req.query.from || '')) || DATE_KEY.test(String(req.query.to || ''))) {
        const { from, to } = readRange(req.query);
        filter.shiftDate = { $gte: from, $lte: to };
      }

      const [rows, monthTotals, lifetime, fingerprints] = await Promise.all([
        Attendance.find(filter).sort({ checkInAt: -1 }).limit(limit).lean(),
        Attendance.aggregate([
          { $match: owner },
          { $group: { _id: { $substr: ['$shiftDate', 0, 7] }, visits: { $sum: 1 } } }
        ]),
        Attendance.aggregate([
          { $match: owner },
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
        ]),
        Fingerprint.countDocuments({ personType, personId: toObjectId(personId), isActive: true })
      ]);

      // Records come back newest-first, so within each month the first one
      // seen is that month's highest visit number and the counter walks down.
      const monthCursor = new Map();
      for (const entry of monthTotals) monthCursor.set(entry._id, entry.visits);

      const records = rows.map((row) => {
        const shaped = shapeRecord(row);
        const month = row.shiftDate.slice(0, 7);
        const remaining = monthCursor.get(month);
        if (remaining !== undefined) {
          shaped.visit_number = remaining;
          monthCursor.set(month, remaining - 1);
        }
        return shaped;
      });

      const totals = lifetime[0] || { visits: 0, minutes: 0, days: [], first: null, last: null };

      // Identity is read from the LIVE record, not the snapshot on the
      // attendance rows: the office wants today's phone number, while the
      // rows keep the name that was true at the time of the visit.
      let profile = null;

      if (personType === 'member') {
        const user = await User.findById(personId)
          .select('firstName lastName email phone memberCode isActive createdAt')
          .lean();
        if (user) {
          const memberships = await membershipIndex([user]);
          profile = {
            name: fullName(user),
            code: user.memberCode || '',
            email: user.email || '',
            phone: user.phone || '',
            role: '',
            is_active: user.isActive !== false,
            joined_label: user.createdAt ? T.dateLabel(user.createdAt) : null,
            membership: memberships.get(String(user._id)) || null,
            schedule: null
          };
        }
      } else {
        const trainer = await Trainer.findById(personId)
          .select('name email phone staffCode role isActive availability createdAt')
          .lean();

        // Staff who are accounts rather than trainer profiles -- receptionists,
        // cleaners, managers. Their roster lives under employment.
        const staffUser = trainer
          ? null
          : await User.findOne({ _id: personId, 'employment.isStaff': true })
              .select('firstName lastName email phone staffCode isActive employment createdAt')
              .lean();

        if (staffUser) {
          profile = {
            name: fullName(staffUser),
            code: staffUser.staffCode || '',
            email: staffUser.email || '',
            phone: staffUser.phone || '',
            role: (staffUser.employment && staffUser.employment.jobTitle) || 'Staff',
            is_active: staffUser.isActive !== false,
            joined_label: (staffUser.employment && staffUser.employment.joinedAt)
              ? T.dateLabel(staffUser.employment.joinedAt)
              : staffUser.createdAt ? T.dateLabel(staffUser.createdAt) : null,
            membership: null,
            schedule: ((staffUser.employment && staffUser.employment.schedule) || []).map((shift) => ({
              day: shift.day,
              start_time: shift.startTime || '',
              end_time: shift.endTime || ''
            }))
          };
        } else if (trainer) {
          profile = {
            name: trainer.name || 'Trainer',
            code: trainer.staffCode || '',
            email: trainer.email || '',
            phone: trainer.phone || '',
            role: trainer.role || '',
            is_active: trainer.isActive !== false,
            joined_label: trainer.createdAt ? T.dateLabel(trainer.createdAt) : null,
            membership: null,
            schedule: Array.isArray(trainer.availability)
              ? trainer.availability
                  .filter((slot) => slot && slot.day)
                  .map((slot) => ({
                    day: slot.day,
                    start_time: slot.startTime || '',
                    end_time: slot.endTime || ''
                  }))
              : []
          };
        }
      }

      // The account is gone but its visits are not. Fall back to the snapshot
      // on the rows so the history still reads correctly.
      if (!profile && rows.length) {
        profile = {
          name: rows[0].personName,
          code: rows[0].personCode,
          email: '',
          phone: '',
          role: '',
          is_active: false,
          joined_label: null,
          membership: null,
          schedule: null
        };
      }

      if (!profile) {
        return res.status(404).json({ success: false, message: 'That person is not on file.' });
      }

      return res.json({
        success: true,
        timezone: T.TIMEZONE,
        person: Object.assign(
          { person_type: personType, person_id: String(personId), fingerprints },
          profile
        ),
        totals: {
          visits: totals.visits,
          days_present: (totals.days || []).length,
          total_minutes: totals.minutes,
          total_label: T.durationLabel(totals.minutes) || '0 m',
          avg_label: totals.visits ? T.durationLabel(Math.round(totals.minutes / totals.visits)) : null,
          first_seen_label: totals.first ? T.dateLabel(totals.first) : null,
          last_seen_label: totals.last
            ? T.dateLabel(totals.last) + ' · ' + T.timeLabel(totals.last)
            : null
        },
        records
      });
    } catch (err) {
      console.error('[attendance] admin person failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load that attendance history.' });
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/attendance/live   ?personType=member|staff  &q=
  //
  // Today at the gym, for a screen the office leaves open: every visit with
  // its arrival number, who it was and how to reach them, the package and
  // when it runs out, and whether they are paid up -- plus the day's paid and
  // unpaid counts. The page asks again every few seconds, so this is one read
  // of today's rows and one of their contacts, however many there are.
  //
  // `number` is the visit's place in the day's arrivals (1 = first in), the
  // same whatever the filters, so a row keeps its number as the day goes on.
  // `counts` are the whole day's, also whatever the filters.
  // -------------------------------------------------------------------------
  live: async (req, res) => {
    try {
      const now = new Date();
      const today = T.dateKey(now);

      const rows = await Attendance.find({ shiftDate: today })
        .sort({ checkInAt: 1, _id: 1 })
        .limit(MAX_LIVE)
        .lean();

      // Today's phone number and gender, from the live records: the rows
      // keep the name as it was, the office wants a number that works now.
      const ids = Array.from(new Set(rows.map((row) => String(row.personId))));
      const staffIds = Array.from(new Set(rows.filter((row) => row.personType === 'staff').map((row) => String(row.personId))));
      const [users, trainers] = await Promise.all([
        ids.length ? User.find({ _id: { $in: ids } }).select('phone gender').lean() : [],
        staffIds.length ? Trainer.find({ _id: { $in: staffIds } }).select('phone').lean() : []
      ]);
      const contact = new Map();
      for (const trainer of trainers) contact.set(String(trainer._id), { phone: trainer.phone || '', gender: '' });
      for (const user of users) contact.set(String(user._id), { phone: user.phone || '', gender: user.gender || '' });

      const personType = req.query.personType === 'member' || req.query.personType === 'staff' ? req.query.personType : null;
      const term = String(req.query.q || '').trim().toLowerCase();

      const records = [];
      rows.forEach((row, index) => {
        if (personType && row.personType !== personType) return;
        const who = contact.get(String(row.personId)) || { phone: '', gender: '' };
        if (term) {
          const haystack = [row.personName, row.personCode, who.phone].join(' ').toLowerCase();
          if (!haystack.includes(term)) return;
        }

        const membership = row.membership || {};
        const verdict = currentVerdict(row);
        const balance = row.personType === 'member' ? balanceOwed(row) : 0;
        records.push({
          number: index + 1,
          id: String(row._id),
          person_type: row.personType,
          person_id: String(row.personId),
          code: row.personCode || '',
          name: row.personName || '',
          phone: who.phone,
          gender: who.gender,
          package_name: row.personType === 'member' ? membership.packageName || '' : '',
          end_date_label: row.personType === 'member' && membership.endDate ? T.dateLabel(membership.endDate) : null,
          check_in_time: T.timeLabel(row.checkInAt),
          check_out_time: T.timeLabel(row.checkOutAt),
          still_in: isOpenVisit(row, now),
          no_check_out: missedCheckOut(row, now),
          status: verdict.status || '',
          status_label: verdict.label || '',
          standing: standingOf(row),
          paid: isPaidVisit(row),
          balance_due: balance,
          balance_due_label: balance > 0 ? balanceDueLabel(row) : null
        });
      });

      // Newest first: the arrival that just happened is the one to see.
      records.reverse();

      return res.json({
        success: true,
        timezone: T.TIMEZONE,
        today,
        date_label: T.weekdayNameForKey(today) + ', ' + T.dateLabelForKey(today),
        refreshed_label: T.timeLabel(now),
        counts: tally(rows, (row) => isOpenVisit(row, now)),
        // More visits today than this screen reads: say so, rather than
        // quietly count only the first of them.
        truncated: rows.length >= MAX_LIVE,
        records
      });
    } catch (err) {
      console.error('[attendance] admin live failed:', err);
      return res.status(500).json({ success: false, message: "Could not load today's attendance." });
    }
  }
};
