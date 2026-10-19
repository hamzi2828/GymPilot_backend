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
const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Settings = require('../../models/settings');
const { resolvePerson, membershipFor } = require('./peopleDirectory');
const { OPEN_VISIT_HOURS, openVisitMatch, openVisitAtMatch, staffOpenUntil } = require('./staleVisits');
const { defaultCurrency } = require('../../services/currency');
const T = require('./timeUtils');

// A finger resting on the reader fires repeatedly, and a member who scans
// twice out of habit would otherwise be checked straight back out. Inside
// this window a second scan is reported as a no-op rather than acted on.
const MIN_PUNCH_GAP_SECONDS = Number(process.env.ATTENDANCE_MIN_PUNCH_GAP_SECONDS || 60);

// How far back a check-out may reach to find its own check-in is
// OPEN_VISIT_HOURS -- or, for staff, the visit's own `openUntil` -- defined
// in staleVisits.js: the same window decides who counts as "still inside"
// everywhere else, so the two cannot disagree.

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

function punchContext(operator, device, method, requestId, offline, matchScore) {
  return {
    // Only when the desk sent one (see repeatedPunch).
    ...(requestId ? { requestId } : {}),
    // A scan the desk queued while it had no connection and sent later, at
    // the time it was scanned (see readScannedAt).
    ...(offline ? { offline: true } : {}),
    // How close the face the camera saw was to the one on file (readMatchScore).
    ...(matchScore !== undefined ? { matchScore } : {}),
    by: operator._id,
    byName: operatorLabel(operator),
    device: device.deviceLabel || '',
    osUser: device.osUser || '',
    clientApp: device.clientApp || '',
    ip: device.ip || '',
    // The branch the signed-in desk account is set up for -- what the desk
    // shows in its header, recorded so each half of a visit says where.
    location: operator.attendanceLocation || '',
    // How the person was identified: a finger on the reader, a face at the
    // desk's camera, the desk's screen code scanned with their own phone, or
    // a staff pick from the list.
    method: ['manual', 'fingerprint', 'face', 'desk_code'].includes(method) ? method : 'fingerprint'
  };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

// Warnings keyed by verdict, shared by the verdict itself and by the
// check-out receipt, which re-derives its warning from the STORED verdict so
// both halves of a visit say the same thing.
const WARNINGS = {
  membership_frozen: 'MEMBERSHIP FROZEN — resume it at the desk before training',
  membership_past_due: 'CARD PAYMENT FAILED — ask the member to update their card',
  membership_pending: 'PAYMENT NOT CONFIRMED — check the transfer before admitting',
  membership_suspended: 'MEMBERSHIP SUSPENDED — speak to the manager before training',
  membership_cancelled: 'MEMBERSHIP CANCELLED — renew before next visit',
  membership_expired: 'MEMBERSHIP EXPIRED — renew before next visit',
  membership_none: 'NO ACTIVE MEMBERSHIP — sell a package at the desk'
};

// A paid membership whose first day is still ahead (membershipFor's
// 'pending' with `startsOn`). Not a refusal -- whether they train today is
// the gym's call -- but not a covered visit either, so the desk is told when
// it starts.
function startsLaterWarning(startsOn) {
  return `MEMBERSHIP STARTS ON ${T.dateLabel(startsOn).toUpperCase()} — paid, not started yet`;
}

function daysLeftOf(membership) {
  const days = membership.daysLeft;
  return days === null || days === undefined || Number.isNaN(Number(days)) ? null : Number(days);
}

// Three tiers, not two. A membership with four days left is not a problem yet
// and must not be shown as one -- but it is the last chance to renew it
// face-to-face, so it gets its own amber state between green and red rather
// than being lumped in with either.
//
// Every status membershipFor can answer has a verdict here, each with its own
// status key. The desktop app paints keys it does not know in grey, so a new
// key is always safe to add; a status that fell through to "no package on
// file" was not.
function membershipVerdict(membership) {
  const m = membership || {};
  const days = daysLeftOf(m);

  if (m.status === 'frozen') {
    return { status: 'membership_frozen', label: 'Frozen', warning: WARNINGS.membership_frozen };
  }

  if (m.status === 'past_due') {
    return { status: 'membership_past_due', label: 'Payment overdue', warning: WARNINGS.membership_past_due };
  }

  if (m.status === 'pending') {
    // Paid, starting later. The same key as waiting for the money -- amber
    // on the desk, the kiosk and the office, and a key the Windows app
    // already knows -- with its own words.
    if (m.startsOn) {
      return { status: 'membership_pending', label: `Starts on ${T.dateLabel(m.startsOn)}`, warning: startsLaterWarning(m.startsOn) };
    }
    return { status: 'membership_pending', label: 'Awaiting payment confirmation', warning: WARNINGS.membership_pending };
  }

  if (m.status === 'suspended') {
    return { status: 'membership_suspended', label: 'Suspended', warning: WARNINGS.membership_suspended };
  }

  if (m.status === 'cancelled') {
    // Cancelled but not yet ended: the member keeps what they paid for until
    // the end date, and the desk should say how long that is.
    if (days !== null && days > 0) {
      return {
        status: 'membership_cancelled',
        label: `Cancelled · ${plural(days, 'day')} left`,
        warning: `CANCELLED — ACCESS ENDS IN ${plural(days, 'DAY').toUpperCase()}`
      };
    }
    return { status: 'membership_cancelled', label: 'Cancelled', warning: WARNINGS.membership_cancelled };
  }

  if (m.status === 'active' || m.status === 'expiring') {
    if (m.sessionsLeft !== null && m.sessionsLeft !== undefined) {
      const low = m.sessionsLeft <= 2 || m.status === 'expiring';
      return {
        status: low ? 'membership_expiring' : 'membership_active',
        label: `${plural(m.sessionsLeft, 'session')} left`,
        warning: low ? `${plural(m.sessionsLeft, 'SESSION').toUpperCase()} LEFT — offer a new pack` : null
      };
    }

    if (days !== null && days <= EXPIRY_WARNING_DAYS) {
      // A subscription that will renew itself is not running out: there is
      // nothing to sell the member, so no amber and no warning -- only when
      // it renews. (`autoRenews` is found by the punch; see autoRenews.)
      if (m.autoRenews && m.endDate) {
        return {
          status: 'membership_active',
          label: `Renews automatically on ${T.dateLabel(m.endDate)}`,
          warning: null
        };
      }
      return {
        status: 'membership_expiring',
        label: `${plural(Math.max(0, days), 'day')} left`,
        warning: `EXPIRES IN ${plural(Math.max(0, days), 'DAY').toUpperCase()} — offer a renewal`
      };
    }

    if (m.status === 'expiring') {
      return { status: 'membership_expiring', label: 'Expiring soon', warning: 'EXPIRES SOON — offer a renewal' };
    }

    return {
      status: 'membership_active',
      label: days === null ? 'Active' : `Active · ${plural(days, 'day')} left`,
      warning: null
    };
  }

  if (m.status === 'expired') {
    // Over with its end date still ahead: a session pack with every session
    // used. It is as over as a lapsed one -- same key, same warning -- but it
    // did not end "30 days ago", which is what the magnitude below would say.
    if (days !== null && days > 0) {
      return {
        status: 'membership_expired',
        label: `No sessions left · ends in ${plural(days, 'day')}`,
        warning: WARNINGS.membership_expired
      };
    }
    // daysLeft is negative once the end date has passed, so its magnitude is
    // how long ago that was.
    const ago = days === null ? null : Math.abs(days);
    return {
      status: 'membership_expired',
      label: ago === null ? 'Expired' : `Expired ${plural(ago, 'day')} ago`,
      warning: WARNINGS.membership_expired
    };
  }

  return { status: 'membership_none', label: 'No package on file', warning: WARNINGS.membership_none };
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

// What the desk calls a visit: how a staff shift ended once it has, and
// otherwise the arrival (or membership) verdict. Only the wording changes --
// the arrival verdict stays on the row, where the office counts it.
function currentVerdict(record) {
  if (record.personType === 'staff' && record.checkOutAt && record.departureStatus) {
    return { status: record.departureStatus, label: record.departureLabel };
  }
  return { status: record.status, label: record.statusLabel };
}

async function buildReceipt(record, action, person) {
  const rows = [];
  const verdict = currentVerdict(record);

  rows.push(row('Day', `${T.weekdayNameForKey(record.shiftDate)}, ${T.dateLabelForKey(record.shiftDate)}`));

  if (record.personType === 'member') {
    const m = record.membership || {};
    rows.push(row('Package', m.packageName || 'None'));
    if (m.status === 'pending' && m.startsOn) {
      rows.push(row('Starts', T.dateLabel(m.startsOn)));
      rows.push(row('Valid to', m.endDate ? T.dateLabel(m.endDate) : '—'));
    } else if (m.status === 'pending') {
      // No dates to show yet: the term starts when staff confirm the money.
      rows.push(row('Payment', 'Awaiting payment confirmation'));
    } else {
      rows.push(
        row(
          m.status === 'expired' ? 'Expired' : m.status === 'cancelled' ? 'Access until' : 'Valid to',
          m.endDate ? T.dateLabel(m.endDate) : '—'
        )
      );
    }
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

  if (verdict.label !== record.statusLabel) {
    // A check-out receipt is judged on the departure; the arrival still
    // deserves its line, or a late start disappears at the end of the shift.
    rows.push(row('Arrival', record.statusLabel));
  }
  rows.push(row('Status', verdict.label));
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

    status: verdict.status,
    status_label: verdict.label,
    // The one line the desk must act on, rendered in red above everything
    // else. Null on a normal visit.
    warning: record.warning || null,
    // The sound and the words for a recorded member punch (memberAlert);
    // null for staff and for a repeat scan, which each client handles itself.
    alert: null,
    // Money still owed on the member's package when they walked in: never a
    // reason to refuse the visit, always one to say so (see memberWarning).
    balance_due: record.personType === 'member' ? balanceDueOf(record) : 0,
    balance_due_label: record.personType === 'member' ? balanceDueLabel(record) : null,

    rows,
    footer: splitLine(record)
  };
}

// ---------------------------------------------------------------------------
// The punch itself
// ---------------------------------------------------------------------------

// The answer to a scan that lands while the person's check-in is still fresh:
// a second scan out of habit, a finger left on the reader, or another desk's
// scan arriving at the same moment. The visit's receipt, and nothing recorded.
async function alreadyCheckedIn(record, person) {
  const detail = await buildReceipt(record, 'ignore', person);
  return {
    success: false,
    ignored: true,
    message: 'Already checked in a moment ago.',
    detail,
    person
  };
}

// Its twin for a check-out that has just happened: a repeat scan on the way
// out, or a second desk scanning the same person as the first checked them
// out. Either way one desk prints the check-out and the other prints this.
async function alreadyCheckedOut(record, person) {
  const detail = await buildReceipt(record, 'ignore', person);
  return {
    success: false,
    ignored: true,
    message: 'Already checked out a moment ago.',
    detail,
    person
  };
}

// A queued scan whose moment falls inside a visit another desk recorded from
// start to finish while this one was offline: they were already inside then,
// in and out on record. Nothing to add -- not a new visit, and not the
// check-out of one that has its own -- so nothing is recorded, and the answer
// says why in its own words and `code` rather than "a moment ago".
async function alreadyOnRecord(record, person) {
  const detail = await buildReceipt(record, 'ignore', person);
  return {
    success: false,
    ignored: true,
    code: 'INSIDE_RECORDED_VISIT',
    message: `Already on record: checked in at ${T.timeLabel(record.checkInAt)} and out at ${T.timeLabel(record.checkOutAt)}.`,
    detail,
    person
  };
}

// What the desk says out loud when a gym has not worded it itself (Settings
// attendance.voice). Also what a message left blank goes back to, so clearing
// a field can never leave the desk announcing an empty string.
const VOICE_DEFAULTS = {
  enabled: true,
  expiredMessage: 'Fee expired, please renew',
  expiringMessage: 'Your fee expires soon',
  balanceDueMessage: 'Please clear your balance'
};

const VOICE_MESSAGES = ['expiredMessage', 'expiringMessage', 'balanceDueMessage'];

// The gym's voice settings with every gap filled: a gym that has never saved
// them (no `voice` on its settings row at all) reads exactly the defaults.
function voiceSettings(stored) {
  const voice = stored || {};
  const out = { enabled: voice.enabled !== false };
  for (const key of VOICE_MESSAGES) {
    const text = typeof voice[key] === 'string' ? voice[key].trim() : '';
    out[key] = text || VOICE_DEFAULTS[key];
  }
  return out;
}

// The gym's attendance settings, read from the settings row every time rather
// than cached, so a change on the website takes effect at the very next scan
// on every server.
async function attendanceSettings() {
  const settings = await Settings.findOne({ isActive: true }).select('attendance').lean();
  const attendance = (settings && settings.attendance) || {};
  return {
    memberScanOut: attendance.memberScanOut !== false,
    refuseEntry: refuseEntrySettings(attendance.refuseEntry),
    voice: voiceSettings(attendance.voice)
  };
}

// Who the gym turns away at the door (Settings attendance.refuseEntry). Each
// is off unless the gym has switched it on: the desk warns, and lets them in.
function refuseEntrySettings(stored) {
  const rules = stored || {};
  return {
    expired: rules.expired === true,
    unpaid: rules.unpaid === true,
    noPackage: rules.noPackage === true
  };
}

// Whether this gym asks members to scan on the way OUT as well as in
// (Settings attendance.memberScanOut, default yes). Where members only scan
// in, a member's second scan of the day is their next visit, not the end of
// the first. Read on the one scan that needs it -- a member's scan while a
// visit is open.
async function memberScanOut() {
  return (await attendanceSettings()).memberScanOut;
}

// Whether the membership the desk is about to warn about will simply renew:
// a Stripe subscription nobody has asked to cancel at the period's end. The
// rule is reminderJobs.willAutoRenew -- the one that also keeps the renewal
// reminder email from going out -- so the desk and the reminders agree.
// (Required here, not at the top: it is a job module with its own
// dependencies.) Only asked inside the warning window, so an ordinary
// check-in pays nothing for it.
async function autoRenews(membership) {
  const m = membership || {};
  const days = daysLeftOf(m);
  if (m.status !== 'active' || !m.orderId || days === null || days > EXPIRY_WARNING_DAYS) return false;
  if (m.sessionsLeft !== null && m.sessionsLeft !== undefined) return false;

  const order = await PackageOrder.findById(m.orderId)
    .select('payment.stripeSubscriptionId subscription.autoRenew subscription.cancelAtPeriodEnd subscription.stripeStatus')
    .lean();
  const { willAutoRenew } = require('../../services/reminderJobs');
  return willAutoRenew(order);
}

// ---------------------------------------------------------------------------
// A punch sent again
//
// The desk records a punch and the answer never arrives -- a timeout, a
// dropped connection. It shows "Not recorded", the person scans again, and
// more than a minute later that second scan would be taken for the way out.
// So the desk may send `request_id` with a punch: any id it makes up for that
// one attempt, sent again unchanged when it tries the same person again. The
// id is kept on the half of the visit the punch recorded (checkIn.requestId
// or checkOut.requestId); when it arrives again the first answer is given
// back with `repeated: true` and nothing is recorded. Left out, every punch
// is new, as before.
//
// Only a punch that recorded something is remembered: one that was answered
// "already checked in a moment ago" changed nothing, and is judged afresh.
// ---------------------------------------------------------------------------

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

// How far back an id is looked for, in gym days. A retry comes minutes after
// the punch it repeats; this only keeps the lookup to the person's last few
// visits.
const REPEAT_LOOKBACK_DAYS = 2;

/**
 * The `request_id` a punch carries: undefined when it has none, null when it
 * is not one (the caller refuses the punch).
 */
function readRequestId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const id = String(value).trim();
  return REQUEST_ID.test(id) ? id : null;
}

/**
 * The `match_score` a face punch carries -- the desk's cosine similarity
 * between the face it saw and the one on file -- rounded to three places:
 * undefined when it has none, null when it is not a number from 0 to 1 (the
 * caller refuses the punch). Kept with the visit so an office looking at a
 * doubtful check-in can see how sure the desk was.
 */
function readMatchScore(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const score = Math.round(value * 1000) / 1000;
  // `|| 0`: a rounded -0.0004 is a score of 0, not -0.
  return score >= 0 && score <= 1 ? score || 0 : null;
}

// The visit as it stood when it was opened, for answering a repeated
// check-in after the person has since checked out.
function asCheckedIn(record) {
  if (!record.checkOutAt) return record;
  const visit = record.toObject();
  visit.checkOutAt = null;
  visit.checkOut = {};
  visit.workedMinutes = null;
  return visit;
}

// The answer the punch with this id was given, or null when no punch of this
// person's recorded anything under it.
async function repeatedPunch(requestId, { personType, personIds, person, now, settings }) {
  if (!requestId) return null;
  const visit = await Attendance.findOne({
    personType,
    personId: { $in: personIds },
    shiftDate: { $gte: T.dateKey(new Date(now.getTime() - REPEAT_LOOKBACK_DAYS * 86400000)) },
    $or: [{ 'checkIn.requestId': requestId }, { 'checkOut.requestId': requestId }]
  }).sort({ checkInAt: -1 });
  if (!visit) return null;

  const action = visit.checkIn && visit.checkIn.requestId === requestId ? 'check_in' : 'check_out';
  const record = action === 'check_in' ? asCheckedIn(visit) : visit;
  const detail = await buildReceipt(record, action, person);
  detail.warning = personType === 'member' ? memberWarning(record) : null;
  detail.alert = personType === 'member' ? memberAlert(record, (await settings()).voice) : null;
  // The first answer's flag for a check-in an offline desk let in against
  // the rules, given again with it.
  const admitted = action === 'check_in' ? admittedOfflineOf(record) : {};
  if (admitted.admittedOffline) admittedOfflineDetail(detail, record);

  return {
    success: true,
    repeated: true,
    action,
    message: action === 'check_in' ? 'Check-in recorded.' + admittedOfflineNote(record) : 'Check-out recorded.',
    ...admitted,
    detail,
    person,
    record: visit
  };
}

// ---------------------------------------------------------------------------
// A scan sent late
//
// The Windows desk keeps matching fingers while its connection is down and
// queues each punch on disk, then sends them oldest-first when it is back.
// Each one carries `scanned_at`, the moment the finger was on the reader, and
// that is the punch's time -- otherwise a morning's queue sent at noon would
// all check in at noon, and the second scan of each person would be taken for
// a check-out a second later. Only a staff desk may send it (the controller
// refuses it from a web kiosk), only with a request_id (so a queue sent twice
// records once), and only inside a window: not more than a few minutes ahead
// of this server's clock, and not older than OFFLINE_MAX_HOURS.
//
// By the time it arrives other desks may have recorded this person since, and
// the daily job may have closed a visit as forgotten. So a queued scan is
// placed among what is on record by its own time, never by "now":
//
//   * a visit open at the scan time closes at the scan time -- even one the
//     daily job marked auto-closed after it (staleVisits.openVisitAtMatch),
//     whose marks the check-out then clears;
//   * a scan within MIN_PUNCH_GAP_SECONDS of a punch on either side of it is
//     that punch's repeat, as a live double scan is;
//   * a scan inside a visit recorded in and out around it adds nothing:
//     nothing recorded, answered INSIDE_RECORDED_VISIT (alreadyOnRecord);
//   * otherwise it is a check-in at the scan time. When the person has a
//     visit that began after it, this is an earlier, separate visit: it is
//     recorded, but closed as "No check-out" (auto-closed from the moment the
//     next visit began) rather than left open -- the next visit is the one a
//     scan now would close. A later queued scan before that moment still
//     closes it properly.
// ---------------------------------------------------------------------------

const OFFLINE_MAX_HOURS = Number(process.env.ATTENDANCE_OFFLINE_MAX_HOURS || 72);
const CLOCK_SKEW_SECONDS = 120;

/**
 * The `scanned_at` a punch carries: undefined when it has none, otherwise
 * { at } -- the time to record, never later than `now` -- or { error }, the
 * reason it is refused.
 */
function readScannedAt(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return undefined;
  const at = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(at.getTime())) {
    return { error: 'scanned_at must be a date and time, e.g. 2026-10-15T09:30:00Z.' };
  }
  const ahead = at.getTime() - now.getTime();
  if (ahead > CLOCK_SKEW_SECONDS * 1000) {
    return { error: "scanned_at is in the future. Check the date and time on the desk PC." };
  }
  if (-ahead > OFFLINE_MAX_HOURS * 3600000) {
    return {
      error: `This scan is more than ${OFFLINE_MAX_HOURS} hours old, so it was not recorded. ` +
        'Add the visit from the attendance page if it is needed.'
    };
  }
  // A desk clock a little fast is this moment, not the future.
  return { at: ahead > 0 ? now : at };
}

// ---------------------------------------------------------------------------
// Turned away at the door
//
// A gym may refuse entry instead of warning (Settings attendance.refuseEntry):
// to an expired membership, to money owing, to someone with no package at
// all. A refused scan records nothing -- no visit, no time -- and answers
// `success: false, refused: true` with the reason, so the desk and the kiosk
// can say "Entry refused" in red with the problem sound. Only a check-in is
// ever refused: someone already inside can always scan out.
//
// Except a punch the desk queued offline. That desk could not ask, so it let
// the person in: the visit happened, and refusing the punch now would only
// lose it. It is recorded with its verdict, flagged (`entryRefusal` on the
// visit; `admitted_offline` and `reason` in the answer) so the office sees
// the rule was not applied at the door.
// ---------------------------------------------------------------------------

// The member's membership as this scan finds it, with the verdict the desk
// shows and the money owing. One read, shared by the refusal and the check-in.
// `at` is the scan's own time: a punch the desk queued offline is judged on
// the membership the person had when they were scanned, not on the one they
// have when it arrives.
async function memberStanding(person, at = new Date()) {
  const membership = await membershipFor(person.record, { at });
  const verdict = membershipVerdict({ ...membership, autoRenews: await autoRenews(membership) });
  const balanceDue = Number(membership.balanceDue ?? 0) > 0 ? Number(membership.balanceDue) : 0;
  return {
    verdict,
    membership: {
      orderId: membership.orderId,
      packageName: membership.packageName,
      endDate: membership.endDate,
      status: membership.status,
      // Kept so the check-out, the office and the day's board can tell a
      // membership starting later from one waiting on its money.
      startsOn: membership.startsOn || null,
      balanceDue,
      // The order's own currency; the gym's only when the order names none
      // and there is money to put a currency on.
      currency: membership.currency || (balanceDue > 0 ? await defaultCurrency() : '')
    },
    daysLeft: daysLeftOf(membership),
    // Under an order still awaiting payment: what the paid orders alone say
    // (peopleDirectory's `paidTerm`). Asked by entryRefusal, not stored.
    paidTerm: membership.paidTerm || null
  };
}

// Why this member is refused under the gym's rules, or null to let them in.
// `reason` is the machine key; `text` is what the desk reads out.
//
// An order still waiting for its money -- a bank transfer staff have not
// confirmed, a desk sale recorded unpaid -- leads the verdict ("Awaiting
// payment confirmation"), but it is not money the gym has. So with `unpaid`
// on it counts as unpaid, and `expired` and `noPackage` are judged on the
// PAID orders beneath it (`paidTerm`): ordering a renewal and not paying for
// it is no way past either. A paid membership that simply starts on a later
// date ("Starts on …", `startsOn`) is none of these.
function entryRefusal(standing, rules) {
  if (!standing || !rules) return null;
  const status = standing.verdict.status;
  const awaiting = status === 'membership_pending' && !standing.membership.startsOn;
  const paid = awaiting ? standing.paidTerm || { status: 'none', daysLeft: null } : null;

  if (rules.noPackage) {
    if (status === 'membership_none') return { reason: 'no_package', text: 'No active membership' };
    if (paid && paid.status === 'none') return { reason: 'no_package', text: 'No paid membership — payment not confirmed' };
  }
  if (rules.expired) {
    if (status === 'membership_expired') return { reason: 'expired', text: 'Membership expired' };
    // Cancelled with nothing left to run: as over as expired.
    if (status === 'membership_cancelled' && !(standing.daysLeft > 0)) {
      return { reason: 'expired', text: 'Membership cancelled and ended' };
    }
    if (paid && paid.status === 'expired') {
      return { reason: 'expired', text: 'Membership expired — renewal not paid yet' };
    }
  }
  if (rules.unpaid) {
    if (status === 'membership_past_due') return { reason: 'unpaid', text: 'Card payment failed' };
    if (standing.membership.balanceDue > 0) {
      return { reason: 'unpaid', text: `Balance due ${moneyLabel(standing.membership.balanceDue, standing.membership.currency)}` };
    }
    // Unless a paid term still covers today: cancelled, with days left on it.
    if (paid && !(paid.status === 'cancelled' && paid.daysLeft > 0)) {
      return { reason: 'unpaid', text: 'Payment not confirmed' };
    }
  }
  return null;
}

// Rows that describe a visit; a refused scan has none.
const VISIT_ROWS = new Set(['Check in', 'Check out', 'Visit', 'Duration', 'Recorded by']);

// The answer to a refused scan: who it was and why, on the same receipt the
// desk shows for a punch, with nothing saved.
async function refusedEntry({ person, standing, refusal, at, voice }) {
  const record = new Attendance({
    personType: 'member',
    personId: person.id,
    personName: person.name,
    personCode: person.code,
    shiftDate: T.dateKey(at),
    membership: standing.membership,
    status: standing.verdict.status,
    statusLabel: standing.verdict.label
  });

  const detail = await buildReceipt(record, 'refused', person);
  detail.rows = detail.rows.filter((r) => !VISIT_ROWS.has(r.caption));
  detail.refused = true;
  detail.refusal_reason = refusal.reason;
  detail.warning = `ENTRY REFUSED — ${refusal.text}`;
  // Always the problem sound, with whichever of the gym's words fits.
  const alert = memberAlert(record, voice);
  detail.alert = { level: 'problem', speech: alert ? alert.speech : null };

  return {
    success: false,
    refused: true,
    reason: refusal.reason,
    message: `Entry refused — ${refusal.text}.`,
    detail,
    person
  };
}

async function recordPunch({ personType, personId, operator, device, method = 'fingerprint', requestId, scannedAt, matchScore }) {
  const person = await resolvePerson(personType, personId);
  if (!person) {
    return {
      success: false,
      message: 'That person is no longer on file. Refresh the list and try again.'
    };
  }

  // A queued scan is judged at the moment it was scanned (see readScannedAt).
  const now = scannedAt || new Date();
  const context = punchContext(operator, device, method, requestId, Boolean(scannedAt), matchScore);
  // The gym's attendance settings, read at most once per scan and only by a
  // scan that needs them (see attendanceSettings).
  let settingsRead = null;
  const gymSettings = () => settingsRead || (settingsRead = attendanceSettings());

  // An open visit is the whole state machine: if one exists this scan closes
  // it, otherwise this scan opens a new one. Found by checkOutAt and the
  // window, not by the `open` flag: a visit opened before the flag existed is
  // still one this scan should close. A staff member who is also a trainer
  // may have a visit open under the trainer record's id (aliasIds, see
  // peopleDirectory) from before the two were treated as one person; this
  // scan closes that visit rather than opening a second one.
  const personIds = [person.id, ...(person.aliasIds || [])];

  // This very punch, sent again because its answer was lost: the same answer,
  // and nothing recorded (see repeatedPunch).
  const repeat = await repeatedPunch(requestId, { personType, personIds, person, now, settings: gymSettings });
  if (repeat) return repeat;

  // Open at the punch's own time: for a queued scan, as things stood when it
  // was scanned (see "A scan sent late").
  const openMatch = scannedAt ? openVisitAtMatch(now) : openVisitMatch(now);
  const mine = { personType, personId: { $in: personIds } };

  let openRecord = await Attendance.findOne({ ...mine, ...openMatch }).sort({ checkInAt: -1 });

  // A queued scan's next visit: the first that began after it, if any.
  let nextVisit = null;

  // ---- Double-scan guard ----
  if (openRecord) {
    const sinceCheckIn = (now.getTime() - new Date(openRecord.checkInAt).getTime()) / 1000;
    if (sinceCheckIn < MIN_PUNCH_GAP_SECONDS) {
      return alreadyCheckedIn(openRecord, person);
    }
  } else {
    // Closed by the punch's time: a queued scan is not the repeat of a
    // check-out that came after it.
    const lastClosed = await Attendance.findOne({
      ...mine,
      checkOutAt: scannedAt ? { $ne: null, $lte: now } : { $ne: null }
    }).sort({ checkOutAt: -1 });

    if (lastClosed && (now.getTime() - new Date(lastClosed.checkOutAt).getTime()) / 1000 < MIN_PUNCH_GAP_SECONDS) {
      return alreadyCheckedOut(lastClosed, person);
    }

    if (scannedAt) {
      // In and out on record around the scan: nothing to add.
      const around = await Attendance.findOne({ ...mine, checkInAt: { $lte: now }, checkOutAt: { $gt: now } }).sort({
        checkInAt: -1
      });
      if (around) return alreadyOnRecord(around, person);

      nextVisit = await Attendance.findOne({ ...mine, checkInAt: { $gt: now } }).sort({ checkInAt: 1 });
      // Checked in at another desk seconds after this scan: the same arrival.
      if (nextVisit && (new Date(nextVisit.checkInAt).getTime() - now.getTime()) / 1000 < MIN_PUNCH_GAP_SECONDS) {
        return alreadyCheckedIn(nextVisit, person);
      }
    }
  }

  // ---- Refused at the door ----
  // A member's scan that is about to open a visit -- none open, or a gym
  // where members only scan in -- is checked against the gym's entry rules
  // first, before anything (the old visit included) is touched.
  let standing = null;
  // A queued scan the rules would have refused: let in by an offline desk,
  // so recorded and flagged instead (see "Turned away at the door").
  let admittedOffline = null;
  if (personType === 'member' && (!openRecord || !(await gymSettings()).memberScanOut)) {
    standing = await memberStanding(person, now);
    const refusal = entryRefusal(standing, (await gymSettings()).refuseEntry);
    if (refusal && !scannedAt) {
      return refusedEntry({ person, standing, refusal, at: now, voice: (await gymSettings()).voice });
    }
    admittedOffline = refusal;
  }

  // ---- Members who only scan in ----
  // Where the gym does not ask members to scan out, this scan is a new visit.
  // The one still open is closed the way the daily job closes a forgotten
  // visit -- no check-out time and no duration invented -- which also gives
  // up its one-open-visit slot for the check-in below. Conditional, so a
  // visit another desk has just closed is left as that desk left it. (A
  // queued scan may find the visit marked auto-closed after its own time;
  // it ended at this scan, which is said instead.)
  if (openRecord && personType === 'member' && !(await gymSettings()).memberScanOut) {
    await Attendance.updateOne(
      { _id: openRecord._id, checkOutAt: null, $or: [{ autoClosed: { $ne: true } }, { autoClosedAt: { $gt: now } }] },
      { $set: { autoClosed: true, autoClosedAt: now }, $unset: { open: '' } }
    );
    openRecord = null;
    if (scannedAt) {
      nextVisit = await Attendance.findOne({ ...mine, checkInAt: { $gt: now } }).sort({ checkInAt: 1 });
    }
  }

  // ---- Check out ----
  if (openRecord) {
    openRecord.checkOutAt = now;
    openRecord.checkOut = context;
    // The visit is over: it gives up the one-open-visit slot, so the next
    // check-in can take it. (Absent rather than false -- see the model.)
    openRecord.open = undefined;
    // Closed by a queued scan after the daily job had given up on it: it has
    // its check-out now, so it is no longer one without.
    if (openRecord.autoClosed) {
      openRecord.autoClosed = false;
      openRecord.autoClosedAt = null;
    }
    openRecord.workedMinutes = Math.round(
      (now.getTime() - new Date(openRecord.checkInAt).getTime()) / 60000
    );

    if (personType === 'staff') {
      // Into its own fields: status keeps the arrival verdict, so a late
      // start is still a late start after an on-time finish.
      const verdict = departureVerdict(openRecord.schedule, now);
      openRecord.departureStatus = verdict.status;
      openRecord.departureLabel = verdict.label;
      openRecord.departureVarianceMinutes = verdict.variance;
    }
    // Members keep the membership verdict they arrived with: the receipt on
    // the way out should still say the visit was on an expired package.

    // Only if nobody has checked this visit out since it was read. Two desks
    // scanning someone who is inside both find the visit open; without this
    // both would save a check-out and both would print one. The second save
    // matches nothing, and that desk is told it was the repeat.
    openRecord.$where = { checkOutAt: null };
    try {
      await openRecord.save();
    } catch (error) {
      if (error && error.name === 'DocumentNotFoundError') {
        const winner = await Attendance.findById(openRecord._id);
        if (winner && winner.checkOutAt) return alreadyCheckedOut(winner, person);
      }
      throw error;
    }

    const detail = await buildReceipt(openRecord, 'check_out', person);
    detail.warning = personType === 'member' ? memberWarning(openRecord) : null;
    detail.alert = personType === 'member' ? memberAlert(openRecord, (await gymSettings()).voice) : null;

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
    checkIn: context,
    open: true
  });

  // A queued scan from before the person's latest visit: an earlier visit of
  // its own, never the open one (see "A scan sent late").
  const placeBefore = (later) => {
    record.open = undefined;
    record.autoClosed = true;
    record.autoClosedAt = later.checkInAt;
  };
  if (nextVisit) placeBefore(nextVisit);

  if (personType === 'member') {
    // Read above, before the entry rules were asked (see memberStanding).
    const { membership, verdict } = standing || (await memberStanding(person, now));
    record.membership = membership;
    record.status = verdict.status;
    record.statusLabel = verdict.label;
    if (admittedOffline) record.entryRefusal = { reason: admittedOffline.reason, text: admittedOffline.text };
  } else {
    const schedule = scheduleFor(person.record, shiftDate);
    const verdict = arrivalVerdict(schedule, now);

    record.schedule = schedule;
    record.status = verdict.status;
    record.statusLabel = verdict.label;
    record.varianceMinutes = verdict.variance;
    // Open until the rostered shift is over, not for a member's 18 hours: a
    // forgotten check-out must not be closed by tomorrow's arrival.
    record.openUntil = staffOpenUntil(schedule, now, shiftDate);
  }

  // A visit the lookup above did not count as open -- typically yesterday's,
  // never checked out, that the daily job has not closed yet -- may still
  // hold the one-open-visit slot and would refuse this check-in on the index.
  // The lookup has already ruled it over, so it lets go. Exactly the lookup's
  // complement ($nor): a row inside the window is never released, because
  // that is another scan that has just checked this person in. It is not
  // marked auto-closed here; that stays the job's call. (Not for an earlier
  // visit placed behind a later one: that takes no slot, and the later one
  // keeps its own.)
  if (record.open) {
    await Attendance.updateMany(
      { personType, personId: person.id, open: true, $nor: [openMatch] },
      { $unset: { open: '' } }
    );
  }

  try {
    await record.save();
  } catch (error) {
    // Another scan for this person checked them in between the lookup above
    // and this insert. Theirs is the visit; this scan is the repeat -- unless
    // this is a queued scan from before theirs, which is still its own,
    // earlier visit. Anything else -- including a clash whose winner cannot
    // be found -- is a real failure and goes up.
    if (error && error.code === 11000) {
      const winner = await Attendance.findOne({ personType, personId: person.id, open: true });
      if (winner && scannedAt && new Date(winner.checkInAt).getTime() - now.getTime() >= MIN_PUNCH_GAP_SECONDS * 1000) {
        placeBefore(winner);
        await record.save();
      } else if (winner) {
        return alreadyCheckedIn(winner, person);
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  const detail = await buildReceipt(record, 'check_in', person);
  detail.warning = personType === 'member' ? memberWarning(record) : null;
  detail.alert = personType === 'member' ? memberAlert(record, (await gymSettings()).voice) : null;
  admittedOfflineDetail(detail, record);

  return {
    success: true,
    action: 'check_in',
    message:
      (record.autoClosed
        ? 'Check-in recorded as an earlier visit, with no check-out: they have been checked in since.'
        : 'Check-in recorded.') + admittedOfflineNote(record),
    ...admittedOfflineOf(record),
    detail,
    person,
    record
  };
}

// The flag recordPunch's answer carries for such a check-in.
function admittedOfflineOf(record) {
  const refusal = record && record.entryRefusal;
  return refusal && refusal.reason ? { admittedOffline: { reason: refusal.reason, text: refusal.text || '' } } : {};
}

// What a check-in let in by an offline desk against the gym's rules says on
// its receipt and in its answer (see "Turned away at the door"): the warning
// line names the rule, so whoever reads it knows it was not applied.
function admittedOfflineDetail(detail, record) {
  if (!record.entryRefusal) return;
  detail.admitted_offline = true;
  detail.refusal_reason = record.entryRefusal.reason;
  detail.warning = `LET IN OFFLINE — ${record.entryRefusal.text}`;
}

function admittedOfflineNote(record) {
  return record.entryRefusal
    ? ` The desk was offline and let them in; the gym's entry rules refuse this (${record.entryRefusal.text}).`
    : '';
}

// Re-derived from the stored VERDICT rather than re-queried, so the check-out
// receipt repeats exactly what the check-in one said -- including the amber
// "expires in N days", which is the whole reason the desk would start the
// renewal conversation on the way out rather than the way in.
function membershipWarningFor(record) {
  if (!record.membership) return null;

  switch (record.status) {
    case 'membership_expiring': {
      const end = record.membership.endDate;
      if (!end) return 'EXPIRES SOON — offer a renewal';
      const days = Math.max(0, Math.ceil((new Date(end).getTime() - Date.now()) / 864e5));
      return `EXPIRES IN ${plural(days, 'DAY').toUpperCase()} — offer a renewal`;
    }
    case 'membership_cancelled': {
      const end = record.membership.endDate;
      const days = end ? Math.ceil((new Date(end).getTime() - Date.now()) / 864e5) : 0;
      return days > 0 ? `CANCELLED — ACCESS ENDS IN ${plural(days, 'DAY').toUpperCase()}` : WARNINGS.membership_cancelled;
    }
    case 'membership_pending':
      return startsLater(record) ? startsLaterWarning(record.membership.startsOn) : WARNINGS.membership_pending;
    default:
      // Frozen, past due, pending, suspended, expired, none -- or nothing at
      // all for a plain active visit.
      return WARNINGS[record.status] || null;
  }
}

// ---------------------------------------------------------------------------
// The alert: what the desk and the kiosk play and say
// ---------------------------------------------------------------------------

// Membership verdicts the desk has to act on before the member trains:
// nothing paid and in date (expired, none, cancelled and run out), money
// that has not arrived (past due, pending), or a membership on hold (frozen,
// suspended). They share one sound, distinct from "expiring".
const PROBLEM_VERDICTS = new Set([
  'membership_expired',
  'membership_none',
  'membership_frozen',
  'membership_past_due',
  'membership_pending',
  'membership_suspended'
]);

// The problems the gym's "fee expired" message is true of. Frozen, suspended
// and pending get the sound but no words: the member has paid, or it is the
// manager's call, and telling them to renew would be wrong.
const SAY_EXPIRED = new Set(['membership_expired', 'membership_none', 'membership_past_due', 'membership_cancelled']);

// The visit was on a paid membership that had not started yet: stored as
// 'membership_pending' with the date it starts (see startsLaterWarning).
function startsLater(record) {
  return record.status === 'membership_pending' && !!(record.membership && record.membership.startsOn);
}

// '5 October' in the gym's zone: a date as it is said -- the printed
// '05 Oct 2026' reads out as "oh five Oct".
function spokenDate(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: T.timezone(), day: 'numeric', month: 'long' }).format(new Date(date));
}

function joinSpeech(parts) {
  const said = parts.filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
  if (!said.length) return null;
  if (said.length === 1) return said[0];
  // Two messages are two sentences, so the voice pauses between them.
  return said.map((part) => (/[.!?]$/.test(part) ? part : part + '.')).join(' ');
}

/**
 * The sound and the words for a member's punch, from the verdict stored on
 * the visit -- so the check-out repeats what the check-in said, as the
 * warning does (membershipWarningFor):
 *
 *   level    'ok' | 'warning' | 'problem' -- which of the three sounds
 *   speech   the gym's message to speak after it, or null (none applies, or
 *            the gym has the voice off)
 *
 * Decided here, not in each client, so the Windows desk and the web kiosk
 * cannot disagree about which sound a frozen member gets. Staff have no
 * membership and no alert (null): each client keeps its own sounds for them.
 */
function memberAlert(record, voice) {
  if (!record || record.personType !== 'member') return null;
  const settings = voice || VOICE_DEFAULTS;
  const status = record.status;
  const end = record.membership && record.membership.endDate;
  const daysLeft = end ? Math.ceil((new Date(end).getTime() - Date.now()) / 864e5) : 0;

  let level = 'ok';
  let say = null;

  if (startsLater(record)) {
    // Paid, only not started: a word at the desk, not a problem. None of the
    // gym's fee messages is true of it, so the start date is said instead.
    level = 'warning';
    say = `Your membership starts on ${spokenDate(record.membership.startsOn)}`;
  } else if (PROBLEM_VERDICTS.has(status) || (status === 'membership_cancelled' && daysLeft <= 0)) {
    level = 'problem';
    if (SAY_EXPIRED.has(status)) say = settings.expiredMessage;
  } else if (status === 'membership_expiring' || status === 'membership_cancelled') {
    // A cancelled plan with days left is running out the same way.
    level = 'warning';
    say = settings.expiringMessage;
  }

  // Money owing never blocks the visit and is never more than a word -- but
  // it is at least that, whatever the membership's own state, and it is
  // said after anything the membership needed saying.
  let owed = null;
  if (balanceDueOf(record) > 0) {
    if (level === 'ok') level = 'warning';
    owed = settings.balanceDueMessage;
  }

  return { level, speech: settings.enabled === false ? null : joinSpeech([say, owed]) };
}

// ---------------------------------------------------------------------------
// Balance due
// ---------------------------------------------------------------------------

function balanceDueOf(record) {
  const due = Number((record && record.membership && record.membership.balanceDue) ?? 0);
  return Number.isFinite(due) && due > 0 ? due : 0;
}

// "£40", "PKR 2,500", "$12.50": the gym's money as the office writes it --
// no pence on a round amount, which is what a desk sale usually leaves owing.
function moneyLabel(amount, currency) {
  const code = String(currency || '').toUpperCase();
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: code || 'USD',
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2
    })
      .format(value)
      // "PKR 2,500" comes with a no-break space; the desk and the kiosk want
      // plain text.
      .replace(/ /g, ' ');
  } catch {
    return `${code} ${value}`.trim();
  }
}

// The line the desk shows for money owing, or null when nothing is.
function balanceDueLabel(record) {
  const due = balanceDueOf(record);
  return due > 0 ? `Balance due ${moneyLabel(due, record.membership.currency)}` : null;
}

// The receipt's one warning line: the membership's, the balance owing, or
// both. Both have to fit the desk's one-line banner, so the membership's
// part loses its advice ("— offer a renewal") and the money follows it:
// "EXPIRES IN 3 DAYS · Balance due £40".
function memberWarning(record) {
  const warning = membershipWarningFor(record);
  const owed = balanceDueLabel(record);
  if (!owed) return warning;
  if (!warning) return owed;
  return `${warning.split(' — ')[0]} · ${owed}`;
}

// The verdict helpers are exported alongside recordPunch so anything that has
// to write an attendance row WITHOUT going through a live punch -- the seeder,
// or a future backfill -- reaches the same verdict this does. Duplicating the
// late/expired rules elsewhere is how the desk and the office start disagreeing.
module.exports = {
  recordPunch,
  readRequestId,
  readScannedAt,
  readMatchScore,
  OFFLINE_MAX_HOURS,
  entryRefusal,
  refuseEntrySettings,
  MIN_PUNCH_GAP_SECONDS,
  OPEN_VISIT_HOURS,
  memberScanOut,
  attendanceSettings,
  voiceSettings,
  VOICE_DEFAULTS,
  memberAlert,
  memberWarning,
  balanceDueLabel,
  moneyLabel,
  membershipVerdict,
  scheduleFor,
  arrivalVerdict,
  departureVerdict,
  currentVerdict
};
