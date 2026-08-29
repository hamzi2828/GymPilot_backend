// Seeder/createAttendance.js
//
// Populates a development database with everything the attendance screens
// need to be worth looking at: members, the memberships that decide their
// verdict at the desk, trainer rosters, and a month of punches across both.
//
//   node Seeder/createAttendance.js            seed (skips what already exists)
//   node Seeder/createAttendance.js --days 60  a longer history
//   node Seeder/createAttendance.js --reset    delete only what this seeded
//
// Two rules this file follows deliberately:
//
//   1. Verdicts are NOT recomputed here. It imports the same membership and
//      roster verdict functions the live punch path uses, so a seeded row and
//      a real one are judged by identical rules.
//
//   2. Times are built in the gym's timezone, not the server's. A row filed
//      against the wrong local day is invisible on the day it belongs to,
//      which is the exact bug timeUtils exists to prevent.

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../src/models/user');
const Trainer = require('../src/gymfolio/models/trainerModel');
const Package = require('../src/gymfolio/models/packageModel');
const PackageOrder = require('../src/gymfolio/models/packageOrderModel');
const Attendance = require('../src/attendance/models/attendanceModel');
const Role = require('../src/models/roleModel');
const { ensureDefaultRoles } = require('../src/services/roleService');
const T = require('../src/attendance/services/timeUtils');
const {
  membershipVerdict,
  scheduleFor,
  arrivalVerdict,
  departureVerdict
} = require('../src/attendance/services/punchService');

// Everything this seeder creates carries this marker, so --reset can undo it
// without touching a single real row.
const SEED_TAG = 'seeded:createAttendance';
// Seeded members are identified by their email domain rather than a flag
// field: .test is reserved by RFC 2606 and can never collide with a real
// address, and it needs no schema change to carry.
const SEED_DOMAIN = '@gympilot.test';
const SEED_PASSWORD = 'Gym@12345';

// ---------------------------------------------------------------------------
// Deterministic randomness
//
// A fixed seed means re-running produces the same gym, so a screenshot taken
// today still matches the data tomorrow.
// ---------------------------------------------------------------------------

let rngState = 20260829;
function random() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function randomInt(min, max) {
  return min + Math.floor(random() * (max - min + 1));
}
function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

// ---------------------------------------------------------------------------
// Local time
// ---------------------------------------------------------------------------

// Turns "09:14 on 2026-08-29, gym time" into the UTC instant that is. Guesses
// by treating the local reading as UTC, then corrects by however far off the
// gym clock actually reads -- which is the zone's offset at that instant,
// DST included, without hardcoding one.
function localInstant(dateKey, hour, minute) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));

  const parts = T.localParts(guess);
  let drift = parts.hour * 60 + parts.minute - (hour * 60 + minute);
  if (drift > 720) drift -= 1440;
  if (drift < -720) drift += 1440;

  return new Date(guess.getTime() - drift * 60000);
}

// ---------------------------------------------------------------------------
// The people
// ---------------------------------------------------------------------------

const MEMBERS = [
  { firstName: 'Ayesha',  lastName: 'Khan',      phone: '+92 300 1120045', plan: 'Full Member',  standing: 'active'   },
  { firstName: 'Bilal',   lastName: 'Ahmed',     phone: '+92 301 4471290', plan: 'Performance',  standing: 'active'   },
  { firstName: 'Zara',    lastName: 'Siddiqui',  phone: '+92 333 9087612', plan: 'Off-Peak',     standing: 'expiring' },
  { firstName: 'Hamza',   lastName: 'Iqbal',     phone: '+92 321 5563401', plan: 'Full Member',  standing: 'active'   },
  { firstName: 'Nadia',   lastName: 'Rehman',    phone: '+92 345 7789234', plan: 'Performance',  standing: 'expired'  },
  { firstName: 'Omar',    lastName: 'Farooq',    phone: '+92 302 3345678', plan: 'Off-Peak',     standing: 'active'   },
  { firstName: 'Sana',    lastName: 'Malik',     phone: '+92 336 2214569', plan: 'Full Member',  standing: 'expiring' },
  { firstName: 'Danish',  lastName: 'Sheikh',    phone: '+92 311 8890123', plan: 'Off-Peak',     standing: 'expired'  },
  { firstName: 'Mehwish', lastName: 'Tariq',     phone: '+92 322 6678901', plan: 'Performance',  standing: 'active'   },
  { firstName: 'Usman',   lastName: 'Javed',     phone: '+92 314 4432876', plan: null,           standing: 'none'     }
];

// The people who work here but are not trainers. Each one is a User holding a
// staff role, which is what gives them payroll, a roster and a place on the
// attendance board -- see src/controller/staffController.js.
const STAFF = [
  {
    firstName: 'Aliya', lastName: 'Nawaz', phone: '+92 300 5540118',
    role: 'receptionist', jobTitle: 'Front Desk Supervisor', department: 'Operations',
    employmentType: 'full_time',
    payroll: { basis: 'salaried', salary: 85000, currency: 'PKR', cycle: 'monthly', contractHoursPerWeek: 48 },
    shift: ['06:00', '14:00'], days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    desk: true, enroll: true
  },
  {
    firstName: 'Kamran', lastName: 'Shah', phone: '+92 321 7781204',
    role: 'receptionist', jobTitle: 'Front Desk', department: 'Operations',
    employmentType: 'full_time',
    payroll: { basis: 'salaried', salary: 62000, currency: 'PKR', cycle: 'monthly', contractHoursPerWeek: 48 },
    shift: ['14:00', '22:00'], days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    desk: true, enroll: false
  },
  {
    firstName: 'Rashid', lastName: 'Mehmood', phone: '+92 333 2216740',
    role: 'cleaner', jobTitle: 'Facilities Assistant', department: 'Facilities',
    employmentType: 'part_time',
    payroll: { basis: 'hourly', hourlyRate: 450, currency: 'PKR', cycle: 'weekly', contractHoursPerWeek: 24 },
    shift: ['05:30', '09:30'], days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    desk: false, enroll: false
  },
  {
    firstName: 'Fatima', lastName: 'Zubair', phone: '+92 345 3390182',
    role: 'manager', jobTitle: 'Gym Manager', department: 'Management',
    employmentType: 'full_time',
    payroll: { basis: 'salaried', salary: 165000, currency: 'PKR', cycle: 'monthly', contractHoursPerWeek: 45 },
    shift: ['09:00', '18:00'], days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    desk: true, enroll: true
  },
  {
    firstName: 'Junaid', lastName: 'Aslam', phone: '+92 302 8865431',
    role: 'accountant', jobTitle: 'Accounts Officer', department: 'Finance',
    employmentType: 'part_time',
    payroll: { basis: 'hourly', hourlyRate: 1200, currency: 'PKR', cycle: 'monthly', contractHoursPerWeek: 16 },
    shift: ['10:00', '14:00'], days: ['Monday', 'Wednesday', 'Friday'],
    desk: false, enroll: false
  }
];

// A trainer with no availability produces nothing but "Not rostered today",
// which tells an operator nothing. Rosters are only filled in where one is
// missing -- a trainer who already has hours keeps them.
const ROSTER_SHAPES = [
  [
    { day: 'Monday', startTime: '06:00', endTime: '14:00' },
    { day: 'Tuesday', startTime: '06:00', endTime: '14:00' },
    { day: 'Wednesday', startTime: '06:00', endTime: '14:00' },
    { day: 'Thursday', startTime: '06:00', endTime: '14:00' },
    { day: 'Friday', startTime: '06:00', endTime: '12:00' },
    { day: 'Saturday', startTime: '08:00', endTime: '13:00' }
  ],
  [
    { day: 'Monday', startTime: '14:00', endTime: '22:00' },
    { day: 'Tuesday', startTime: '14:00', endTime: '22:00' },
    { day: 'Wednesday', startTime: '14:00', endTime: '22:00' },
    { day: 'Thursday', startTime: '14:00', endTime: '22:00' },
    { day: 'Saturday', startTime: '12:00', endTime: '18:00' }
  ],
  [
    { day: 'Monday', startTime: '09:00', endTime: '17:00' },
    { day: 'Wednesday', startTime: '09:00', endTime: '17:00' },
    { day: 'Friday', startTime: '09:00', endTime: '17:00' },
    { day: 'Sunday', startTime: '10:00', endTime: '15:00' }
  ]
];

async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set. Add it to .env first.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.name}`);
}

// Codes are normally handed out lazily by peopleDirectory the first time
// someone is seen at the desk. Seeded people get theirs up front so the tables
// do not read "no code" for a roster that has never been to a desk.
async function nextCodeSequence(Model, field, prefix) {
  const last = await Model.findOne({ [field]: new RegExp('^' + prefix) })
    .sort({ [field]: -1 })
    .select(field)
    .lean();

  if (!last || !last[field]) return 1;
  const parsed = parseInt(String(last[field]).slice(prefix.length), 10);
  return Number.isNaN(parsed) ? 1 : parsed + 1;
}

async function seedMembers() {
  const hashed = await bcrypt.hash(SEED_PASSWORD, 10);
  let sequence = await nextCodeSequence(User, 'memberCode', 'GP-');
  const created = [];
  const users = [];

  for (const template of MEMBERS) {
    const email = `${template.firstName}.${template.lastName}`.toLowerCase() + SEED_DOMAIN;
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        firstName: template.firstName,
        lastName: template.lastName,
        email,
        password: hashed,
        phone: template.phone,
        role: 'user',
        isActive: true,
        memberCode: 'GP-' + String(sequence).padStart(4, '0')
      });
      sequence += 1;
      created.push(email);
    } else if (!user.memberCode) {
      user.memberCode = 'GP-' + String(sequence).padStart(4, '0');
      sequence += 1;
      await user.save();
    }

    users.push({ user, template });
  }

  console.log(`Members: ${users.length} on file (${created.length} created)`);
  return users;
}

// The term a package actually runs for. Mirrors addPeriod() in
// gymfolioPaymentController, which is what a real purchase uses -- a seeded
// membership that ignored the package period would show a monthly package with
// eight months left on it, which is nonsense on the member's own screen.
function addPeriod(from, period) {
  const d = new Date(from);
  const p = String(period || 'month').toLowerCase();
  if (p.includes('year')) d.setFullYear(d.getFullYear() + 1);
  else if (p.includes('week')) d.setDate(d.getDate() + 7);
  else if (p.includes('day')) d.setDate(d.getDate() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

function termDays(period) {
  const start = new Date();
  return Math.max(1, Math.round((addPeriod(start, period) - start) / 86400000));
}

// The four membership states the desk can meet, so every verdict branch has
// something behind it: in date, about to lapse, lapsed, never bought one.
//
// Every window is START + one package term. Only the start date moves, which is
// what decides how much of the term is left -- so a monthly package can never
// come out with 235 days on it.
function subscriptionWindow(standing, period) {
  const day = 86400000;
  const now = Date.now();
  const term = termDays(period);

  // Bought partway through the term, with a comfortable slice still to run.
  if (standing === 'active') {
    const elapsed = randomInt(Math.round(term * 0.1), Math.max(1, Math.round(term * 0.6)));
    const start = new Date(now - elapsed * day);
    return { start, end: addPeriod(start, period) };
  }

  // Down to the last few days -- the renewal conversation the desk wants.
  if (standing === 'expiring') {
    const left = randomInt(1, Math.min(6, Math.max(1, term - 1)));
    const start = new Date(now - (term - left) * day);
    return { start, end: addPeriod(start, period) };
  }

  // Already lapsed, somewhere between a few days and a couple of months ago.
  const lapsed = randomInt(3, 60);
  const start = new Date(now - (term + lapsed) * day);
  return { start, end: addPeriod(start, period) };
}

async function seedMemberships(members) {
  const packages = await Package.find().lean();
  if (!packages.length) {
    console.log('Memberships: skipped, no packages in the database (run seed:packages first)');
    return;
  }

  let created = 0;

  for (const { user, template } of members) {
    if (!template.plan) continue;

    const existing = await PackageOrder.findOne({ userId: user._id, 'payment.status': 'paid' });
    if (existing) continue;

    const pkg = packages.find((p) => p.name === template.plan) || packages[0];
    const window = subscriptionWindow(template.standing, pkg.period);
    const live = window.end.getTime() >= Date.now();

    await PackageOrder.create({
      orderNumber: await PackageOrder.generateOrderNumber(),
      userId: user._id,
      packageId: pkg._id,
      packageDetails: {
        name: pkg.name,
        price: String(pkg.price),
        currency: pkg.currency || 'GBP',
        period: pkg.period || 'month',
        features: []
      },
      customerInfo: {
        fullName: `${user.firstName} ${user.lastName}`,
        email: user.email,
        phone: user.phone || '',
        country: 'Pakistan'
      },
      payment: {
        method: 'cash',
        amount: Number(pkg.price) || 0,
        currency: (pkg.currency || 'GBP').toLowerCase(),
        status: 'paid',
        paidAt: window.start
      },
      subscription: {
        startDate: window.start,
        endDate: window.end,
        isActive: live,
        autoRenew: false
      },
      status: live ? 'active' : 'expired',
      notes: SEED_TAG
    });

    created += 1;
  }

  console.log(`Memberships: ${created} package orders created`);
}

async function seedStaff() {
  await ensureDefaultRoles();

  const hashed = await bcrypt.hash(SEED_PASSWORD, 10);
  const roles = new Map((await Role.find().select('slug name isStaff').lean()).map((r) => [r.slug, r]));

  // Trainers and staff accounts draw from ONE TR- series, so this has to look
  // at both collections. Counting only Users is how two people end up sharing
  // a code the front desk reads aloud.
  let sequence = Math.max(
    await nextCodeSequence(User, 'staffCode', 'TR-'),
    await nextCodeSequence(Trainer, 'staffCode', 'TR-')
  );
  const people = [];
  let created = 0;

  for (const template of STAFF) {
    const email = `${template.firstName}.${template.lastName}`.toLowerCase() + SEED_DOMAIN;
    const role = roles.get(template.role);
    if (!role) {
      console.log(`  skipped ${email}: no "${template.role}" role`);
      continue;
    }

    const schedule = template.days.map((day) => ({
      day,
      startTime: template.shift[0],
      endTime: template.shift[1]
    }));

    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        firstName: template.firstName,
        lastName: template.lastName,
        email,
        password: hashed,
        phone: template.phone,
        role: role.slug,
        isActive: true,
        staffCode: 'TR-' + String(sequence).padStart(4, '0'),
        allowAttendanceApp: !!template.desk,
        allowFingerprintEnrollment: !!template.enroll,
        attendanceLocation: 'Main branch',
        employment: {
          isStaff: true,
          jobTitle: template.jobTitle,
          department: template.department,
          employmentType: template.employmentType,
          joinedAt: new Date(Date.now() - randomInt(120, 900) * 86400000),
          payroll: Object.assign(
            { basis: 'salaried', salary: 0, hourlyRate: 0, currency: 'PKR', cycle: 'monthly' },
            template.payroll
          ),
          schedule
        }
      });
      sequence += 1;
      created += 1;
    }

    people.push({
      _id: user._id,
      name: `${user.firstName} ${user.lastName}`,
      staffCode: user.staffCode || '',
      availability: schedule
    });
  }

  console.log(`Staff: ${people.length} accounts (${created} created)`);
  return people;
}

async function seedRosters() {
  const trainers = await Trainer.find();
  let sequence = await nextCodeSequence(Trainer, 'staffCode', 'TR-');
  let rostered = 0;
  let coded = 0;

  for (let i = 0; i < trainers.length; i++) {
    const trainer = trainers[i];
    let dirty = false;

    if (!Array.isArray(trainer.availability) || !trainer.availability.length) {
      trainer.availability = ROSTER_SHAPES[i % ROSTER_SHAPES.length];
      rostered += 1;
      dirty = true;
    }
    if (!trainer.staffCode) {
      trainer.staffCode = 'TR-' + String(sequence).padStart(4, '0');
      sequence += 1;
      coded += 1;
      dirty = true;
    }
    if (dirty) await trainer.save();
  }

  console.log(`Trainers: ${trainers.length} on file (${rostered} given a roster, ${coded} given a code)`);
  return Trainer.find().lean();
}

// ---------------------------------------------------------------------------
// The punches
// ---------------------------------------------------------------------------

const DESKS = [
  { name: 'Front Desk — Aliya', device: 'DESK-01', osUser: 'frontdesk' },
  { name: 'Front Desk — Kamran', device: 'DESK-02', osUser: 'frontdesk2' }
];

function punchContext(desk, method) {
  return {
    by: null,
    byName: desk.name,
    device: desk.device,
    osUser: desk.osUser,
    clientApp: SEED_TAG,
    ip: '192.168.1.' + randomInt(20, 60),
    method
  };
}

function membershipSnapshot(order) {
  if (!order) return { status: 'none', orderId: null, packageName: '', endDate: null, daysLeft: null };

  const endDate = order.subscription && order.subscription.endDate ? new Date(order.subscription.endDate) : null;
  const live = order.status !== 'cancelled' && endDate && endDate.getTime() >= Date.now();

  return {
    status: live ? 'active' : 'expired',
    orderId: order._id,
    packageName: (order.packageDetails && order.packageDetails.name) || 'Membership',
    endDate,
    daysLeft: endDate ? Math.ceil((endDate.getTime() - Date.now()) / 86400000) : null
  };
}

async function seedPunches(members, staffPeople, days) {
  const today = T.dateKey();
  const dateKeys = [];
  for (let offset = days - 1; offset >= 0; offset--) dateKeys.push(T.shiftDateKey(today, -offset));

  const orders = await PackageOrder.find({ 'payment.status': 'paid' }).lean();
  const orderByUser = new Map();
  for (const order of orders) {
    if (order.userId) orderByUser.set(String(order.userId), order);
  }

  const rows = [];

  // ---- Members --------------------------------------------------------
  //
  // Attendance is not uniform in a real gym, so neither is this: a keen
  // member comes most days, a lapsed one has not been in for weeks. That
  // spread is the whole point of the "no visits in range" filter.
  for (let index = 0; index < members.length; index++) {
    const { user, template } = members[index];
    const membership = membershipSnapshot(orderByUser.get(String(user._id)));
    const verdict = membershipVerdict(membership);

    // 0 = never turns up, 1 = practically lives here.
    const keenness =
      template.standing === 'active' ? 0.45 + random() * 0.3
      : template.standing === 'expiring' ? 0.3
      : template.standing === 'expired' ? 0.12
      : 0.05;

    // One member deliberately never appears, so the roster view has an
    // honest "Never checked in" row to show.
    if (index === MEMBERS.length - 1) continue;

    for (const dateKey of dateKeys) {
      const weekday = T.weekdayNameForKey(dateKey);
      const quiet = weekday === 'Sunday' ? 0.5 : 1;
      if (random() > keenness * quiet) continue;

      // Two crowds: before work and after it.
      const morning = random() < 0.55;
      const hour = morning ? randomInt(6, 9) : randomInt(17, 20);
      const minute = randomInt(0, 59);

      const checkInAt = localInstant(dateKey, hour, minute);
      const stayMinutes = randomInt(35, 110);
      const isToday = dateKey === today;

      // Today's late arrivals are still inside -- an open visit is what the
      // "In the gym" tile and the Still in pill are there to show.
      const openVisit = isToday && checkInAt.getTime() > Date.now() - stayMinutes * 60000;
      const checkOutAt = openVisit ? null : new Date(checkInAt.getTime() + stayMinutes * 60000);

      if (checkInAt.getTime() > Date.now()) continue;

      const desk = pick(DESKS);
      const method = random() < 0.9 ? 'fingerprint' : 'manual';

      rows.push({
        personType: 'member',
        personId: user._id,
        personName: `${user.firstName} ${user.lastName}`,
        personCode: user.memberCode || '',
        shiftDate: dateKey,
        checkInAt,
        checkOutAt,
        checkIn: punchContext(desk, method),
        checkOut: checkOutAt ? punchContext(random() < 0.85 ? desk : pick(DESKS), method) : {},
        workedMinutes: checkOutAt ? stayMinutes : null,
        membership: {
          orderId: membership.orderId,
          packageName: membership.packageName,
          endDate: membership.endDate,
          status: membership.status
        },
        status: verdict.status,
        statusLabel: verdict.label
      });
    }
  }

  // ---- Staff ----------------------------------------------------------
  //
  // Judged against the trainer's own availability through the same
  // arrival/departure verdicts the desk uses, so "Late by 12 m" here means
  // exactly what it means on a receipt.
  for (const trainer of staffPeople) {
    for (const dateKey of dateKeys) {
      const schedule = scheduleFor(trainer, dateKey);
      if (!schedule.hasSchedule) continue;

      // Everyone takes the odd day off.
      if (random() < 0.12) continue;

      const start = T.parseClock(schedule.startTime);
      const end = T.parseClock(schedule.endTime);
      if (start === null || end === null) continue;

      // Mostly punctual, occasionally late, occasionally keen.
      const roll = random();
      const arrivalOffset = roll < 0.6 ? randomInt(-12, 3) : roll < 0.85 ? randomInt(6, 35) : randomInt(-40, -15);
      const departureOffset = random() < 0.7 ? randomInt(-5, 25) : randomInt(-70, -20);

      const arrival = start + arrivalOffset;
      const checkInAt = localInstant(dateKey, Math.floor(arrival / 60), ((arrival % 60) + 60) % 60);
      if (checkInAt.getTime() > Date.now()) continue;

      const departure = (end < start ? end + 1440 : end) + departureOffset;
      const departureAt = localInstant(dateKey, Math.floor(departure / 60) % 24, ((departure % 60) + 60) % 60);
      const stillOnShift = dateKey === today && departureAt.getTime() > Date.now();

      const checkOutAt = stillOnShift ? null : departureAt;
      const desk = pick(DESKS);

      const arrivalCall = arrivalVerdict(schedule, checkInAt);
      const departureCall = checkOutAt ? departureVerdict(schedule, checkOutAt) : null;
      const call = departureCall || arrivalCall;

      rows.push({
        personType: 'staff',
        personId: trainer._id,
        personName: trainer.name,
        personCode: trainer.staffCode || '',
        shiftDate: dateKey,
        checkInAt,
        checkOutAt,
        checkIn: punchContext(desk, 'fingerprint'),
        checkOut: checkOutAt ? punchContext(desk, 'fingerprint') : {},
        workedMinutes: checkOutAt ? Math.round((checkOutAt - checkInAt) / 60000) : null,
        schedule,
        status: call.status,
        statusLabel: call.label,
        varianceMinutes: call.variance
      });
    }
  }

  // ---- Whoever is in the building right now ---------------------------
  //
  // Left to chance, a seed run at 3am produces an empty gym, and the live
  // half of the screen -- the "In the gym" tile, the Still in pill, the
  // "checked in but not out" filter -- has nothing behind it. So a few open
  // visits are guaranteed rather than hoped for, backdated far enough to look
  // like people mid-workout.
  const busyToday = new Set(
    rows.filter((row) => row.shiftDate === today && row.personType === 'member').map((row) => String(row.personId))
  );

  let live = 0;
  for (const { user } of members) {
    if (live >= 3) break;
    if (busyToday.has(String(user._id))) continue;

    const membership = membershipSnapshot(orderByUser.get(String(user._id)));
    const verdict = membershipVerdict(membership);
    const checkInAt = new Date(Date.now() - randomInt(18, 75) * 60000);

    // Only if the gym would actually be open -- a 4am arrival is not
    // realistic data, it is just a filled tile.
    const localHour = T.localParts(checkInAt).hour;
    if (localHour < 6 || localHour >= 23) break;

    rows.push({
      personType: 'member',
      personId: user._id,
      personName: `${user.firstName} ${user.lastName}`,
      personCode: user.memberCode || '',
      shiftDate: T.dateKey(checkInAt),
      checkInAt,
      checkOutAt: null,
      checkIn: punchContext(pick(DESKS), 'fingerprint'),
      checkOut: {},
      workedMinutes: null,
      membership: {
        orderId: membership.orderId,
        packageName: membership.packageName,
        endDate: membership.endDate,
        status: membership.status
      },
      status: verdict.status,
      statusLabel: verdict.label
    });

    live += 1;
  }

  if (!rows.length) {
    console.log('Punches: nothing to insert');
    return;
  }

  const inserted = await Attendance.insertMany(rows);
  const open = rows.filter((row) => !row.checkOutAt).length;
  console.log(
    `Punches: ${inserted.length} rows over ${days} days ` +
      `(${rows.filter((r) => r.personType === 'member').length} member, ` +
      `${rows.filter((r) => r.personType === 'staff').length} staff, ${open} still open)`
  );
}

async function reset() {
  const punches = await Attendance.deleteMany({ 'checkIn.clientApp': SEED_TAG });
  const orders = await PackageOrder.deleteMany({ notes: SEED_TAG });
  const users = await User.deleteMany({ email: new RegExp(SEED_DOMAIN.replace('.', '\.') + '$', 'i') });

  console.log(
    `Removed ${punches.deletedCount} punches, ${orders.deletedCount} package orders, ${users.deletedCount} members.`
  );
  console.log('Trainer rosters and staff codes were left in place -- they are real records.');
  console.log('Seeded staff accounts were removed with the members (same .test domain).');
}

async function main() {
  const args = process.argv.slice(2);
  await connect();

  if (args.includes('--reset')) {
    await reset();
    await mongoose.connection.close();
    return;
  }

  const daysArg = args.indexOf('--days');
  const days = daysArg >= 0 ? Math.max(1, Math.min(365, parseInt(args[daysArg + 1], 10) || 30)) : 30;

  // Re-running should refresh the history rather than stack a second month of
  // punches on top of the first.
  const cleared = await Attendance.deleteMany({ 'checkIn.clientApp': SEED_TAG });
  if (cleared.deletedCount) console.log(`Cleared ${cleared.deletedCount} previously seeded punches`);

  const members = await seedMembers();
  await seedMemberships(members);
  const trainers = await seedRosters();
  const staff = await seedStaff();

  // Trainers and staff accounts punch on the same reader and are the same
  // personType, so the punch generator sees one list. `availability` is the
  // shape both are normalised to -- see resolvePerson() in peopleDirectory.
  await seedPunches(members, [...trainers, ...staff], days);

  console.log(`\nDone. Members sign in with the password: ${SEED_PASSWORD}`);
  console.log('Undo everything with: node Seeder/createAttendance.js --reset');
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
