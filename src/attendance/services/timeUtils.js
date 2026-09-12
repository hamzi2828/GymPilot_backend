// src/attendance/services/timeUtils.js
//
// Every date the attendance app shows or files a punch against is a LOCAL
// date at the gym, not the server's. That distinction is not cosmetic: this
// backend is deployed to Vercel, which runs in UTC, so a 9am Karachi check-in
// arrives stamped 04:00 the same day and a 2am one arrives stamped 21:00 the
// PREVIOUS day. Filing on the raw UTC date would put those two visits on
// different rows and make "today's attendance" wrong for five hours a day.
//
// So all day/time reasoning goes through here, against the gym's timezone.
//
// Which is read per call, not once at load: every gym on the platform has
// its own zone (set on its platform record), and a request for a London gym
// and a request for a Karachi gym can be in flight in the same process.
// ATTENDANCE_TIMEZONE remains the fallback for a gym that has none set.

const { tenantTimezone } = require('../../platform/tenantContext');

function timezone() {
  return tenantTimezone();
}

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday'
];

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

// Intl is the only thing in Node that knows about DST and offsets without a
// dependency. formatToParts gives the calendar fields directly, which is
// exactly what is needed -- a Date shifted by an offset would still print in
// the server's zone.
function localParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;

  // 'en-GB' with hour12:false renders midnight as 24 rather than 00.
  const hour = parseInt(parts.hour, 10) % 24;

  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    weekday: parts.weekday
  };
}

// 'YYYY-MM-DD' in gym-local time -- the key an attendance row is filed under.
function dateKey(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// True for a bare 'YYYY-MM-DD' -- what a date input sends. A value like that
// names a whole local day, not an instant, so a caller storing it as a
// boundary has to decide which end of the day it means.
function isDateOnly(value) {
  return typeof value === 'string' && DATE_ONLY.test(value.trim());
}

// The UTC instant at which a given wall-clock time falls in the gym's zone.
// Reads the local time as if it were UTC, then corrects by however far the
// gym clock actually reads from that -- the zone's offset, DST and all,
// without hardcoding one.
function localInstant(key, hour = 0, minute = 0, second = 0, ms = 0) {
  const [y, m, d] = String(key).trim().split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute, second, ms));

  const p = localParts(guess);
  let drift = p.hour * 60 + p.minute - (hour * 60 + minute);
  if (drift > 720) drift -= 1440;
  if (drift < -720) drift += 1440;

  return new Date(guess.getTime() - drift * 60000);
}

// The first and the last millisecond of a local day. `lastMomentOfLocalDay`
// is what "valid until 30 Sep" means: the code still works at 23:59 on the
// 30th at the gym, whichever zone the server runs in.
function startOfLocalDay(key) {
  return localInstant(key, 0, 0, 0, 0);
}

function lastMomentOfLocalDay(key) {
  return localInstant(key, 23, 59, 59, 999);
}

// Shifts a local date key by whole days without going near a Date's timezone.
function shiftDateKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  // Noon UTC, so adding days can never cross a day boundary by accident on a
  // DST edge.
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}-${String(
    anchor.getUTCDate()
  ).padStart(2, '0')}`;
}

function weekdayName(date = new Date()) {
  return localParts(date).weekday;
}

function weekdayNameForKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay()];
}

// '09:42 AM'
function timeLabel(date) {
  if (!date) return null;
  const p = localParts(date);
  const suffix = p.hour >= 12 ? 'PM' : 'AM';
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${String(hour12).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${suffix}`;
}

// '29 Aug 2026'
function dateLabel(date) {
  if (!date) return null;
  const p = localParts(date);
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1]} ${p.year}`;
}

function dateLabelForKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

// Minutes since local midnight -- the common currency for comparing a punch
// against a rostered 'HH:MM' without building a second Date.
function minutesOfDay(date) {
  const p = localParts(date);
  return p.hour * 60 + p.minute;
}

function parseClock(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

// '2 h 14 m' -- and '0 m' rather than an empty string for a same-minute pair,
// so the receipt row never renders blank.
function durationLabel(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return null;

  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const mins = whole % 60;

  if (hours === 0) return `${mins} m`;
  if (mins === 0) return `${hours} h`;
  return `${hours} h ${mins} m`;
}

module.exports = {
  // Kept as a property for the callers that report `T.TIMEZONE` in their
  // responses; a getter so it is the current gym's zone, not a fixed one.
  get TIMEZONE() {
    return timezone();
  },
  timezone,
  WEEKDAYS,
  localParts,
  dateKey,
  isDateOnly,
  localInstant,
  startOfLocalDay,
  lastMomentOfLocalDay,
  shiftDateKey,
  weekdayName,
  weekdayNameForKey,
  timeLabel,
  dateLabel,
  dateLabelForKey,
  minutesOfDay,
  parseClock,
  durationLabel
};
