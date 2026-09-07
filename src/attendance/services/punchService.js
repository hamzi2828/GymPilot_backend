// src/attendance/services/punchService.js
//
// One scan in, one receipt out. The front desk never says "check in" or
// "check out" -- the person just presents a finger and this decides which it
// was, from whether they already have an open visit.
//
// The receipt is built here rather than in the desktop app, and it carries
// its own `rows` array. Members and staff need genuinely different detail
// (a package and an expiry vs. a roster and a late verdict), and letting the
// server say which rows exist means the app has ONE receipt renderer instead
// of two hardcoded layouts that drift apart.

const Attendance = require('../models/attendanceModel');
const { resolvePerson, membershipFor } = require('./peopleDirectory');
const T = require('./timeUtils');

// A finger resting on the reader fires repeatedly, and a member who scans
// twice out of habit would otherwise be checked straight back out. Inside
// this window a second scan is reported as a no-op rather than acted on.
const MIN_PUNCH_GAP_SECONDS = Number(process.env.ATTENDANCE_MIN_PUNCH_GAP_SECONDS || 60);

// How far back a check-out may reach to find its own check-in. Longer than a
// working day so a night shift ending at 06:00 still closes the row it opened
// at 22:00, but short enough that a member who forgot to check out on Monday
// is not "checked out" by Tuesday morning's arrival.
const OPEN_VISIT_HOURS = Number(process.env.ATTENDANCE_OPEN_VISIT_HOURS || 18);

// Minutes past the rostered start before a staff arrival counts as late.
const LATE_GRACE_MINUTES = Number(process.env.ATTENDANCE_LATE_GRACE_MINUTES || 5);

// How many days before a membership runs out the desk starts being told. The
// point is to catch the member while they are standing at the counter, which
// is the only moment renewing is easy for both sides -- a week gives them two
// or three more visits to be asked on.
const EXPIRY_WARNING_DAYS = Number(process.env.ATTENDANCE_EXPIRY_WARNING_DAYS || 7);

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function operatorLabel(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;
}

function punchContext(operator, device, method) {
  return {
    by: operator._id,
    byName: operatorLabel(operator),
    device: device.deviceLabel || '',
    osUser: device.osUser || '',
    clientApp: device.clientApp || '',
    ip: device.ip || '',
    // How the person was identified: a finger on the reader, a staff pick
    // from the list, a scanned QR code, or a typed member number.
    method: ['manual', 'qr', 'code', 'fingerprint'].includes(method) ? method : 'fingerprint'
  };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

// Three tiers, not two. A membership with four days left is not a problem yet
// and must not be shown as one -- but it is the last chance to renew it
// face-to-face, so it gets its own amber state between green and red rather
// than being lumped in with either.
function membershipVerdict(membership) {
  if (membership.status === 'frozen') {
    return {
      status: 'membership_frozen',
      label: 'Frozen',
      warning: 'MEMBERSHIP FROZEN — resume it at the desk before training'
    };
  }

  if (membership.status === 'past_due') {
    return {
      status: 'membership_past_due',
      label: 'Payment overdue',
      warning: 'CARD PAYMENT FAILED — ask the member to update their card'
    };
  }

  if (membership.status === 'active') {
    const days = membership.daysLeft;

    if (membership.sessionsLeft !== null && membership.sessionsLeft !== undefined) {
      return {
        status: membership.sessionsLeft <= 2 ? 'membership_expiring' : 'membership_active',
        label: `${plural(membership.sessionsLeft, 'session')} left`,
        warning: membership.sessionsLeft <= 2 ? `${plural(membership.sessionsLeft, 'SESSION').toUpperCase()} LEFT — offer a new pack` : null
      };
    }

    if (days !== null && days <= EXPIRY_WARNING_DAYS) {
      return {
        status: 'membership_expiring',
        label: `${plural(days, 'day')} left`,
        warning: `EXPIRES IN ${plural(days, 'DAY').toUpperCase()} — offer a renewal`
      };
    }

    return {
      status: 'membership_active',
      label: days === null ? 'Active' : `Active · ${plural(days, 'day')} left`,
      warning: null
    };
  }

  if (membership.status === 'expired') {
    // daysLeft is negative once the end date has passed, so its magnitude is
    // how long ago that was.
    const ago = membership.daysLeft === null ? null : Math.abs(membership.daysLeft);
    return {
      status: 'membership_expired',
      label: ago === null ? 'Expired' : `Expired ${plural(ago, 'day')} ago`,
      warning: 'MEMBERSHIP EXPIRED — renew before next visit'
    };
  }

  return {
    status: 'membership_none',
    label: 'No package on file',
    warning: 'NO ACTIVE MEMBERSHIP — sell a package at the desk'
  };
}

// The trainer's rostered hours for the weekday this shift is filed under.
// `availability` is the existing trainer field the website already edits, so
// staff attendance needs no second roster to keep in sync.
function scheduleFor(trainer, shiftDateKey) {
  const dayName = T.weekdayNameForKey(shiftDateKey);
  const slots = Array.isArray(trainer.availability) ? trainer.availability : [];
  const slot = slots.find((entry) => entry && entry.day === dayName);

  if (!slot || !slot.startTime || !slot.endTime) {
    return { hasSchedule: false, startTime: '', endTime: '' };
  }

  return { hasSchedule: true, startTime: slot.startTime, endTime: slot.endTime };
}

function arrivalVerdict(schedule, at) {
  if (!schedule.hasSchedule) {
    return { status: 'no_schedule', label: 'Not rostered today', variance: null };
  }

  const scheduled = T.parseClock(schedule.startTime);
  if (scheduled === null) {
    return { status: 'no_schedule', label: 'Roster time unreadable', variance: null };
  }

  const variance = T.minutesOfDay(at) - scheduled;

  if (variance <= 0) {
    return {
      status: variance === 0 ? 'on_time' : 'early',
      label: variance === 0 ? 'On time' : `Early by ${T.durationLabel(-variance)}`,
      variance
    };
  }

  if (variance <= LATE_GRACE_MINUTES) {
    return { status: 'on_time', label: 'On time', variance };
  }

  return { status: 'late', label: `Late by ${T.durationLabel(variance)}`, variance };
}

function departureVerdict(schedule, at) {
  if (!schedule.hasSchedule) {
    return { status: 'no_schedule', label: 'Not rostered today', variance: null };
  }

  const scheduled = T.parseClock(schedule.endTime);
  if (scheduled === null) {
    return { status: 'no_schedule', label: 'Roster time unreadable', variance: null };
  }

  let variance = T.minutesOfDay(at) - scheduled;

  // A night shift's end time is a smaller clock reading than its start. A
  // 06:00 finish on a 22:00-06:00 shift is 0 minutes late, not 960 early.
  const start = T.parseClock(schedule.startTime);
  if (start !== null && scheduled < start && variance < -12 * 60) {
    variance += 24 * 60;
  }

  if (variance < 0) {
    return { status: 'early', label: `Left ${T.durationLabel(-variance)} early`, variance };
  }
  if (variance === 0) return { status: 'on_time', label: 'On time', variance };
  if (variance <= LATE_GRACE_MINUTES) return { status: 'on_time', label: 'On time', variance };

  return { status: 'overtime', label: `Overtime ${T.durationLabel(variance)}`, variance };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

function row(caption, value) {
  return { caption, value: value === null || value === undefined || value === '' ? '—' : String(value) };
}

function recordedByLine(record, action) {
  const context = action === 'check_out' ? record.checkOut : record.checkIn;
  if (!context || !context.byName) return '—';

  return [context.byName, context.device].filter(Boolean).join('  ·  ');
}

// Shown only once the two halves genuinely differ -- the split-desk case the
// operator needs to see, rather than noise on a normal same-desk visit.
function splitLine(record) {
  if (!record.checkIn || !record.checkOut) return null;
  if (!record.checkIn.byName || !record.checkOut.byName) return null;

  const sameWho = record.checkIn.byName === record.checkOut.byName;
  const sameWhere = (record.checkIn.device || '') === (record.checkOut.device || '');
  if (sameWho && sameWhere) return null;

  const describe = (c) => [c.byName, c.device].filter(Boolean).join(' @ ');
  return `In: ${describe(record.checkIn)}   →   Out: ${describe(record.checkOut)}`;
}

async function visitsThisMonth(personId, shiftDate) {
  const monthPrefix = shiftDate.slice(0, 7); // 'YYYY-MM'
  return Attendance.countDocuments({
    personType: 'member',
    personId,
    shiftDate: new RegExp('^' + monthPrefix),
    checkInAt: { $ne: null }
  });
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

async function buildReceipt(record, action, person) {
  const rows = [];

  rows.push(row('Day', `${T.weekdayNameForKey(record.shiftDate)}, ${T.dateLabelForKey(record.shiftDate)}`));

  if (record.personType === 'member') {
    rows.push(row('Package', record.membership.packageName || 'None'));
    rows.push(
      row(
        record.membership.status === 'expired' ? 'Expired' : 'Valid to',
        record.membership.endDate ? T.dateLabel(record.membership.endDate) : '—'
      )
    );
  } else {
    rows.push(
      row(
        'Shift',
        record.schedule.hasSchedule
          ? `${record.schedule.startTime} - ${record.schedule.endTime}`
          : 'Not rostered'
      )
    );
  }

  rows.push(row('Check in', T.timeLabel(record.checkInAt)));
  rows.push(row('Check out', T.timeLabel(record.checkOutAt)));

  if (record.workedMinutes !== null && record.workedMinutes !== undefined) {
    rows.push(row(record.personType === 'member' ? 'Duration' : 'Worked', T.durationLabel(record.workedMinutes)));
  }

  if (record.personType === 'member') {
    const visits = await visitsThisMonth(record.personId, record.shiftDate);
    rows.push(row('Visit', `${ordinal(visits)} this month`));
  }

  rows.push(row('Status', record.statusLabel));
  rows.push(row('Recorded by', recordedByLine(record, action)));

  return {
    action,
    person_type: record.personType,
    person_name: record.personName,
    person_code: record.personCode,
    person_meta:
      record.personType === 'member'
        ? (record.membership.packageName || '')
        : (person && person.record && person.record.role) || '',

    day_name: T.weekdayNameForKey(record.shiftDate),
    date_label: T.dateLabelForKey(record.shiftDate),
    is_previous_day: record.shiftDate !== T.dateKey() ? 1 : 0,

    check_in_time: T.timeLabel(record.checkInAt),
    check_out_time: T.timeLabel(record.checkOutAt),
    worked_label: T.durationLabel(record.workedMinutes),

    status: record.status,
    status_label: record.statusLabel,
    // The one line the desk must act on, rendered in red above everything
    // else. Null on a normal visit.
    warning: record.warning || null,

    rows,
    footer: splitLine(record)
  };
}

// ---------------------------------------------------------------------------
// The punch itself
// ---------------------------------------------------------------------------

async function recordPunch({ personType, personId, operator, device, method = 'fingerprint' }) {
  const person = await resolvePerson(personType, personId);
  if (!person) {
    return {
      success: false,
      message: 'That person is no longer on file. Refresh the list and try again.'
    };
  }

  const now = new Date();
  const context = punchContext(operator, device, method);

  // An open visit is the whole state machine: if one exists this scan closes
  // it, otherwise this scan opens a new one.
  const openRecord = await Attendance.findOne({
    personType,
    personId: person.id,
    checkOutAt: null,
    checkInAt: { $gte: new Date(now.getTime() - OPEN_VISIT_HOURS * 60 * 60 * 1000) }
  }).sort({ checkInAt: -1 });

  // ---- Double-scan guard ----
  if (openRecord) {
    const sinceCheckIn = (now.getTime() - new Date(openRecord.checkInAt).getTime()) / 1000;
    if (sinceCheckIn < MIN_PUNCH_GAP_SECONDS) {
      const detail = await buildReceipt(openRecord, 'ignore', person);
      return {
        success: false,
        ignored: true,
        message: 'Already checked in a moment ago.',
        detail,
        person
      };
    }
  } else {
    const lastClosed = await Attendance.findOne({
      personType,
      personId: person.id,
      checkOutAt: { $ne: null }
    }).sort({ checkOutAt: -1 });

    if (lastClosed && (now.getTime() - new Date(lastClosed.checkOutAt).getTime()) / 1000 < MIN_PUNCH_GAP_SECONDS) {
      const detail = await buildReceipt(lastClosed, 'ignore', person);
      return {
        success: false,
        ignored: true,
        message: 'Already checked out a moment ago.',
        detail,
        person
      };
    }
  }

  // ---- Check out ----
  if (openRecord) {
    openRecord.checkOutAt = now;
    openRecord.checkOut = context;
    openRecord.workedMinutes = Math.round(
      (now.getTime() - new Date(openRecord.checkInAt).getTime()) / 60000
    );

    if (personType === 'staff') {
      const verdict = departureVerdict(openRecord.schedule, now);
      openRecord.status = verdict.status;
      openRecord.statusLabel = verdict.label;
      openRecord.varianceMinutes = verdict.variance;
    }
    // Members keep the membership verdict they arrived with: the receipt on
    // the way out should still say the visit was on an expired package.

    await openRecord.save();

    const detail = await buildReceipt(openRecord, 'check_out', person);
    detail.warning = personType === 'member' ? membershipWarningFor(openRecord) : null;

    return {
      success: true,
      action: 'check_out',
      message: 'Check-out recorded.',
      detail,
      person,
      record: openRecord
    };
  }

  // ---- Check in ----
  const shiftDate = T.dateKey(now);

  const record = new Attendance({
    personType,
    personId: person.id,
    personName: person.name,
    personCode: person.code,
    shiftDate,
    checkInAt: now,
    checkIn: context
  });

  if (personType === 'member') {
    const membership = await membershipFor(person.record);
    const verdict = membershipVerdict(membership);

    record.membership = {
      orderId: membership.orderId,
      packageName: membership.packageName,
      endDate: membership.endDate,
      status: membership.status
    };
    record.status = verdict.status;
    record.statusLabel = verdict.label;
  } else {
    const schedule = scheduleFor(person.record, shiftDate);
    const verdict = arrivalVerdict(schedule, now);

    record.schedule = schedule;
    record.status = verdict.status;
    record.statusLabel = verdict.label;
    record.varianceMinutes = verdict.variance;
  }

  await record.save();

  const detail = await buildReceipt(record, 'check_in', person);
  detail.warning = personType === 'member' ? membershipWarningFor(record) : null;

  return {
    success: true,
    action: 'check_in',
    message: 'Check-in recorded.',
    detail,
    person,
    record
  };
}

// Re-derived from the stored VERDICT rather than re-queried, so the check-out
// receipt repeats exactly what the check-in one said -- including the amber
// "expires in N days", which is the whole reason the desk would start the
// renewal conversation on the way out rather than the way in.
function membershipWarningFor(record) {
  if (!record.membership) return null;

  switch (record.status) {
    case 'membership_expired':
      return 'MEMBERSHIP EXPIRED — renew before next visit';
    case 'membership_none':
      return 'NO ACTIVE MEMBERSHIP — sell a package at the desk';
    case 'membership_expiring': {
      const end = record.membership.endDate;
      if (!end) return 'EXPIRES SOON — offer a renewal';
      const days = Math.max(0, Math.ceil((new Date(end).getTime() - Date.now()) / 864e5));
      return `EXPIRES IN ${plural(days, 'DAY').toUpperCase()} — offer a renewal`;
    }
    default:
      return null;
  }
}

// The verdict helpers are exported alongside recordPunch so anything that has
// to write an attendance row WITHOUT going through a live punch -- the seeder,
// or a future backfill -- reaches the same verdict this does. Duplicating the
// late/expired rules elsewhere is how the desk and the office start disagreeing.
module.exports = {
  recordPunch,
  MIN_PUNCH_GAP_SECONDS,
  membershipVerdict,
  scheduleFor,
  arrivalVerdict,
  departureVerdict
};
