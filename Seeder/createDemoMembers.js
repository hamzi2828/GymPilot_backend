// Seeder/createDemoMembers.js
//
// Two believable members for a demo gym, each with months of history behind
// them, so the owner can sign in AS a member -- on the website's member
// portal and on the phone app -- and see what a real member sees.
//
//   node Seeder/createDemoMembers.js --gym demo            create them (skips any that exist)
//   node Seeder/createDemoMembers.js --gym demo --reset    delete only what this created
//   node Seeder/createDemoMembers.js --gym demo --force    run even when NODE_ENV=production
//
// Who they are:
//
//   Ahmed Raza  -- regular for ~4 months on "Performance", renewed every
//                  month (cash and JazzCash), mornings ~3x a week, a string of
//                  attended classes and two coming up. Membership active.
//   Sana Iqbal  -- joined ~2.5 months ago on "Full Member": paid part in cash
//                  and settled the rest by JazzCash, froze for a week, let it
//                  lapse, came back with a bank transfer the manager approved.
//                  Evenings ~2x a week, one booking cancelled, one coming up.
//                  Membership ends in about a week, so the reminders show.
//
// How the history is made: by the app itself, replayed in order. Every sale,
// renewal, part payment, freeze, transfer approval and desk punch goes
// through the same service function the live screens call
// (membershipService, punchService.recordPunch), with the clock set back to
// the moment it "happened" -- so order numbers, invoice numbers, createdAt,
// paidAt, installments, freeze history and the attendance verdicts are exactly
// what the app would have written then. Bookings are written with the fields
// the booking controller writes (its handler would also email the member).
// Nothing here sends an email: while the history is replayed the two
// members have every notification switched off (the live server's own
// expiry sweep could otherwise tell them a replayed term had "ended"), and
// they are switched back on at the end.
//
// Run against a live gym, that sweep also runs on the REAL clock while this
// replays the past, and may flip a replayed term to 'expired' that is still
// current on the replay clock. So before every event this puts its own
// orders' status back to what the replay clock says (and nobody else's), an
// event that still trips over it is retried once, and each renewal is
// checked to start where the term it renews ends.
//
// The clock is moved by swapping the global Date for a proxy that reads
// "now" as a chosen instant. It is installed only after every model schema
// has been built, and every Date it makes is a genuine Date.
//
// Each member's account carries a marker (registrationRequestId, never shown
// anywhere) and everything else hangs off that account, so --reset removes
// exactly what this created: the two accounts, their orders, visits, desk
// log rows, bookings and phone-app login rows. Re-running skips a member that
// already exists. Passwords are generated (no ambiguous characters) and
// printed once; an existing member's password is never changed.
//
// Refuses to seed when NODE_ENV=production unless --force is passed.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { enterContext, resolveGymContextFromArgs, hasFlag } = require('../scripts/lib/tenantScript');

// Every schema is built before the clock below is installed, so none of them
// captures the stand-in Date as a field type.
(function loadAllModels() {
  const roots = [path.join(__dirname, '..', 'src')];
  while (roots.length) {
    const dir = roots.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) roots.push(full);
      else if (/[\\/]models$/.test(dir) && entry.name.endsWith('.js')) require(full);
    }
  }
})();

const User = require('../src/models/user');
const Settings = require('../src/models/settings');
const Package = require('../src/gymfolio/models/packageModel');
const GymClass = require('../src/gymfolio/models/gymClassModel');
const PackageOrder = require('../src/gymfolio/models/packageOrderModel');
const ClassBooking = require('../src/gymfolio/models/classBookingModel');
const Attendance = require('../src/attendance/models/attendanceModel');
const AttendanceLog = require('../src/attendance/models/attendanceLogModel');
const MemberDirectory = require('../src/platform/models/memberDirectoryModel');
const membership = require('../src/gymfolio/services/membershipService');
const { lapsedFilter } = require('../src/gymfolio/services/membershipExpiry');
const { recordPunch } = require('../src/attendance/services/punchService');
const { assignMemberCode, ensureMemberCode, membershipFor } = require('../src/attendance/services/peopleDirectory');
const classSessions = require('../src/gymfolio/services/classSessions');
const { generatePassword } = require('../src/services/adminPasswords');
require('../src/services/invoiceService');
require('../src/services/reminderJobs');
const T = require('../src/attendance/services/timeUtils');

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

const RealDate = Date;
let clockOffset = 0;
global.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [RealDate.now() + clockOffset], newTarget);
  },
  apply() {
    return new RealDate(RealDate.now() + clockOffset).toString();
  },
  get(target, prop, receiver) {
    if (prop === 'now') return () => RealDate.now() + clockOffset;
    return Reflect.get(target, prop, receiver);
  }
});

/** From here on, "now" reads as `instant` (and keeps ticking from there). */
function setClock(instant) {
  clockOffset = new RealDate(instant).getTime() - RealDate.now();
}
function resetClock() {
  clockOffset = 0;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_PREFIX = 'seed-createDemoMembers-';
const MIN = 60000;
const DAY = 86400000;
const DESK_APP = 'GymPilot Desk/1.4.2';

const MEMBERS = {
  ahmed: {
    key: 'ahmed',
    firstName: 'Ahmed',
    lastName: 'Raza',
    email: 'ahmed.raza@demo.gymspilotpro.com',
    phone: '0300-4172856',
    gender: 'male',
    dateOfBirth: '1993-03-14',
    goals: 'Build strength and drop to 78 kg before the end of the year.',
    source: 'Walk-in',
    emergencyContact: { name: 'Hina Raza', phone: '0301-5528190', relationship: 'Wife' },
    plan: 'Performance',
    fallbackPlanIndex: 0
  },
  sana: {
    key: 'sana',
    firstName: 'Sana',
    lastName: 'Iqbal',
    email: 'sana.iqbal@demo.gymspilotpro.com',
    phone: '0321-6650394',
    gender: 'female',
    dateOfBirth: '1997-09-02',
    goals: 'Get fitter after work and keep up with the dance classes.',
    source: 'Instagram',
    emergencyContact: { name: 'Tariq Iqbal', phone: '0333-4410276', relationship: 'Father' },
    plan: 'Full Member',
    fallbackPlanIndex: 1
  }
};

// Deterministic, so a reset-and-rerun gives the same story.
let rngState = 20261015;
function random() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function randomInt(min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const at = (dateKey, hour, minute = 0) => T.localInstant(dateKey, hour, minute);
const plus = (date, minutes) => new RealDate(new RealDate(date).getTime() + minutes * MIN);
const keyOf = (date) => T.dateKey(new RealDate(date));
const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ');

function connect() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set. Add it to .env first.');
  return mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
}

/** Each day key from `from` to `to`, inclusive. */
function daysBetween(from, to) {
  const out = [];
  for (let key = from; key <= to; key = T.shiftDateKey(key, 1)) out.push(key);
  return out;
}

/** The next session of a class slot (weekday + start) that starts after `after`. */
function nextSession(slotDay, startTime, after) {
  let key = keyOf(after);
  for (let i = 0; i < 21; i += 1, key = T.shiftDateKey(key, 1)) {
    if (T.weekdayNameForKey(key) !== slotDay) continue;
    const [h, m] = startTime.split(':').map(Number);
    if (at(key, h, m).getTime() > after.getTime()) return key;
  }
  return null;
}

function clockMinutes(text) {
  const [h, m] = String(text).split(':').map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// The people at the desk
// ---------------------------------------------------------------------------

async function deskStaff() {
  const staff = await User.find({ isActive: { $ne: false }, role: { $in: ['receptionist', 'manager', 'admin'] } })
    .select('firstName lastName email role attendanceLocation employment.schedule')
    .sort({ createdAt: 1 })
    .lean();
  const receptionists = staff.filter((s) => s.role === 'receptionist');
  const startOf = (s) => {
    const shift = (s.employment && s.employment.schedule && s.employment.schedule[0]) || null;
    return shift && shift.startTime ? clockMinutes(shift.startTime) : null;
  };
  const admin = staff.find((s) => s.role === 'admin') || null;
  const morning = receptionists.find((s) => startOf(s) !== null && startOf(s) < 12 * 60) || receptionists[0] || admin;
  const evening = receptionists.find((s) => s !== morning && (startOf(s) === null || startOf(s) >= 12 * 60)) || receptionists[1] || morning;
  const manager = staff.find((s) => s.role === 'manager') || admin || morning;
  if (!morning) throw new Error('No receptionist or admin account found to stand at the desk.');
  return { morning, evening, manager };
}

const DESKS = {
  morning: { deviceLabel: 'DESK-01', osUser: 'frontdesk', clientApp: DESK_APP, ip: '192.168.1.24' },
  evening: { deviceLabel: 'DESK-02', osUser: 'frontdesk2', clientApp: DESK_APP, ip: '192.168.1.31' }
};

// ---------------------------------------------------------------------------
// What happens, as a list of timed events
// ---------------------------------------------------------------------------

function visitEvents(events, member, visit) {
  // visit: { checkIn: Date, minutes, shift: 'morning'|'evening', method }
  const checkOut = plus(visit.checkIn, visit.minutes);
  events.push({ at: visit.checkIn, member, label: 'check in', run: (ctx) => punch(ctx, member, visit, 'check_in') });
  events.push({ at: checkOut, member, label: 'check out', run: (ctx) => punch(ctx, member, visit, 'check_out') });
}

/**
 * Ahmed: joined ~4 months ago, mornings Mon/Wed/Fri (now and then a
 * Saturday instead), renews the day before each term ends.
 */
function planAhmed(today, nowMs, pkgSnapshot, classes) {
  const m = 'ahmed';
  const events = [];
  const joinKey = T.shiftDateKey(today, -125);
  const joinAt = at(joinKey, 10, 20);

  events.push({ at: joinAt, member: m, label: 'account', run: (ctx) => createAccount(ctx, m) });
  events.push({
    at: plus(joinAt, 6),
    member: m,
    label: 'first sale (cash)',
    run: (ctx) => sellFirst(ctx, m, { method: 'cash', staff: 'morning' })
  });

  // Visits.
  const visits = [{ checkIn: plus(joinAt, 22), minutes: 70, shift: 'morning', method: 'manual' }];
  let swapToSaturday = false;
  for (const key of daysBetween(T.shiftDateKey(joinKey, 1), today)) {
    const day = T.weekdayNameForKey(key);
    let go = false;
    let hour = 6;
    let minute = randomInt(25, 59);
    if (day === 'Monday' || day === 'Friday') go = random() > 0.08;
    if (day === 'Wednesday') {
      if (random() < 0.2) swapToSaturday = true;
      else go = random() > 0.08;
    }
    if (day === 'Saturday' && (swapToSaturday || random() < 0.1)) {
      go = true;
      swapToSaturday = false;
      hour = 9;
      minute = randomInt(0, 40);
    }
    if (!go) continue;
    if (hour === 6 && random() < 0.4) {
      hour = 7;
      minute = randomInt(0, 30);
    }
    visits.push({ checkIn: at(key, hour, minute), minutes: randomInt(45, 90), shift: 'morning', method: random() < 0.85 ? 'qr' : 'code' });
  }

  // Classes he went to: Engine Room HIIT on some Mon/Fri mornings, Sunrise
  // Vinyasa on a couple of Saturdays. The visit is moved to fit the class.
  const hiit = classes.hiit;
  const yoga = classes.yoga;
  const attended = [];
  let mondayFriday = 0;
  for (const visit of visits) {
    const key = keyOf(visit.checkIn);
    if (key <= T.shiftDateKey(joinKey, 6) || key >= T.shiftDateKey(today, -1)) continue;
    const day = T.weekdayNameForKey(key);
    let slot = null;
    let gymClass = null;
    if (hiit && (day === 'Monday' || day === 'Friday')) {
      mondayFriday += 1;
      if (mondayFriday % 4 === 2) {
        gymClass = hiit;
        slot = hiit.schedule.find((s) => s.day === day);
      }
    }
    if (!slot && yoga && day === 'Saturday' && attended.filter((b) => b.gymClass === yoga).length < 2) {
      gymClass = yoga;
      slot = yoga.schedule.find((s) => s.day === day);
    }
    if (!slot) continue;
    const start = clockMinutes(slot.startTime);
    const end = clockMinutes(slot.endTime || slot.startTime) || start + 45;
    // In a little before the class, out after a session on the weights.
    const arrive = start - randomInt(10, 18);
    visit.checkIn = at(key, Math.floor(arrive / 60), arrive % 60);
    visit.minutes = Math.min(90, Math.max(55, end - arrive + randomInt(15, 35)));
    visit.method = 'qr';
    attended.push({ gymClass, slot, key });
  }

  for (const visit of visits) {
    if (plus(visit.checkIn, visit.minutes).getTime() < nowMs - 5 * MIN) visitEvents(events, m, visit);
  }

  for (const booking of attended) {
    const startsAt = at(booking.key, ...booking.slot.startTime.split(':').map(Number));
    const bookedAt = at(T.shiftDateKey(booking.key, -randomInt(1, 2)), 21, randomInt(5, 50));
    events.push({ at: bookedAt, member: m, label: `book ${booking.gymClass.name}`, run: (ctx) => book(ctx, m, booking) });
    events.push({
      at: plus(startsAt, randomInt(3, 9)),
      member: m,
      label: `attended ${booking.gymClass.name}`,
      run: (ctx) => markAttended(ctx, m, booking, 'morning')
    });
  }

  // Two coming up: the next HIIT morning and the next Saturday yoga.
  const now = new RealDate(nowMs);
  const upcoming = [];
  if (hiit) {
    const options = hiit.schedule
      .filter((s) => clockMinutes(s.startTime) < 12 * 60)
      .map((s) => ({ slot: s, key: nextSession(s.day, s.startTime, plus(now, 60)) }))
      .filter((o) => o.key)
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    if (options[0]) upcoming.push({ gymClass: hiit, slot: options[0].slot, key: options[0].key });
  }
  if (yoga) {
    const slot = yoga.schedule.find((s) => s.day === 'Saturday') || yoga.schedule[0];
    const key = slot && nextSession(slot.day, slot.startTime, plus(now, 60));
    if (key) upcoming.push({ gymClass: yoga, slot, key });
  }
  upcoming.forEach((booking, i) => {
    const bookedAt = at(T.shiftDateKey(today, i === 0 ? -1 : -2), 21, 10 + i * 17);
    events.push({ at: bookedAt, member: m, label: `book ${booking.gymClass.name} (upcoming)`, run: (ctx) => book(ctx, m, booking) });
  });

  // Renewals: the day before each term ends, at the desk after a workout
  // when he was in, otherwise by JazzCash from his phone.
  const methods = ['jazzcash', 'cash', 'jazzcash', 'cash', 'jazzcash', 'cash'];
  let start = plus(joinAt, 6);
  for (let n = 0; n < 8; n += 1) {
    const end = membership.termEnd(start, pkgSnapshot);
    if (end.getTime() > nowMs + 2 * DAY) break;
    const endKey = keyOf(end);
    const visit = visits
      .filter((v) => {
        const k = keyOf(v.checkIn);
        return k >= T.shiftDateKey(endKey, -3) && k < endKey;
      })
      .pop();
    const method = visit ? methods[n] : 'jazzcash';
    const renewAt = visit ? plus(visit.checkIn, visit.minutes + 3) : at(T.shiftDateKey(endKey, -1), 12, 40);
    events.push({
      at: renewAt,
      member: m,
      label: `renewal (${method})`,
      run: (ctx) => renewLatest(ctx, m, { method, staff: 'morning' })
    });
    start = end;
  }

  return events;
}

/**
 * Sana: joined ~2.5 months ago in the evening, paid part in cash and the
 * rest by JazzCash, froze for a week, lapsed, came back by bank transfer.
 */
function planSana(today, nowMs, pkgSnapshot, classes) {
  const m = 'sana';
  const events = [];
  const joinKey = T.shiftDateKey(today, -76);
  const joinAt = at(joinKey, 18, 35);

  events.push({ at: joinAt, member: m, label: 'account', run: (ctx) => createAccount(ctx, m) });
  events.push({
    at: plus(joinAt, 7),
    member: m,
    label: 'first sale (part paid in cash)',
    run: (ctx) => sellFirst(ctx, m, { method: 'cash', staff: 'evening', partPaid: true })
  });

  // The freeze: a week away for a family wedding, booked from the portal.
  const freezeAt = at(T.shiftDateKey(joinKey, 14), 21, 10);
  const freezeDays = 7;
  const resumeAt = plus(freezeAt, freezeDays * 24 * 60);
  const firstEnd = new RealDate(membership.termEnd(plus(joinAt, 7), pkgSnapshot).getTime() + freezeDays * DAY);

  // Back after the lapse: a bank transfer sent one evening and approved by
  // the manager the next morning.
  const rejoinKey = T.shiftDateKey(today, -23);
  const transferAt = at(T.shiftDateKey(rejoinKey, -1), 20, 15);
  const approvedAt = at(rejoinKey, 11, 5);

  const covered = (date) => {
    const t = date.getTime();
    if (t < joinAt.getTime()) return false;
    if (t >= freezeAt.getTime() && t < resumeAt.getTime() + 3 * 60 * MIN) return false;
    if (t >= firstEnd.getTime() - 60 * MIN && t < approvedAt.getTime()) return false;
    return true;
  };

  const visits = [{ checkIn: plus(joinAt, 15), minutes: 62, shift: 'evening', method: 'manual' }];
  for (const key of daysBetween(T.shiftDateKey(joinKey, 1), today)) {
    const day = T.weekdayNameForKey(key);
    let go = false;
    if (day === 'Tuesday' || day === 'Thursday') go = random() > 0.15;
    if (day === 'Monday') go = random() < 0.2;
    if (!go) continue;
    const checkIn = at(key, randomInt(18, 19), randomInt(0, 50));
    if (!covered(checkIn)) continue;
    visits.push({ checkIn, minutes: randomInt(45, 75), shift: 'evening', method: random() < 0.6 ? 'qr' : 'code' });
  }

  // Classes: Boxing on Tuesdays and Studio Dance on Thursdays, now and then.
  const boxing = classes.boxing;
  const dance = classes.dance;
  const attended = [];
  let tuesdays = 0;
  let thursdays = 0;
  for (const visit of visits) {
    const key = keyOf(visit.checkIn);
    if (key <= T.shiftDateKey(joinKey, 3) || key >= T.shiftDateKey(today, -1)) continue;
    const day = T.weekdayNameForKey(key);
    let gymClass = null;
    if (boxing && day === 'Tuesday' && (tuesdays += 1) % 3 === 1 && attended.filter((b) => b.gymClass === boxing).length < 2) gymClass = boxing;
    if (dance && day === 'Thursday' && (thursdays += 1) % 3 === 2 && attended.filter((b) => b.gymClass === dance).length < 2) gymClass = dance;
    if (!gymClass) continue;
    const slot = gymClass.schedule.find((s) => s.day === day);
    if (!slot) continue;
    const start = clockMinutes(slot.startTime);
    const end = clockMinutes(slot.endTime || slot.startTime) || start + 45;
    const arrive = start - randomInt(12, 20);
    visit.checkIn = at(key, Math.floor(arrive / 60), arrive % 60);
    visit.minutes = end - arrive + randomInt(5, 20);
    visit.method = 'qr';
    attended.push({ gymClass, slot, key });
  }

  for (const visit of visits) {
    if (plus(visit.checkIn, visit.minutes).getTime() < nowMs - 5 * MIN) visitEvents(events, m, visit);
  }

  // The rest of the first fee, by JazzCash, at her first visit a week or so in.
  const settleVisit = visits.find((v) => keyOf(v.checkIn) >= T.shiftDateKey(joinKey, 8));
  const settleAt = settleVisit ? plus(settleVisit.checkIn, -4) : at(T.shiftDateKey(joinKey, 9), 18, 50);
  events.push({
    at: settleAt,
    member: m,
    label: 'balance settled (JazzCash)',
    run: (ctx) => settleBalance(ctx, m, { method: 'jazzcash', staff: 'evening', note: 'Balance of first month' })
  });

  // A Studio Dance place booked for the week she then went away, given up
  // just before she froze.
  if (dance) {
    const slot = dance.schedule.find((s) => s.day === 'Thursday') || dance.schedule[0];
    const key = slot && nextSession(slot.day, slot.startTime, plus(freezeAt, 60));
    if (key && key < keyOf(resumeAt)) {
      const booking = { gymClass: dance, slot, key };
      events.push({ at: plus(freezeAt, -2 * 24 * 60 - 55), member: m, label: 'book Studio Dance', run: (ctx) => book(ctx, m, booking) });
      events.push({
        at: plus(freezeAt, -15),
        member: m,
        label: 'cancel Studio Dance',
        run: (ctx) => cancelBooking(ctx, m, booking, 'Travelling to Lahore that week')
      });
    }
  }

  events.push({
    at: freezeAt,
    member: m,
    label: 'freeze (member, 7 days)',
    run: (ctx) => freezeLatest(ctx, m, { days: freezeDays, reason: 'Travelling to Lahore for a family wedding' })
  });
  events.push({ at: plus(resumeAt, 3 * 60), member: m, label: 'freeze ends (resumed)', run: (ctx) => resumeLatest(ctx, m) });

  events.push({
    at: transferAt,
    member: m,
    label: 'bank transfer sent',
    run: (ctx) => bankTransfer(ctx, m, { reference: 'IBFT 4471 8203 9915', note: 'Sent from my Meezan Bank app' })
  });
  events.push({ at: approvedAt, member: m, label: 'bank transfer approved', run: (ctx) => approveTransfer(ctx, m) });

  for (const booking of attended) {
    const startsAt = at(booking.key, ...booking.slot.startTime.split(':').map(Number));
    const bookedAt = at(T.shiftDateKey(booking.key, -1), 22, randomInt(0, 40));
    events.push({ at: bookedAt, member: m, label: `book ${booking.gymClass.name}`, run: (ctx) => book(ctx, m, booking) });
    events.push({
      at: plus(startsAt, randomInt(3, 9)),
      member: m,
      label: `attended ${booking.gymClass.name}`,
      run: (ctx) => markAttended(ctx, m, booking, 'evening')
    });
  }

  // One coming up: the next Boxing session.
  if (boxing) {
    const slot = boxing.schedule.find((s) => s.day === 'Tuesday') || boxing.schedule[0];
    const key = slot && nextSession(slot.day, slot.startTime, plus(new RealDate(nowMs), 60));
    if (key) {
      const booking = { gymClass: boxing, slot, key };
      events.push({ at: at(T.shiftDateKey(today, -1), 22, 5), member: m, label: 'book Boxing (upcoming)', run: (ctx) => book(ctx, m, booking) });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// The actions -- each one the app's own path
// ---------------------------------------------------------------------------

async function createAccount(ctx, key) {
  const template = MEMBERS[key];
  const password = generatePassword(16);
  const user = await User.create({
    firstName: template.firstName,
    lastName: template.lastName,
    email: template.email,
    emailVerified: true,
    password: await bcrypt.hash(password, 10),
    provider: 'local',
    role: 'user',
    phone: template.phone,
    gender: template.gender,
    dateOfBirth: new RealDate(`${template.dateOfBirth}T00:00:00Z`),
    goals: template.goals,
    source: template.source,
    emergencyContact: template.emergencyContact,
    // Off while the past is replayed; switched on at the end (see the top).
    notificationPreferences: { email: false, sms: false, whatsapp: false, push: false, marketing: false },
    isActive: true,
    employment: { isStaff: false },
    registrationRequestId: MARKER_PREFIX + key
  });
  // As the admin "Add member" screen does: a member ID from the start.
  await assignMemberCode(user);
  ctx.users[key] = user;
  ctx.passwords[key] = password;
}

async function sellFirst(ctx, key, { method, staff, partPaid = false }) {
  const user = await User.findById(ctx.users[key]._id);
  const pkg = ctx.packages[key];
  const desk = ctx.staff[staff];
  const order = await membership.createManualOrder({
    user,
    pkg,
    paymentMethod: method,
    markPaid: true,
    amountPaid: partPaid ? Math.round(Number(pkg.price) * 0.5) : undefined,
    paidBy: desk._id,
    by: desk.email
  });
  ctx.orders[key].push(order._id);
}

async function renewLatest(ctx, key, { method, staff }) {
  const desk = ctx.staff[staff];
  const order = await PackageOrder.findOne({ userId: ctx.users[key]._id, 'payment.status': 'paid' }).sort({ 'subscription.endDate': -1 });
  const renewal = await membership.renew(order, { paymentMethod: method, markPaid: true, paidBy: desk._id, by: desk.email });
  ctx.orders[key].push(renewal._id);
  if (new RealDate(renewal.subscription.startDate).getTime() !== new RealDate(order.subscription.endDate).getTime()) {
    throw new Error(`renewal ${renewal.orderNumber} starts ${renewal.subscription.startDate.toISOString()}, not when ${order.orderNumber} ends`);
  }
}

async function settleBalance(ctx, key, { method, staff, note }) {
  const order = await PackageOrder.findOne({ userId: ctx.users[key]._id, 'payment.balanceDue': { $gt: 0 } });
  if (!order) return 'nothing owed';
  await membership.recordPayment(order, { amount: order.payment.balanceDue, method, note, by: ctx.staff[staff]._id });
}

async function freezeLatest(ctx, key, { days, reason }) {
  const order = await PackageOrder.findOne({ userId: ctx.users[key]._id, 'payment.status': 'paid' }).sort({ 'subscription.endDate': -1 });
  await membership.freeze(order, { days, reason, by: ctx.users[key]._id, source: 'member' });
}

async function resumeLatest(ctx, key) {
  // What resumeDueFreezes does each day, for this one order only.
  const order = await PackageOrder.findOne({ userId: ctx.users[key]._id, status: 'frozen' });
  if (order) await membership.unfreeze(order, { source: 'system' });
}

async function bankTransfer(ctx, key, { reference, note }) {
  const user = await User.findById(ctx.users[key]._id);
  const order = await membership.createBankTransferOrder({ user, pkg: ctx.packages[key], customerInfo: { phone: user.phone } });
  await membership.submitTransferProof(order, { url: '', note, reference });
  ctx.orders[key].push(order._id);
}

async function approveTransfer(ctx, key) {
  const order = await PackageOrder.findOne({ userId: ctx.users[key]._id, 'payment.method': 'bank_transfer', 'payment.status': 'processing' });
  if (!order) throw new Error('no bank transfer waiting for approval');
  await membership.approveTransfer(order, { by: ctx.staff.manager._id });
}

async function punch(ctx, key, visit, expected) {
  const operator = ctx.staff[visit.shift];
  const device = DESKS[visit.shift];
  const result = await recordPunch({ personType: 'member', personId: ctx.users[key]._id, operator, device, method: visit.method });
  // The desk app's audit row for the same punch.
  await AttendanceLog.create({
    event: result.success ? 'punch' : 'punch_denied',
    userId: operator._id,
    userName: fullName(operator) || operator.email,
    userEmail: operator.email,
    personType: 'member',
    personId: ctx.users[key]._id,
    personName: (result.person && result.person.name) || '',
    action: (result.detail && result.detail.action) || '',
    method: visit.method,
    success: Boolean(result.success),
    message: result.message,
    device: device.deviceLabel,
    osUser: device.osUser,
    clientApp: device.clientApp,
    ip: device.ip,
    meta: result.detail ? { status: result.detail.status, ...(result.refused ? { refused: result.reason } : {}) } : null
  });
  if (!result.success) return `not recorded: ${result.message}`;
  if (result.action !== expected) throw new Error(`expected ${expected} but the desk recorded ${result.action}`);
  if (expected === 'check_in') ctx.counts[key].visits += 1;
}

/** Writes the booking the way POST /api/gymfolio/bookings does, minus the email. */
async function book(ctx, key, { gymClass, slot, key: date }) {
  const member = await User.findById(ctx.users[key]._id);
  const found = classSessions.findSlot(gymClass, date, slot.startTime);
  if (!found) throw new Error(`${gymClass.name} does not run at ${slot.startTime} on ${date}`);
  let standing = await membershipFor(member);
  if (standing.status === 'pending' && standing.startsOn && T.dateKey(standing.startsOn) <= date) standing = { ...standing, status: 'active' };

  const fields = {
    classId: gymClass._id,
    className: gymClass.name,
    userId: member._id,
    memberName: fullName(member) || member.email,
    memberCode: await ensureMemberCode(member).catch(() => ''),
    sessionDate: date,
    sessionStart: slot.startTime,
    sessionEnd: found.endTime || '',
    instructorName: found.instructorName || '',
    bookedBy: 'member',
    bookedByUserId: member._id,
    membershipStatus: standing.status,
    notes: '',
    status: 'booked',
    creditUsed: false,
    orderId: null
  };
  const capacity = Number(gymClass.capacity) || 0;
  let booking = null;
  if (!capacity) booking = await ClassBooking.create(fields);
  const seats = capacity ? await ClassBooking.freeSeats(gymClass._id, date, slot.startTime, capacity) : [];
  for (const seat of seats) {
    try {
      booking = await ClassBooking.create({ ...fields, seat });
      break;
    } catch (error) {
      if (!ClassBooking.seatTaken(error)) throw error;
    }
  }
  if (!booking) return 'session full, not booked';
  ctx.bookings[`${key}|${gymClass._id}|${date}|${slot.startTime}`] = booking._id;
  ctx.counts[key].bookings += 1;
}

/** PATCH /api/gymfolio/bookings/:id/status { status: 'attended' }, from the desk. */
async function markAttended(ctx, key, { gymClass, slot, key: date }, shift) {
  const id = ctx.bookings[`${key}|${gymClass._id}|${date}|${slot.startTime}`];
  if (!id) return 'no booking to mark';
  const booking = await ClassBooking.findById(id);
  booking.status = 'attended';
  booking.attendedAt = new Date();
  booking.markedBy = ctx.staff[shift]._id;
  await booking.save();
}

/** DELETE /api/gymfolio/bookings/:id by the member, well before the class. */
async function cancelBooking(ctx, key, { gymClass, slot, key: date }, reason) {
  const id = ctx.bookings[`${key}|${gymClass._id}|${date}|${slot.startTime}`];
  if (!id) return 'no booking to cancel';
  const rules = await classSessions.rules();
  const startsAt = classSessions.localInstant(date, slot.startTime).getTime();
  const late = rules.cancelHours > 0 && startsAt - rules.cancelHours * 3600 * 1000 < Date.now();
  await ClassBooking.findOneAndUpdate(
    { _id: id, status: 'booked' },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: ctx.users[key]._id,
        cancelReason: reason,
        waitlistPosition: null,
        lateCancel: late
      }
    }
  );
}

/**
 * This script's orders as the expiry sweep would leave them at the replay
 * clock's "now": back to active if a sweep on the real clock expired one
 * that is still current, and expired once lapsed. Nobody else's orders.
 */
async function expireOurLapsed(userIds) {
  if (!userIds.length) return 0;
  await PackageOrder.updateMany(
    { userId: { $in: userIds }, status: 'expired', 'payment.status': 'paid', 'subscription.endDate': { $gte: new Date() } },
    { $set: { status: 'active', 'subscription.isActive': true } }
  );
  const result = await PackageOrder.updateMany(
    { $and: [{ userId: { $in: userIds } }, lapsedFilter(new Date())] },
    { $set: { status: 'expired', 'subscription.isActive': false } }
  );
  return result.modifiedCount || 0;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

async function reset() {
  const users = await User.find({ registrationRequestId: { $in: Object.keys(MEMBERS).map((k) => MARKER_PREFIX + k) } });
  if (!users.length) {
    console.log('Nothing to remove: no member made by this script is on file.');
    return;
  }
  const ids = users.map((u) => u._id);
  const [bookings, visits, logs, orders] = await Promise.all([
    ClassBooking.deleteMany({ userId: { $in: ids } }),
    Attendance.deleteMany({ personType: 'member', personId: { $in: ids }, voided: { $in: [true, false, null] } }),
    AttendanceLog.deleteMany({ personType: 'member', personId: { $in: ids } }),
    PackageOrder.deleteMany({ userId: { $in: ids } })
  ]);
  for (const user of users) await MemberDirectory.withdraw(user);
  const removed = await User.deleteMany({ _id: { $in: ids } });
  console.log(
    `Removed ${removed.deletedCount} members (${users.map(fullName).join(', ')}), ${orders.deletedCount} orders, ` +
      `${visits.deletedCount} visits, ${logs.deletedCount} desk log rows, ${bookings.deletedCount} bookings, and their app logins.`
  );
  console.log('Order and invoice numbers already issued are not reused (the sequences only move forward).');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const resetting = hasFlag('--reset');
  if (process.env.NODE_ENV === 'production' && !resetting && !hasFlag('--force')) {
    console.error('Refusing to seed: NODE_ENV is production, and this creates members who can sign in.');
    console.error('Pass --force if you really mean to.');
    process.exit(1);
  }

  await connect();
  // Every gym has its own database: --gym <slug> picks which one.
  const context = enterContext(await resolveGymContextFromArgs());
  console.log(`Timezone : ${T.TIMEZONE}`);

  if (resetting) {
    await reset();
    return;
  }

  const settings = await Settings.findOne({ isActive: true }).select('attendance').lean();
  if (settings && settings.attendance && settings.attendance.memberScanOut === false) {
    throw new Error('This gym has members scan in only (Settings → Attendance), so visits would have no check-out. Turn scan-out on first.');
  }

  // Who already exists.
  const existing = {};
  for (const key of Object.keys(MEMBERS)) {
    const user = await User.findOne({ registrationRequestId: MARKER_PREFIX + key }).select('firstName lastName email username memberCode');
    if (user) existing[key] = user;
  }
  const clashes = await User.find({
    email: { $in: Object.values(MEMBERS).map((m) => m.email) },
    registrationRequestId: { $nin: Object.keys(MEMBERS).map((k) => MARKER_PREFIX + k) }
  })
    .select('email')
    .lean();
  if (clashes.length) throw new Error(`An account not made by this script already uses ${clashes.map((c) => c.email).join(', ')}.`);
  const todo = Object.keys(MEMBERS).filter((key) => !existing[key]);
  for (const key of Object.keys(existing)) {
    console.log(`Skipped  : ${fullName(existing[key])} already exists (${existing[key].memberCode}, ${existing[key].username}); password unchanged.`);
  }
  if (!todo.length) {
    console.log('Nothing to do. Use --reset to remove them and start again.');
    return;
  }

  // What they buy, and the classes they go to.
  const packages = await Package.find({ isActive: { $ne: false } }).sort({ price: 1 }).lean();
  if (!packages.length) throw new Error('This gym has no packages to sell.');
  const pickPackage = (template) => packages.find((p) => p.name === template.plan) || packages[template.fallbackPlanIndex % packages.length];
  const classList = await GymClass.find({ isActive: true }).lean();
  const byName = (re) => classList.find((c) => re.test(c.name)) || null;
  const morningClass = (exclude) =>
    classList.find((c) => c !== exclude && (c.schedule || []).some((s) => clockMinutes(s.startTime) < 9 * 60)) || null;
  const eveningClass = (exclude) =>
    classList.find((c) => c !== exclude && (c.schedule || []).some((s) => clockMinutes(s.startTime) >= 17 * 60)) || null;
  const hiit = byName(/hiit/i) || morningClass(null);
  const yoga = byName(/vinyasa|yoga/i) || morningClass(hiit);
  const boxing = byName(/boxing/i) || eveningClass(null);
  const dance = byName(/dance/i) || eveningClass(boxing);

  const staff = await deskStaff();
  const ctx = {
    staff,
    packages: {},
    users: {},
    passwords: {},
    orders: {},
    bookings: {},
    counts: {}
  };

  const nowMs = RealDate.now();
  const today = T.dateKey(new RealDate(nowMs));
  let events = [];
  for (const key of todo) {
    ctx.packages[key] = pickPackage(MEMBERS[key]);
    ctx.orders[key] = [];
    ctx.counts[key] = { visits: 0, bookings: 0 };
    const snapshot = membership.packageSnapshot(ctx.packages[key]);
    if (key === 'ahmed') events = events.concat(planAhmed(today, nowMs, snapshot, { hiit, yoga }));
    if (key === 'sana') events = events.concat(planSana(today, nowMs, snapshot, { boxing, dance }));
  }
  events = events.filter((e) => e.at.getTime() < nowMs - MIN).sort((a, b) => a.at - b.at);

  console.log(`Desk     : mornings ${fullName(staff.morning)}, evenings ${fullName(staff.evening)}, approvals ${fullName(staff.manager)}`);
  for (const key of todo) console.log(`Package  : ${MEMBERS[key].firstName} on ${ctx.packages[key].name} (${ctx.packages[key].price} ${ctx.packages[key].currency})`);
  console.log(`Replaying ${events.length} events from ${T.dateLabel(events[0].at)} to ${T.dateLabel(events[events.length - 1].at)}...`);

  const notes = [];
  try {
    for (const event of events) {
      setClock(event.at);
      let outcome;
      for (let attempt = 1; ; attempt += 1) {
        await expireOurLapsed(Object.values(ctx.users).map((u) => u._id));
        try {
          outcome = await event.run(ctx);
          break;
        } catch (error) {
          // Once more: a sweep on the real clock may have got in between.
          const retryable = attempt === 1 && /expired|not active|has not been paid|This membership is/i.test(error.message);
          if (!retryable) throw new Error(`${event.member} ${event.label} at ${event.at.toISOString()}: ${error.message}`);
          notes.push(`${T.dateLabel(event.at)} ${event.member} ${event.label}: retried after "${error.message}"`);
          setClock(event.at);
        }
      }
      if (typeof outcome === 'string') notes.push(`${T.dateLabel(event.at)} ${event.member} ${event.label}: ${outcome}`);
    }
  } finally {
    resetClock();
  }
  await expireOurLapsed(Object.values(ctx.users).map((u) => u._id));
  // The history is in; from now on they hear from the gym like anyone else.
  await User.updateMany(
    { _id: { $in: Object.values(ctx.users).map((u) => u._id) } },
    { $set: { notificationPreferences: { email: true, sms: true, whatsapp: true, push: true, marketing: true } } }
  );
  for (const note of notes) console.log(`  note: ${note}`);

  // What each one ended up with, read back.
  console.log('');
  for (const key of todo) {
    const user = await User.findById(ctx.users[key]._id).select('firstName lastName email username memberCode createdAt');
    const orders = await PackageOrder.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
    const current = await membershipFor(user);
    const payments = orders.reduce((n, o) => n + (o.payment.status === 'paid' ? Math.max(1, (o.payment.installments || []).length) : 0), 0);
    const visits = await Attendance.countDocuments({ personType: 'member', personId: user._id });
    const minutes = (await Attendance.find({ personType: 'member', personId: user._id }).select('workedMinutes').lean()).reduce((n, r) => n + (r.workedMinutes || 0), 0);
    const bookings = await ClassBooking.find({ userId: user._id }).lean();
    const byStatus = bookings.reduce((acc, b) => ({ ...acc, [b.status]: (acc[b.status] || 0) + 1 }), {});
    console.log(`${fullName(user)}  ${user.memberCode}  joined ${T.dateLabel(user.createdAt)}`);
    console.log(`  sign in  : ${user.email}  /  username ${user.username}`);
    console.log(`  password : ${ctx.passwords[key]}   (shown once)`);
    console.log(`  orders   : ${orders.length} (${orders.map((o) => `${o.orderNumber} ${o.payment.method} ${o.status}${o.invoice && o.invoice.number ? ' ' + o.invoice.number : ''}`).join('; ')})`);
    console.log(`  payments : ${payments}`);
    console.log(`  visits   : ${visits} (${T.durationLabel(minutes)} in the gym)`);
    console.log(`  bookings : ${bookings.length} ${JSON.stringify(byStatus)}`);
    console.log(`  now      : ${current.status} on ${current.packageName}, ends ${current.endDate ? T.dateLabel(current.endDate) : '-'} (${current.daysLeft} days left)`);
    console.log('');
  }
  console.log('Undo with: node Seeder/createDemoMembers.js --gym ' + context.gym.slug + ' --reset');
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
