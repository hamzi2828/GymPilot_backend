// src/attendance/controller/attendanceCorrectionController.js
//
// The office's corrections to what the front desk recorded. Only a punch at
// the desk ever creates a visit; but a visit the desk got wrong has to be
// fixable by somebody, because staff are paid from these rows. A receptionist
// who forgot to scan out has "No check-out" and no hours until someone says
// when they left, and a scan of the wrong person has to stop counting.
//
//   PATCH /api/attendance/records/:id        set or fix the check-in / check-out
//   POST  /api/attendance/records/:id/void   the visit should never have been recorded
//   GET   /api/attendance/settings           the gym's attendance settings
//   PUT   /api/attendance/settings
//
// Every write needs 'manage' on the attendance tab and is written to the
// admin audit log by the permission gate (routes/adminRoutes.js). The row
// keeps its own history too -- who, when, why, and the times before and
// after, in `edits` -- so a visit carries its corrections wherever it is read.
//
// A bare 'YYYY-MM-DDTHH:MM', which is what a datetime input sends, is a
// wall-clock time AT THE GYM: it is read in the gym's timezone, not the
// browser's, the same clock every attendance screen is drawn in.

const Attendance = require('../models/attendanceModel');
const Settings = require('../../models/settings');
const User = require('../../models/user');
const { fullName } = require('../services/peopleDirectory');
const { arrivalVerdict, departureVerdict, attendanceSettings, VOICE_DEFAULTS } = require('../services/punchService');
const { staffOpenUntil, isOpenVisit, missedCheckOut } = require('../services/staleVisits');
const T = require('../services/timeUtils');

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
// An instant must say which zone it is in; anything else is a wall clock.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const MAX_NOTE = 500;
// Longer than any real shift, and short enough to catch a date typed wrong:
// a check-out on the wrong day would otherwise pay a day and a half.
const MAX_VISIT_HOURS = 24;
// A browser clock a little ahead of the server's is not a time in the future.
const CLOCK_SKEW_MS = 60 * 1000;

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

// undefined when it was not sent; null when it was sent but cannot be read.
function readTime(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const text = value.trim();

  const wall = text.match(WALL_CLOCK);
  if (wall) {
    const [year, month, day, hour, minute, second] = wall.slice(1).map((part) => Number(part || 0));
    // A day that does not exist (31 Feb) would otherwise roll into the next month.
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    return T.localInstant(`${wall[1]}-${wall[2]}-${wall[3]}`, hour, minute, second);
  }

  if (!INSTANT.test(text)) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NOTE) : '';
}

function timesOf(row) {
  return {
    checkInAt: row.checkInAt || null,
    checkOutAt: row.checkOutAt || null,
    workedMinutes: row.workedMinutes === undefined ? null : row.workedMinutes
  };
}

function momentLabel(at) {
  return at ? `${T.dateLabel(at)} ${T.timeLabel(at)}` : null;
}

// Who is making the correction, as it will be written on the row.
async function actorOf(req) {
  const id = req.user && req.user.id;
  const user = id && OBJECT_ID.test(String(id))
    ? await User.findById(id).select('firstName lastName email').lean()
    : null;
  return {
    by: user ? user._id : null,
    byName: user ? fullName(user) : (req.user && req.user.email) || ''
  };
}

// A visit is read with its voided siblings in view: correcting one must be
// able to say "that one is voided" rather than "not found".
function findVisit(id) {
  return Attendance.findById(id).setOptions({ withVoided: true });
}

// Another visit of the same person's that the corrected one would overlap:
// one that ran into it, or one that began inside it. Hours in both would be
// paid twice.
function overlapping(row, checkInAt, checkOutAt) {
  return Attendance.findOne({
    _id: { $ne: row._id },
    personType: row.personType,
    personId: row.personId,
    checkInAt: { $lt: checkOutAt },
    $or: [{ checkOutAt: { $gt: checkInAt } }, { checkOutAt: null, checkInAt: { $gte: checkInAt } }]
  })
    .select('checkInAt checkOutAt')
    .lean();
}

/**
 * A row's corrections in the admin API's vocabulary. Exported so the punch
 * log can carry them on every row it lists.
 */
function correctionFields(row) {
  const edits = Array.isArray(row && row.edits) ? row.edits : [];
  const last = edits.length ? edits[edits.length - 1] : null;
  return {
    voided: !!(row && row.voided),
    voided_at: (row && row.voidedAt) || null,
    void_reason: (row && row.voidReason) || '',
    edited: edits.some((entry) => entry && entry.action === 'edit'),
    corrections: edits.length,
    last_correction: last
      ? {
          action: last.action,
          at: last.at || null,
          at_label: momentLabel(last.at),
          by_name: last.byName || '',
          note: last.note || ''
        }
      : null
  };
}

// The corrected visit, in the fields the punch log shows for it.
function shapeCorrected(row, now = new Date()) {
  return {
    id: String(row._id),
    person_type: row.personType,
    person_name: row.personName || '',
    shift_date: row.shiftDate,
    check_in_at: row.checkInAt || null,
    check_out_at: row.checkOutAt || null,
    check_in_time: T.timeLabel(row.checkInAt),
    check_out_time: T.timeLabel(row.checkOutAt),
    still_in: isOpenVisit(row, now),
    no_check_out: missedCheckOut(row, now),
    worked_minutes: row.workedMinutes === undefined ? null : row.workedMinutes,
    worked_label: T.durationLabel(row.workedMinutes),
    status: row.status || '',
    status_label: row.statusLabel || '',
    departure_status: row.departureStatus || '',
    departure_label: row.departureLabel || '',
    ...correctionFields(row)
  };
}

// Saves a correction only if the row is still as it was read. The desk may
// check the person out, or another administrator correct the same visit, in
// between; either way this one is refused rather than written over theirs.
async function saveIfUnchanged(row, where) {
  row.$where = where;
  try {
    await row.save();
    return true;
  } catch (error) {
    if (error && error.name === 'DocumentNotFoundError') return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Attendance settings
// ---------------------------------------------------------------------------

// Long enough for a sentence, short enough that the desk is not reading a
// paragraph at a queue. The settings schema holds the same ceiling.
const MAX_VOICE_MESSAGE = 200;

// The settings as the page and the kiosk read them. `voice_defaults` is what a
// message left blank goes back to, so the page can show it as the placeholder.
function settingsPayload(current) {
  const voiceOut = (voice) => ({
    enabled: voice.enabled !== false,
    expired_message: voice.expiredMessage,
    expiring_message: voice.expiringMessage,
    balance_due_message: voice.balanceDueMessage
  });
  return {
    member_scan_out: current.memberScanOut,
    // Who the desk turns away instead of letting in with a warning.
    refuse_entry: {
      expired: current.refuseEntry.expired,
      unpaid: current.refuseEntry.unpaid,
      no_package: current.refuseEntry.noPackage
    },
    voice: voiceOut(current.voice),
    voice_defaults: voiceOut(VOICE_DEFAULTS)
  };
}

// The voice fields of a PUT, checked, as the $set they make. A message sent
// blank is stored blank and read back as the default (punchService
// voiceSettings), which is how an office puts a message back as it was.
function readVoice(voice) {
  if (!voice || typeof voice !== 'object' || Array.isArray(voice)) {
    return { error: 'voice must be an object.' };
  }
  const set = {};
  if (voice.enabled !== undefined) {
    if (typeof voice.enabled !== 'boolean') return { error: 'voice.enabled must be true or false.' };
    set['attendance.voice.enabled'] = voice.enabled;
  }
  for (const key of ['expiredMessage', 'expiringMessage', 'balanceDueMessage']) {
    if (voice[key] === undefined) continue;
    if (typeof voice[key] !== 'string') return { error: `voice.${key} must be text.` };
    const text = voice[key].replace(/\s+/g, ' ').trim();
    if (text.length > MAX_VOICE_MESSAGE) {
      return { error: `Keep each spoken message under ${MAX_VOICE_MESSAGE} characters.` };
    }
    set[`attendance.voice.${key}`] = text;
  }
  return { set };
}

module.exports = {
  correctionFields,

  // -------------------------------------------------------------------------
  // PATCH /api/attendance/records/:id   { checkInAt?, checkOutAt?, note }
  //
  // Sets the times and re-derives everything that follows from them: the
  // duration, and for staff the arrival and departure verdicts against the
  // roster the visit was recorded under. A check-out set here closes the
  // visit for good -- no longer open, no longer "No check-out".
  // -------------------------------------------------------------------------
  editTimes: async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!OBJECT_ID.test(id)) return fail(res, 400, 'Invalid attendance record id.');

      const body = req.body || {};
      const note = cleanText(body.note);
      if (!note) return fail(res, 400, 'Add a note saying why the times are being changed.');

      const checkInAt = readTime(body.checkInAt);
      const checkOutAt = readTime(body.checkOutAt);
      if (checkInAt === undefined && checkOutAt === undefined) {
        return fail(res, 400, 'Send a check-in or a check-out time to change.');
      }
      if (checkInAt === null) return fail(res, 400, 'That check-in time could not be read.');
      if (checkOutAt === null) return fail(res, 400, 'That check-out time could not be read.');

      const row = await findVisit(id);
      if (!row) return fail(res, 404, 'That visit no longer exists.');
      if (row.voided) return fail(res, 409, 'This visit is voided and can no longer be changed.');

      const now = new Date();
      const nextIn = checkInAt || row.checkInAt;
      const nextOut = checkOutAt || row.checkOutAt || null;

      if (!nextIn) return fail(res, 400, 'This visit has no check-in time; send one.');
      // The visit is filed under its day -- the roster it was judged against,
      // the month it counts in. Moving it to another day is not a correction.
      if (T.dateKey(nextIn) !== row.shiftDate) {
        return fail(
          res,
          400,
          `The check-in must stay on ${T.dateLabelForKey(row.shiftDate)}, the day this visit is filed under. If it belongs to another day, void it instead.`
        );
      }
      if (nextIn.getTime() > now.getTime() + CLOCK_SKEW_MS) return fail(res, 400, 'The check-in cannot be in the future.');
      if (nextOut) {
        if (nextOut.getTime() > now.getTime() + CLOCK_SKEW_MS) return fail(res, 400, 'The check-out cannot be in the future.');
        if (nextOut.getTime() <= nextIn.getTime()) return fail(res, 400, 'The check-out must be after the check-in.');
        if (nextOut.getTime() - nextIn.getTime() > MAX_VISIT_HOURS * 60 * 60 * 1000) {
          return fail(res, 400, `A visit cannot be longer than ${MAX_VISIT_HOURS} hours. Check the check-out date.`);
        }
      }

      const before = timesOf(row);
      const sameIn = before.checkInAt && before.checkInAt.getTime() === nextIn.getTime();
      const sameOut = (before.checkOutAt ? before.checkOutAt.getTime() : null) === (nextOut ? nextOut.getTime() : null);
      if (sameIn && sameOut) return fail(res, 400, 'Those are the times already recorded.');

      if (nextOut) {
        const clash = await overlapping(row, nextIn, nextOut);
        if (clash) {
          const other = clash.checkOutAt
            ? `${momentLabel(clash.checkInAt)} – ${T.timeLabel(clash.checkOutAt)}`
            : momentLabel(clash.checkInAt);
          return fail(res, 409, `Those times overlap another visit by the same person (${other}).`);
        }
      }

      row.checkInAt = nextIn;
      if (nextOut) {
        row.checkOutAt = nextOut;
        row.workedMinutes = Math.round((nextOut.getTime() - nextIn.getTime()) / 60000);
        // A time out is on record now: the visit is neither open nor one that
        // ended without a check-out.
        row.open = undefined;
        row.autoClosed = false;
        row.autoClosedAt = null;
      }

      if (row.personType === 'staff') {
        // Judged against the roster stored on the row -- the shift as it was
        // that day -- exactly as the desk judged the punch.
        const schedule = row.schedule || {};
        const arrival = arrivalVerdict(schedule, nextIn);
        row.status = arrival.status;
        row.statusLabel = arrival.label;
        row.varianceMinutes = arrival.variance;
        if (nextOut) {
          const departure = departureVerdict(schedule, nextOut);
          row.departureStatus = departure.status;
          row.departureLabel = departure.label;
          row.departureVarianceMinutes = departure.variance;
        } else {
          row.openUntil = staffOpenUntil(schedule, nextIn, row.shiftDate);
        }
      }
      // A member's verdict is the membership they walked in on; the times of
      // the visit do not change it.

      row.edits.push({ action: 'edit', at: now, ...(await actorOf(req)), note, before, after: timesOf(row) });

      const saved = await saveIfUnchanged(row, {
        checkInAt: before.checkInAt,
        checkOutAt: before.checkOutAt,
        voided: { $ne: true }
      });
      if (!saved) return fail(res, 409, 'This visit changed while you were editing it. Reload and try again.');

      return res.json({ success: true, message: 'Visit times updated.', record: shapeCorrected(row, now) });
    } catch (err) {
      console.error('[attendance] correction failed:', err);
      return fail(res, 500, 'Could not update that visit.');
    }
  },

  // -------------------------------------------------------------------------
  // POST /api/attendance/records/:id/void   { reason }
  //
  // For a visit that should never have been recorded. It is kept, with the
  // reason, but counts toward nothing: no total, no "inside now", no pay.
  // -------------------------------------------------------------------------
  voidVisit: async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!OBJECT_ID.test(id)) return fail(res, 400, 'Invalid attendance record id.');

      const reason = cleanText((req.body || {}).reason);
      if (!reason) return fail(res, 400, 'Add a reason for voiding this visit.');

      const row = await findVisit(id);
      if (!row) return fail(res, 404, 'That visit no longer exists.');
      if (row.voided) return fail(res, 409, 'This visit is already voided.');

      const now = new Date();
      const before = timesOf(row);
      row.voided = true;
      row.voidedAt = now;
      row.voidReason = reason;
      // It gives up the one-open-visit slot: somebody still in the building
      // starts a visit of their own at their next scan.
      row.open = undefined;
      row.edits.push({ action: 'void', at: now, ...(await actorOf(req)), note: reason, before, after: timesOf(row) });

      const saved = await saveIfUnchanged(row, { voided: { $ne: true } });
      if (!saved) return fail(res, 409, 'This visit is already voided.');

      return res.json({ success: true, message: 'Visit voided.', record: shapeCorrected(row, now) });
    } catch (err) {
      console.error('[attendance] void failed:', err);
      return fail(res, 500, 'Could not void that visit.');
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/attendance/settings
  // PUT /api/attendance/settings   { memberScanOut?: boolean,
  //                                  refuseEntry?: { expired?, unpaid?, noPackage? },
  //                                  voice?: { enabled?, expiredMessage?,
  //                                            expiringMessage?, balanceDueMessage? } }
  //
  // Whether members scan on the way out as well as in -- off, every member
  // scan is a new visit (see punchService) -- and what the desk says out loud
  // for a member whose fee has run out, is running out or has a balance owing.
  // Kept here, beside the screen they change, rather than on the general
  // settings page. A PUT changes only what it sends.
  // -------------------------------------------------------------------------
  settings: async (req, res) => {
    try {
      return res.json({ success: true, settings: settingsPayload(await attendanceSettings()) });
    } catch (err) {
      console.error('[attendance] settings read failed:', err);
      return fail(res, 500, 'Could not load the attendance settings.');
    }
  },

  updateSettings: async (req, res) => {
    try {
      const body = req.body || {};
      const set = {};
      const said = [];

      if (body.memberScanOut !== undefined) {
        if (typeof body.memberScanOut !== 'boolean') return fail(res, 400, 'memberScanOut must be true or false.');
        set['attendance.memberScanOut'] = body.memberScanOut;
        said.push(body.memberScanOut ? 'Members now scan in and out.' : 'Members now scan in only.');
      }

      if (body.refuseEntry !== undefined) {
        const rules = body.refuseEntry;
        if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return fail(res, 400, 'refuseEntry must be an object.');
        let changed = false;
        for (const key of ['expired', 'unpaid', 'noPackage']) {
          if (rules[key] === undefined) continue;
          if (typeof rules[key] !== 'boolean') return fail(res, 400, `refuseEntry.${key} must be true or false.`);
          set[`attendance.refuseEntry.${key}`] = rules[key];
          changed = true;
        }
        if (changed) said.push('Entry rules saved.');
      }

      if (body.voice !== undefined) {
        const voice = readVoice(body.voice);
        if (voice.error) return fail(res, 400, voice.error);
        Object.assign(set, voice.set);
        if (Object.keys(voice.set).length) said.push('Desk voice saved.');
      }

      if (!Object.keys(set).length) {
        return fail(res, 400, 'Nothing to change: send memberScanOut (true or false), refuseEntry or voice.');
      }

      // getSettings() creates the gym's settings row if it has none yet.
      const current = await Settings.getSettings();
      await Settings.updateOne({ _id: current._id }, { $set: set });

      return res.json({
        success: true,
        message: said.join(' '),
        settings: settingsPayload(await attendanceSettings())
      });
    } catch (err) {
      console.error('[attendance] settings update failed:', err);
      return fail(res, 500, 'Could not save the attendance settings.');
    }
  }
};
