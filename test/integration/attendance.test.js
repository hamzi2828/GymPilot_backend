// Attendance against a real MongoDB: punchService check-in / check-out for a
// member and for staff, the arrival verdict surviving check-out,
// closeStaleVisits marking forgotten visits, and every "inside now" question
// ignoring them -- even before the job has run. Then the one-open-visit rule:
// two scans arriving together open one visit, and a visit left open yesterday
// never stops today's check-in. Then staff windows (a forgotten check-out is
// not closed by the next day's scan), the office's corrections and voids and
// what they do to hours and pay, two desks checking one person out at once,
// gyms where members only scan in, and subscriptions that renew themselves.
//
// The gym's clock is set to midday (h.middayZone): the staff roster below is
// 10:00-11:00, so the arrival is always late and the departure overtime,
// whatever time the suite is run.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let T;
let User;
let PackageOrder;
let Attendance;
let punch;
let stale;
let desktop;
let admin;
let corrections;
let payroll;
let accounts;
let L;
let operator;
let member;
let staff;
let stranger;
let insider;
const device = { deviceLabel: 'DESK-1', osUser: 'frontdesk', clientApp: 'integration', ip: '127.0.0.1' };

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  User = h.src('models/user');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Attendance = h.src('attendance/models/attendanceModel');
  punch = h.src('attendance/services/punchService');
  stale = h.src('attendance/services/staleVisits');
  desktop = h.src('attendance/controller/desktopAppController');
  admin = h.src('attendance/controller/adminAttendanceController');
  corrections = h.src('attendance/controller/attendanceCorrectionController');
  payroll = h.src('services/payrollService');
  accounts = h.src('accounts/controller/accountsController');
  L = h.src('accounts/services/ledger');

  gym = await h.createGym('attendance-gym', { timezone: h.middayZone(), currency: 'GBP' });

  await h.inGym(gym, async () => {
    await h.ensureIndexes(Attendance, User);
    const today = T.weekdayNameForKey(T.dateKey());
    operator = await User.create({ firstName: 'Desk', lastName: 'Operator', email: 'desk@attendance.test', role: 'admin', attendanceLocation: 'Main' });
    member = await User.create({ firstName: 'Mia', lastName: 'Member', email: 'mia@attendance.test' });
    stranger = await User.create({ firstName: 'Xan', lastName: 'Nopackage', email: 'xan@attendance.test' });
    insider = await User.create({ firstName: 'Ina', lastName: 'Inside', email: 'ina@attendance.test' });
    staff = await User.create({
      firstName: 'Stu',
      lastName: 'Staff',
      email: 'stu@attendance.test',
      role: 'receptionist',
      employment: { isStaff: true, jobTitle: 'Reception', schedule: [{ day: today, startTime: '10:00', endTime: '11:00' }] }
    });
    const now = new Date();
    await PackageOrder.create({
      orderNumber: 'ATT-1',
      userId: member._id,
      packageId: new h.state.mongoose.Types.ObjectId(),
      packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
      customerInfo: { fullName: 'Mia Member', email: 'mia@attendance.test' },
      payment: { method: 'cash', amount: 40, currency: 'GBP', status: 'paid', paidAt: now },
      subscription: { startDate: now, endDate: new Date(now.getTime() + 60 * 86400000), isActive: true },
      status: 'active'
    });
  });
});

const scan = (personType, person) => punch.recordPunch({ personType, personId: person._id, operator, device, method: 'manual' });

// The office, signed in as the desk operator (an administrator).
const asOperator = () => ({ id: String(operator._id), email: operator.email, role: 'admin' });
const correct = (id, body) => h.call(corrections.editTimes, { params: { id: String(id) }, body, user: asOperator() });
const voidVisit = (id, body) => h.call(corrections.voidVisit, { params: { id: String(id) }, body, user: asOperator() });
const setMemberScanOut = (memberScanOut) => h.call(corrections.updateSettings, { body: { memberScanOut }, user: asOperator() });

// A staff member as payroll reads them (see payrollService.generate).
const payee = (person) => User.findById(person._id).select('firstName lastName email employment').lean();

// This person's hours on the accounts overview for one day, or null when the
// overview does not list them (nothing to pay).
async function overviewHours(person, day) {
  const res = await h.call(accounts.overview, { query: { from: day, to: day } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const line = res.body.payroll.people.find((p) => p.id === String(person._id));
  return line ? line.hours : null;
}

// Set by the staff-window test, corrected and voided by the tests after it.
let forgotten;

// Moves an open visit's check-in into the past, as if it had happened then.
async function backdate(personId, minutes) {
  const row = await Attendance.findOne({ personId, checkOutAt: null }).sort({ checkInAt: -1 });
  await Attendance.collection.updateOne({ _id: row._id }, { $set: { checkInAt: h.minutesAgo(minutes) } });
}

// Runs fn with the NEXT findOne on this gym's attendance answering `answer`
// -- by default "nothing open", what a scan sees when it looked a moment
// before another desk's check-in was written; or a visit as it stood before
// another desk checked it out. Every later findOne is the real one.
async function withLookupRacedOnce(fn, answer = null) {
  const Model = Attendance.db.models.Attendance;
  const real = Model.findOne;
  let raced = false;
  Model.findOne = function (...args) {
    if (raced) return real.apply(this, args);
    raced = true;
    return { sort: async () => answer };
  };
  try {
    return await fn();
  } finally {
    delete Model.findOne;
    assert.equal(Model.findOne, real, 'the real findOne is back');
  }
}

test('a member checks in with the membership verdict and a front-desk code', async () => {
  await h.inGym(gym, async () => {
    const result = await scan('member', member);
    assert.equal(result.success, true, result.message);
    assert.equal(result.action, 'check_in');
    assert.equal(result.record.status, 'membership_active');
    assert.equal(result.record.membership.status, 'active');
    assert.equal(result.record.membership.packageName, 'Monthly');
    assert.equal(result.record.shiftDate, T.dateKey());
    assert.match(result.record.personCode, /^GP-\d{4}$/);
    assert.equal(result.detail.warning, null);
  });
});

test('a second scan straight away is ignored, not a check-out', async () => {
  await h.inGym(gym, async () => {
    const result = await scan('member', member);
    assert.equal(result.success, false);
    assert.equal(result.ignored, true);
    assert.equal(await Attendance.countDocuments({ personId: member._id }), 1);
  });
});

test('the next scan checks the member out on the same row and keeps the verdict they arrived with', async () => {
  await h.inGym(gym, async () => {
    await backdate(member._id, 95);
    const result = await scan('member', member);
    assert.equal(result.action, 'check_out', result.message);
    const rows = await Attendance.find({ personId: member._id }).lean();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(Math.abs(row.workedMinutes - 95) <= 1, `worked ${row.workedMinutes}`);
    assert.ok(row.checkOutAt instanceof Date);
    assert.equal(row.status, 'membership_active');
    assert.equal(row.checkIn.byName, 'Desk Operator');
    assert.equal(row.checkOut.device, 'DESK-1');
    assert.equal(row.open, undefined, 'a finished visit gives up the open-visit slot');
  });
});

test('staff: a late arrival stays late after an overtime check-out', async () => {
  await h.inGym(gym, async () => {
    const arrived = await scan('staff', staff);
    assert.equal(arrived.action, 'check_in', arrived.message);
    assert.equal(arrived.record.status, 'late');
    assert.match(arrived.record.statusLabel, /^Late by /);
    assert.ok(arrived.record.varianceMinutes > 60);
    assert.deepEqual(
      { hasSchedule: arrived.record.schedule.hasSchedule, startTime: arrived.record.schedule.startTime },
      { hasSchedule: true, startTime: '10:00' }
    );

    await backdate(staff._id, 180);
    const left = await scan('staff', staff);
    assert.equal(left.action, 'check_out', left.message);

    const row = await Attendance.findOne({ personId: staff._id }).lean();
    assert.equal(row.status, 'late', 'the arrival verdict is kept');
    assert.equal(row.statusLabel, arrived.record.statusLabel);
    assert.equal(row.departureStatus, 'overtime');
    assert.ok(Math.abs(row.workedMinutes - 180) <= 1);
    // The receipt is judged on the departure but still shows the arrival.
    assert.equal(left.detail.status, 'overtime');
    assert.ok(left.detail.rows.some((r) => r.caption === 'Arrival' && /^Late by /.test(r.value)));
  });
});

test('forgotten visits: "inside now" ignores them before the job runs, a new scan opens a new visit, the job marks them', async () => {
  await h.inGym(gym, async () => {
    const now = new Date();
    const yesterday = T.shiftDateKey(T.dateKey(), -1);
    const base = { personType: 'member', personName: 'seeded', personCode: '', status: 'membership_none', checkOut: {}, checkIn: {}, workedMinutes: null, autoClosed: false, autoClosedAt: null };
    const { insertedIds } = await Attendance.collection.insertMany([
      // Forgotten yesterday: open, 20 hours old.
      { ...base, personId: stranger._id, shiftDate: yesterday, checkInAt: h.minutesAgo(20 * 60, now), checkOutAt: null },
      // In the building now: open, two hours old.
      { ...base, personId: insider._id, shiftDate: T.dateKey(), checkInAt: h.minutesAgo(120, now), checkOutAt: null },
      // Closed properly yesterday.
      { ...base, personId: insider._id, shiftDate: yesterday, checkInAt: h.minutesAgo(21 * 60, now), checkOutAt: h.minutesAgo(19 * 60, now), workedMinutes: 120 }
    ]);
    const forgottenId = insertedIds[0];

    // Before the job: the 20-hour-old visit is already not "inside".
    const inside = await Attendance.find(stale.openVisitMatch(now)).lean();
    assert.deepEqual(inside.map((r) => String(r.personId)), [String(insider._id)]);
    const [tally] = await Attendance.aggregate([{ $group: { _id: null, in_now: { $sum: { $cond: [stale.openVisitExpr(now), 1, 0] } } } }]);
    assert.equal(tally.in_now, 1);
    assert.equal(await Attendance.exists({ personId: stranger._id, ...stale.openVisitMatch(now) }), null);

    // The forgetful member walks in today: a new visit, not a check-out of yesterday's.
    const back = await scan('member', stranger);
    assert.equal(back.action, 'check_in', back.message);
    assert.equal(back.record.status, 'membership_none');
    const forgotten = await Attendance.findById(forgottenId).lean();
    assert.equal(forgotten.checkOutAt, null);

    // The job.
    assert.equal(await stale.closeStaleVisits({ now, dryRun: true }), 1);
    assert.equal(await stale.closeStaleVisits({ now }), 1);
    assert.equal(await stale.closeStaleVisits({ now }), 0, 'running it again changes nothing');
    const marked = await Attendance.findById(forgottenId).lean();
    assert.equal(marked.autoClosed, true);
    assert.ok(marked.autoClosedAt instanceof Date);
    assert.equal(marked.checkOutAt, null, 'no check-out time is invented');
    assert.equal(marked.workedMinutes, null, 'no hours are invented');

    // The desk's board for today: two people in (Ina since 2h ago, Xan just now).
    const res = await h.call(desktop.recent, { body: { limit: 50 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.counts.in_now, 2);
    assert.equal(res.body.entries.filter((e) => e.still_in).length, 2);
  });
});

test('two scans of one finger arriving together open one visit, not two', async () => {
  await h.inGym(gym, async () => {
    const twin = await User.create({ firstName: 'Tia', lastName: 'Twice', email: 'tia@attendance.test' });
    const results = await Promise.all([scan('member', twin), scan('member', twin)]);
    const summary = results.map((r) => r.action || r.message).join(', ');
    const open = await Attendance.countDocuments({ personId: twin._id, checkOutAt: null });
    assert.equal(open, 1, `${open} open visits (${summary})`);

    // One check-in, and the other scan answered as the repeat it is -- the
    // same answer, receipt and all, as a second scan a moment later.
    assert.equal(results.filter((r) => r.action === 'check_in').length, 1, summary);
    const repeat = results.find((r) => r.action !== 'check_in');
    assert.equal(repeat.success, false);
    assert.equal(repeat.ignored, true);
    assert.equal(repeat.message, 'Already checked in a moment ago.');
    assert.equal(repeat.detail.action, 'ignore');
    assert.equal(repeat.detail.person_name, 'Tia Twice');
  });
});

test('a scan that looked just before another desk checked the person in is the repeat, whatever the timing', async () => {
  await h.inGym(gym, async () => {
    const pair = await User.create({ firstName: 'Pat', lastName: 'Pair', email: 'pat@attendance.test' });
    const first = await scan('member', pair);
    assert.equal(first.action, 'check_in', first.message);

    // The second scan's "is anyone open?" is answered as if it ran before the
    // first scan's insert, so it goes on to insert its own check-in -- and the
    // index turns it away.
    const second = await withLookupRacedOnce(() => scan('member', pair));
    assert.equal(second.success, false, second.message);
    assert.equal(second.ignored, true);
    assert.equal(second.message, 'Already checked in a moment ago.');
    assert.equal(second.detail.action, 'ignore');
    assert.equal(second.detail.check_in_time, first.detail.check_in_time, "the receipt is the first scan's visit");

    const rows = await Attendance.find({ personId: pair._id }).lean();
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]._id), String(first.record._id));
    assert.equal(rows[0].open, true);
  });
});

test('forgot to check out yesterday, checks in today: a new visit, and yesterday is left for the job', async () => {
  await h.inGym(gym, async () => {
    const forgetful = await User.create({ firstName: 'Fay', lastName: 'Forgot', email: 'fay@attendance.test' });
    const monday = await scan('member', forgetful);
    assert.equal(monday.action, 'check_in', monday.message);
    // Twenty hours on: past the window, never checked out, not yet
    // auto-closed -- and still holding the open-visit flag it was given.
    await backdate(forgetful._id, 20 * 60);
    assert.equal((await Attendance.findById(monday.record._id).lean()).open, true);

    const tuesday = await scan('member', forgetful);
    assert.equal(tuesday.action, 'check_in', tuesday.message);
    assert.equal(tuesday.success, true);

    const before = await Attendance.findById(monday.record._id).lean();
    assert.equal(before.checkOutAt, null, 'no check-out is invented for yesterday');
    assert.equal(before.workedMinutes, null);
    assert.equal(before.autoClosed, false, 'closing it is still the job\'s call');
    assert.equal(before.open, undefined, 'it has let go of the open-visit slot');
    assert.equal((await Attendance.findById(tuesday.record._id).lean()).open, true);

    // The job marks yesterday's and leaves today's alone.
    await stale.closeStaleVisits();
    const [marked, current] = await Promise.all([
      Attendance.findById(monday.record._id).lean(),
      Attendance.findById(tuesday.record._id).lean()
    ]);
    assert.equal(marked.autoClosed, true);
    assert.equal(current.autoClosed, false);
    assert.equal(current.open, true);

    // And today's visit closes normally.
    await backdate(forgetful._id, 60);
    const out = await scan('member', forgetful);
    assert.equal(out.action, 'check_out', out.message);
    assert.equal(String(out.record._id), String(tuesday.record._id));
    assert.equal(await Attendance.countDocuments({ personId: forgetful._id }), 2);
  });
});

test('the daily job releases the open-visit slot of a visit it closes', async () => {
  await h.inGym(gym, async () => {
    const gone = await User.create({ firstName: 'Gus', lastName: 'Gone', email: 'gus@attendance.test' });
    const visit = await scan('member', gone);
    assert.equal(visit.action, 'check_in', visit.message);
    await backdate(gone._id, 20 * 60);

    await stale.closeStaleVisits();
    const row = await Attendance.findById(visit.record._id).lean();
    assert.equal(row.autoClosed, true);
    assert.equal(row.open, undefined);
    assert.equal(row.checkOutAt, null, 'no check-out is invented');

    const back = await scan('member', gone);
    assert.equal(back.action, 'check_in', back.message);
    assert.equal(await Attendance.countDocuments({ personId: gone._id, open: true }), 1);
  });
});

test('staff: past the rostered shift and its grace, the next scan starts a new visit instead of paying for the night', async () => {
  await h.inGym(gym, async () => {
    const today = T.dateKey();
    const worker = await User.create({
      firstName: 'Nia',
      lastName: 'Noout',
      email: 'nia@attendance.test',
      role: 'receptionist',
      employment: {
        isStaff: true,
        jobTitle: 'Reception',
        schedule: [{ day: T.weekdayNameForKey(today), startTime: '05:00', endTime: '07:00' }],
        payroll: { basis: 'hourly', hourlyRate: 10, currency: 'GBP' }
      }
    });

    const arrived = await scan('staff', worker);
    assert.equal(arrived.action, 'check_in', arrived.message);
    // Past noon, after the 05:00-07:00 shift had ended: no roster to go by,
    // so the staff default -- not a member's 18 hours.
    assert.equal(arrived.record.openUntil.getTime() - arrived.record.checkInAt.getTime(), stale.STAFF_OPEN_HOURS * 3600000);

    // As if the desk had recorded it at 06:00, inside the shift, and nobody
    // scanned out: open until 07:00 plus the grace, which has passed.
    const checkInAt = T.localInstant(today, 6, 0);
    const openUntil = stale.staffOpenUntil(arrived.record.schedule, checkInAt, today);
    assert.equal(openUntil.getTime(), T.localInstant(today, 7 + stale.STAFF_SHIFT_GRACE_HOURS, 0).getTime());
    await Attendance.collection.updateOne({ _id: arrived.record._id }, { $set: { checkInAt, openUntil } });

    // Every "on shift now" question agrees, before any job has run.
    const now = new Date();
    const row = await Attendance.findById(arrived.record._id).lean();
    assert.equal(stale.isOpenVisit(row, now), false);
    assert.equal(stale.missedCheckOut(row, now), true);
    assert.equal(await Attendance.exists({ personId: worker._id, ...stale.openVisitMatch(now) }), null);
    const [tally] = await Attendance.aggregate([
      { $match: { personId: worker._id } },
      { $group: { _id: null, open: { $sum: { $cond: [stale.openVisitExpr(now), 1, 0] } } } }
    ]);
    assert.equal(tally.open, 0);

    // And the office's "No check-out" filter lists it.
    const missed = await h.call(admin.records, { query: { from: today, to: today, personId: String(worker._id), presence: 'missed' } });
    assert.equal(missed.statusCode, 200, JSON.stringify(missed.body));
    assert.equal(missed.body.pagination.total, 1);
    assert.equal(missed.body.records[0].no_check_out, true);

    // Back again: a new visit, not a check-out of the old one.
    const back = await scan('staff', worker);
    assert.equal(back.action, 'check_in', back.message);
    const old = await Attendance.findById(arrived.record._id).lean();
    assert.equal(old.checkOutAt, null, 'no check-out is invented');
    assert.equal(old.workedMinutes, null, 'and no hours are paid');
    assert.equal(old.open, undefined, 'it has let go of the open-visit slot');

    forgotten = { worker, visitId: arrived.record._id, nextId: back.record._id, today };
  });
});

test('staff with no roster that day are open for the staff default, not the 18 hours members get', async () => {
  await h.inGym(gym, async () => {
    const loose = await User.create({
      firstName: 'Lee',
      lastName: 'Loose',
      email: 'lee@attendance.test',
      role: 'cleaner',
      employment: { isStaff: true, jobTitle: 'Cleaner', schedule: [] }
    });
    const arrived = await scan('staff', loose);
    assert.equal(arrived.action, 'check_in', arrived.message);
    assert.equal(arrived.record.status, 'no_schedule');

    // Fifteen hours on: inside a member's window, past a staff one.
    const checkInAt = h.minutesAgo(15 * 60);
    const openUntil = stale.staffOpenUntil(arrived.record.schedule, checkInAt, arrived.record.shiftDate);
    await Attendance.collection.updateOne({ _id: arrived.record._id }, { $set: { checkInAt, openUntil } });

    const back = await scan('staff', loose);
    assert.equal(back.action, 'check_in', back.message);
    assert.equal((await Attendance.findById(arrived.record._id).lean()).workedMinutes, null);
  });
});

test('the office sets a missing check-out: hours, the departure verdict and the history follow', async () => {
  await h.inGym(gym, async () => {
    const { worker, visitId, nextId, today } = forgotten;
    // The next visit began at 09:00 (as if), so a check-out past that would
    // overlap it. And the daily job has had its say on the forgotten one.
    await Attendance.collection.updateOne({ _id: nextId }, { $set: { checkInAt: T.localInstant(today, 9, 0) } });
    await Attendance.collection.updateOne({ _id: visitId }, { $set: { autoClosed: true, autoClosedAt: new Date() } });

    const refused = async (body, status, pattern) => {
      const res = await correct(visitId, body);
      assert.equal(res.statusCode, status, JSON.stringify(res.body));
      assert.match(res.body.message, pattern);
    };
    await refused({ checkOutAt: `${today}T08:15` }, 400, /note/i);
    await refused({ note: 'x' }, 400, /check-in or a check-out/);
    await refused({ checkOutAt: 'soon', note: 'x' }, 400, /could not be read/);
    await refused({ checkOutAt: `${today}T05:30`, note: 'x' }, 400, /after the check-in/);
    await refused({ checkOutAt: `${T.shiftDateKey(today, 1)}T08:00`, note: 'x' }, 400, /future/);
    await refused({ checkInAt: `${T.shiftDateKey(today, -1)}T06:00`, note: 'x' }, 400, /must stay on/);
    await refused({ checkOutAt: `${today}T10:00`, note: 'x' }, 409, /overlap/);
    await refused({ checkInAt: `${today}T06:00`, note: 'x' }, 400, /already recorded/);
    assert.equal((await correct('not-an-id', { checkOutAt: `${today}T08:15`, note: 'x' })).statusCode, 400);
    assert.equal((await correct(new h.state.mongoose.Types.ObjectId(), { checkOutAt: `${today}T08:15`, note: 'x' })).statusCode, 404);
    assert.equal((await Attendance.findById(visitId).lean()).edits.length, 0, 'nothing refused was written');

    const res = await correct(visitId, { checkOutAt: `${today}T08:15`, note: 'Forgot to scan out' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.record.worked_minutes, 135);
    assert.equal(res.body.record.no_check_out, false);
    assert.equal(res.body.record.edited, true);
    assert.equal(res.body.record.voided, false);
    assert.equal(res.body.record.last_correction.note, 'Forgot to scan out');
    assert.equal(res.body.record.last_correction.by_name, 'Desk Operator');

    const row = await Attendance.findById(visitId).lean();
    assert.equal(row.checkOutAt.getTime(), T.localInstant(today, 8, 15).getTime(), 'read as a time at the gym');
    assert.equal(row.workedMinutes, 135);
    assert.equal(row.autoClosed, false, 'no longer a visit without a check-out');
    assert.equal(row.autoClosedAt, null);
    assert.equal(row.status, 'late', 'arrived 06:00 on a 05:00 roster');
    assert.equal(row.departureStatus, 'overtime', 'left 08:15 on a 07:00 roster');
    assert.equal(row.edits.length, 1);
    const [edit] = row.edits;
    assert.equal(edit.action, 'edit');
    assert.equal(String(edit.by), String(operator._id));
    assert.equal(edit.byName, 'Desk Operator');
    assert.equal(edit.before.checkInAt.getTime(), T.localInstant(today, 6, 0).getTime());
    assert.equal(edit.before.checkOutAt, null);
    assert.equal(edit.before.workedMinutes, null);
    assert.equal(edit.after.checkOutAt.getTime(), row.checkOutAt.getTime());
    assert.equal(edit.after.workedMinutes, 135);

    // Paid for, on the payslip and on the accounts overview alike.
    const slip = await payroll.draftFor(await payee(worker), L.readRange({ from: today, to: today }));
    assert.equal(slip.hours, 2.25);
    assert.equal(await overviewHours(worker, today), 2.3);

    // The person's own screen says the visit was corrected.
    const mine = await h.call(h.src('attendance/controller/myAttendanceController').me, { user: { id: String(worker._id) } });
    assert.equal(mine.statusCode, 200, JSON.stringify(mine.body));
    const corrected = mine.body.visits.find((v) => v.id === String(visitId));
    assert.equal(corrected.edited, true);
    assert.equal(corrected.voided, false);
    assert.equal(mine.body.visits.find((v) => v.id === String(nextId)).edited, false);
  });
});

test('a voided visit is kept for the record and counted nowhere: not in totals, not in pay', async () => {
  await h.inGym(gym, async () => {
    const { worker, visitId, today } = forgotten;

    const noReason = await voidVisit(visitId, {});
    assert.equal(noReason.statusCode, 400);
    assert.match(noReason.body.message, /reason/);

    const res = await voidVisit(visitId, { reason: 'Scanned the wrong person' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.record.voided, true);
    assert.equal(res.body.record.void_reason, 'Scanned the wrong person');
    assert.equal(res.body.record.no_check_out, false);
    assert.equal(res.body.record.still_in, false);

    assert.equal((await voidVisit(visitId, { reason: 'again' })).statusCode, 409);
    const edit = await correct(visitId, { checkOutAt: `${today}T08:00`, note: 'x' });
    assert.equal(edit.statusCode, 409);
    assert.match(edit.body.message, /voided/);

    // Kept, with its times and its history...
    const kept = await Attendance.findById(visitId).setOptions({ withVoided: true }).lean();
    assert.equal(kept.voided, true);
    assert.equal(kept.voidReason, 'Scanned the wrong person');
    assert.ok(kept.voidedAt instanceof Date);
    assert.equal(kept.workedMinutes, 135, 'the times are left as they were');
    assert.deepEqual(kept.edits.map((e) => e.action), ['edit', 'void']);
    assert.equal(kept.edits[1].note, 'Scanned the wrong person');

    // ...and read by nobody unless they ask.
    assert.equal(await Attendance.findById(visitId).lean(), null);
    assert.equal(await Attendance.countDocuments({ personId: worker._id }), 1);
    assert.equal(await Attendance.countDocuments({ personId: worker._id }).setOptions({ withVoided: true }), 2);
    assert.equal(await Attendance.countDocuments({ personId: worker._id, voided: true }), 1, 'a read that asks about voided rows gets them');
    const count = async (options) => {
      const aggregate = Attendance.aggregate([{ $match: { personId: worker._id } }, { $group: { _id: null, n: { $sum: 1 } } }]);
      const [result] = await (options ? aggregate.option(options) : aggregate);
      return result.n;
    };
    assert.equal(await count(), 1);
    assert.equal(await count({ withVoided: true }), 2);

    // The office's totals, the person's own screen, the payslip and the
    // accounts overview all agree it did not happen.
    const log = await h.call(admin.records, { query: { from: today, to: today, personId: String(worker._id) } });
    assert.equal(log.statusCode, 200, JSON.stringify(log.body));
    assert.equal(log.body.summary.visits, 1);
    assert.equal(log.body.summary.total_minutes, 0);

    const mine = await h.call(h.src('attendance/controller/myAttendanceController').me, { user: { id: String(worker._id) } });
    assert.equal(mine.body.summary.visits, 1);
    assert.equal(mine.body.summary.total_minutes, 0);
    assert.equal(mine.body.summary.this_month.visits, 1);
    assert.equal(mine.body.months.reduce((n, m) => n + m.visits, 0), 1);
    assert.equal(mine.body.visits.length, 1);
    assert.ok(mine.body.visits.every((v) => v.voided === false));

    const slip = await payroll.draftFor(await payee(worker), L.readRange({ from: today, to: today }));
    assert.equal(slip.hours, 0);
    assert.equal(await overviewHours(worker, today), null);
  });
});

test('two desks checking one person out at once: one check-out, and the other desk is told it was the repeat', async () => {
  await h.inGym(gym, async () => {
    const rae = await User.create({ firstName: 'Rae', lastName: 'Race', email: 'rae@attendance.test' });
    const inside = await scan('member', rae);
    assert.equal(inside.action, 'check_in', inside.message);
    await backdate(rae._id, 40);

    // What the slower desk read: the visit, still open.
    const asRead = await Attendance.findById(inside.record._id);
    const first = await scan('member', rae);
    assert.equal(first.action, 'check_out', first.message);

    const second = await withLookupRacedOnce(() => scan('member', rae), asRead);
    assert.equal(second.success, false, second.message);
    assert.equal(second.ignored, true);
    assert.equal(second.message, 'Already checked out a moment ago.');
    assert.equal(second.detail.action, 'ignore');
    assert.equal(second.detail.check_out_time, first.detail.check_out_time);
    const row = await Attendance.findById(inside.record._id).lean();
    assert.equal(row.checkOutAt.getTime(), first.record.checkOutAt.getTime(), 'the first desk\'s check-out stands');

    // And genuinely at once, whichever way the timing falls.
    const sam = await User.create({ firstName: 'Sam', lastName: 'Same', email: 'sam@attendance.test' });
    assert.equal((await scan('member', sam)).action, 'check_in');
    await backdate(sam._id, 40);
    const results = await Promise.all([scan('member', sam), scan('member', sam)]);
    const summary = results.map((r) => r.action || r.message).join(', ');
    assert.equal(results.filter((r) => r.action === 'check_out').length, 1, summary);
    assert.equal(results.find((r) => r.action !== 'check_out').message, 'Already checked out a moment ago.', summary);
    assert.equal(await Attendance.countDocuments({ personId: sam._id, checkOutAt: { $ne: null } }), 1);
  });
});

test('a gym where members only scan in: each scan past the guard is a new visit, and the one before closes with no duration', async () => {
  await h.inGym(gym, async () => {
    assert.equal((await h.call(corrections.settings)).body.settings.member_scan_out, true, 'on by default');
    assert.equal((await setMemberScanOut('no')).statusCode, 400);

    const regular = await User.create({ firstName: 'Reg', lastName: 'Ular', email: 'reg@attendance.test' });
    const off = await setMemberScanOut(false);
    assert.equal(off.statusCode, 200, JSON.stringify(off.body));
    try {
      assert.equal((await h.call(corrections.settings)).body.settings.member_scan_out, false);

      const first = await scan('member', regular);
      assert.equal(first.action, 'check_in', first.message);
      const repeat = await scan('member', regular);
      assert.equal(repeat.ignored, true, 'the double-scan guard still applies');
      assert.equal(repeat.message, 'Already checked in a moment ago.');

      await backdate(regular._id, 95);
      const second = await scan('member', regular);
      assert.equal(second.action, 'check_in', second.message);

      const [earlier, later] = await Attendance.find({ personId: regular._id }).sort({ checkInAt: 1 }).lean();
      assert.equal(String(earlier._id), String(first.record._id));
      assert.equal(earlier.autoClosed, true);
      assert.ok(earlier.autoClosedAt instanceof Date);
      assert.equal(earlier.checkOutAt, null, 'no check-out is invented');
      assert.equal(earlier.workedMinutes, null, 'and no 95-minute duration');
      assert.equal(earlier.open, undefined);
      assert.equal(String(later._id), String(second.record._id));
      assert.equal(later.open, true);
    } finally {
      const on = await setMemberScanOut(true);
      assert.equal(on.body.settings.member_scan_out, true);
    }

    // Back on: the next scan is a check-out again.
    await backdate(regular._id, 30);
    const out = await scan('member', regular);
    assert.equal(out.action, 'check_out', out.message);
  });
});

test('the desk does not offer a renewal to a member whose subscription renews itself', async () => {
  await h.inGym(gym, async () => {
    const now = new Date();
    const inThreeDays = new Date(now.getTime() + 3 * 86400000);
    const subscribe = (user, n, subscription) =>
      PackageOrder.create({
        orderNumber: `ATT-R${n}`,
        userId: user._id,
        packageId: new h.state.mongoose.Types.ObjectId(),
        packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
        customerInfo: { fullName: `${user.firstName} ${user.lastName}`, email: user.email },
        payment: { method: 'stripe', amount: 40, currency: 'GBP', status: 'paid', paidAt: now, stripeSubscriptionId: `sub_att_${n}` },
        subscription: {
          startDate: new Date(now.getTime() - 27 * 86400000),
          endDate: inThreeDays,
          isActive: true,
          autoRenew: true,
          stripeStatus: 'active',
          ...subscription
        },
        status: 'active'
      });

    const sue = await User.create({ firstName: 'Sue', lastName: 'Subscriber', email: 'sue@attendance.test' });
    const lou = await User.create({ firstName: 'Lou', lastName: 'Leaving', email: 'lou@attendance.test' });
    await subscribe(sue, 1, {});
    await subscribe(lou, 2, { autoRenew: false, cancelAtPeriodEnd: true });

    const renews = await scan('member', sue);
    assert.equal(renews.action, 'check_in', renews.message);
    assert.equal(renews.record.status, 'membership_active');
    assert.equal(renews.record.statusLabel, `Renews automatically on ${T.dateLabel(inThreeDays)}`);
    assert.equal(renews.detail.warning, null);

    // Cancelled at the period's end: it really is running out.
    const ends = await scan('member', lou);
    assert.equal(ends.record.status, 'membership_expiring');
    assert.match(ends.detail.warning, /^EXPIRES IN 3 DAYS/);
  });
});

// A member with one paid order, `endIn` days from now (negative: ended).
async function memberWithOrder(name, n, { endIn = 60, orderStatus = 'active', payment = {} } = {}) {
  const now = new Date();
  const user = await User.create({ firstName: name, lastName: 'Fixture', email: `${name.toLowerCase()}@attendance.test` });
  await PackageOrder.create({
    orderNumber: `ATT-F${n}`,
    userId: user._id,
    packageId: new h.state.mongoose.Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
    customerInfo: { fullName: `${name} Fixture`, email: user.email },
    payment: { method: 'cash', amount: 40, currency: 'GBP', status: 'paid', paidAt: now, ...payment },
    subscription: { startDate: new Date(now.getTime() - 30 * 86400000), endDate: new Date(now.getTime() + endIn * 86400000), isActive: endIn > 0 },
    status: orderStatus
  });
  return user;
}

const readSettings = () => h.call(corrections.settings, { user: asOperator() });
const putSettings = (body) => h.call(corrections.updateSettings, { body, user: asOperator() });

test('the desk voice: defaults until the gym words it, saved field by field, blank goes back to the default', async () => {
  await h.inGym(gym, async () => {
    const before = await readSettings();
    assert.equal(before.statusCode, 200, JSON.stringify(before.body));
    assert.deepEqual(before.body.settings.voice, {
      enabled: true,
      expired_message: 'Fee expired, please renew',
      expiring_message: 'Your fee expires soon',
      balance_due_message: 'Please clear your balance'
    });
    assert.deepEqual(before.body.settings.voice_defaults, before.body.settings.voice);

    const saved = await putSettings({ voice: { enabled: false, expiredMessage: '  Fees due,   see reception ' } });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.settings.voice.enabled, false);
    assert.equal(saved.body.settings.voice.expired_message, 'Fees due, see reception');
    assert.equal(saved.body.settings.voice.expiring_message, 'Your fee expires soon', 'what was not sent is left alone');
    assert.equal(saved.body.settings.member_scan_out, true, 'and so is the scan-out setting');

    const after = (await readSettings()).body.settings;
    assert.equal(after.voice.enabled, false);
    assert.equal(after.voice.expired_message, 'Fees due, see reception');

    const reset = await putSettings({ voice: { enabled: true, expiredMessage: '' } });
    assert.equal(reset.statusCode, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.settings.voice.enabled, true);
    assert.equal(reset.body.settings.voice.expired_message, 'Fee expired, please renew');
  });
});

test('the punch says which sound to play and what to say: expired, expiring, fine, staff, and the voice switched off', async () => {
  await h.inGym(gym, async () => {
    const lapsed = await memberWithOrder('Lapsed', 1, { endIn: -4 });
    const ending = await memberWithOrder('Ending', 2, { endIn: 3 });
    const fine = await memberWithOrder('Fine', 3, { endIn: 40 });
    const frozen = await memberWithOrder('Frozen', 4, { endIn: 40, orderStatus: 'frozen' });

    const expired = await scan('member', lapsed);
    assert.equal(expired.action, 'check_in', expired.message);
    assert.equal(expired.detail.status, 'membership_expired');
    assert.deepEqual(expired.detail.alert, { level: 'problem', speech: 'Fee expired, please renew' });

    const soon = await scan('member', ending);
    assert.equal(soon.detail.status, 'membership_expiring');
    assert.deepEqual(soon.detail.alert, { level: 'warning', speech: 'Your fee expires soon' });

    const ok = await scan('member', fine);
    assert.deepEqual(ok.detail.alert, { level: 'ok', speech: null });

    // Frozen sounds like a problem, but nobody is told to renew.
    const paused = await scan('member', frozen);
    assert.equal(paused.detail.status, 'membership_frozen');
    assert.deepEqual(paused.detail.alert, { level: 'problem', speech: null });

    // The desk's JSON carries it as-is.
    const colleague = await User.create({ firstName: 'Col', lastName: 'League', email: 'col@attendance.test', role: 'receptionist', employment: { isStaff: true, jobTitle: 'Reception' } });
    const staffPunch = await scan('staff', colleague);
    assert.equal(staffPunch.action, 'check_in', staffPunch.message);
    assert.equal(staffPunch.detail.alert, null, 'staff have no membership to warn about');

    // The check-out repeats the check-in's alert, as it repeats the warning.
    await backdate(lapsed._id, 60);
    const out = await scan('member', lapsed);
    assert.equal(out.action, 'check_out', out.message);
    assert.deepEqual(out.detail.alert, { level: 'problem', speech: 'Fee expired, please renew' });

    // A repeat scan is neither: nothing to play.
    const repeat = await scan('member', lapsed);
    assert.equal(repeat.ignored, true);
    assert.equal(repeat.detail.alert, null);

    // The gym's own words, then the voice off: the sound stays, the words go.
    await putSettings({ voice: { expiringMessage: 'Renew this week please' } });
    const worded = await scan('member', await memberWithOrder('Ending2', 5, { endIn: 2 }));
    assert.equal(worded.action, 'check_in', worded.message);
    assert.deepEqual(worded.detail.alert, { level: 'warning', speech: 'Renew this week please' });

    await putSettings({ voice: { enabled: false } });
    try {
      const quiet = await scan('member', await memberWithOrder('Lapsed2', 6, { endIn: -1 }));
      assert.deepEqual(quiet.detail.alert, { level: 'problem', speech: null });
    } finally {
      await putSettings({ voice: { enabled: true, expiringMessage: '' } });
    }
  });
});

// payment.balanceDue arrives with the package-order work (membership
// module); written straight to the collection here, so these tests hold
// whether or not this branch's order schema has the field yet.
async function owe(user, balanceDue, extra = {}) {
  await PackageOrder.collection.updateOne({ userId: user._id }, { $set: { 'payment.balanceDue': balanceDue, ...extra } });
}

test('a balance owing: checked in all the same, told "Balance due" in the order\'s currency, with the warning sound and words', async () => {
  await h.inGym(gym, async () => {
    const owes = await memberWithOrder('Owes', 11, { endIn: 40 });
    await owe(owes, 25);

    const inside = await scan('member', owes);
    assert.equal(inside.success, true, inside.message);
    assert.equal(inside.action, 'check_in', 'money owing never stops the visit');
    assert.equal(inside.detail.status, 'membership_active');
    assert.equal(inside.detail.warning, 'Balance due £25');
    assert.equal(inside.detail.balance_due, 25);
    assert.equal(inside.detail.balance_due_label, 'Balance due £25');
    assert.deepEqual(inside.detail.alert, { level: 'warning', speech: 'Please clear your balance' });
    assert.equal(inside.record.membership.balanceDue, 25);
    assert.equal(inside.record.membership.currency, 'GBP');

    // The check-out says it again, from what was owed on the way in.
    await backdate(owes._id, 60);
    const out = await scan('member', owes);
    assert.equal(out.action, 'check_out', out.message);
    assert.equal(out.detail.warning, 'Balance due £25');
    assert.deepEqual(out.detail.alert, { level: 'warning', speech: 'Please clear your balance' });

    // Running out AND owing: one line, both said.
    const both = await memberWithOrder('Both', 12, { endIn: 3 });
    await owe(both, 12.5);
    const bothIn = await scan('member', both);
    assert.equal(bothIn.detail.status, 'membership_expiring');
    assert.equal(bothIn.detail.warning, 'EXPIRES IN 3 DAYS · Balance due £12.50');
    assert.deepEqual(bothIn.detail.alert, { level: 'warning', speech: 'Your fee expires soon. Please clear your balance.' });

    // An order that names no currency is in the gym's.
    const bare = await memberWithOrder('Bare', 13, { endIn: 40 });
    await owe(bare, 40, { 'payment.currency': '' });
    const bareIn = await scan('member', bare);
    assert.equal(bareIn.detail.warning, 'Balance due £40');

    // Nothing owed (0, or an order from before the field) is nothing at all.
    const clear = await memberWithOrder('Clear', 14, { endIn: 40 });
    await owe(clear, 0);
    const clearIn = await scan('member', clear);
    assert.equal(clearIn.detail.warning, null);
    assert.equal(clearIn.detail.balance_due, 0);
    assert.deepEqual(clearIn.detail.alert, { level: 'ok', speech: null });
  });
});

test("the office's live view of today: arrival numbers, contacts, package, expiry, paid or not, and the day's counts", async () => {
  await h.inGym(gym, async () => {
    const paidUp = await memberWithOrder('Livepaid', 21, { endIn: 40 });
    const lapsedLive = await memberWithOrder('Livelapsed', 22, { endIn: -2 });
    const owesLive = await memberWithOrder('Liveowes', 23, { endIn: 40 });
    await owe(owesLive, 15);
    await User.updateOne({ _id: paidUp._id }, { $set: { phone: '+44 7700 900123', gender: 'female' } });
    await User.updateOne({ _id: lapsedLive._id }, { $set: { phone: '+44 7700 900456', gender: 'male' } });

    for (const person of [paidUp, lapsedLive, owesLive]) {
      const punched = await scan('member', person);
      assert.equal(punched.action, 'check_in', punched.message);
    }

    const res = await h.call(admin.live, { query: {}, user: asOperator() });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const { records, counts } = res.body;
    assert.equal(res.body.today, T.dateKey());
    assert.ok(res.body.date_label.includes(T.dateLabelForKey(T.dateKey())));

    // Every visit today, newest first, numbered in the order they arrived.
    const todayRows = await Attendance.countDocuments({ shiftDate: T.dateKey() });
    assert.equal(records.length, todayRows);
    assert.equal(counts.visits, todayRows);
    assert.equal(records[0].number, todayRows, 'the newest arrival is the highest number');
    const numbers = records.map((r) => r.number);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a));

    const row = (user) => records.find((r) => r.person_id === String(user._id));
    const paidRow = row(paidUp);
    assert.equal(paidRow.name, 'Livepaid Fixture');
    assert.match(paidRow.code, /^GP-\d{4}$/);
    assert.equal(paidRow.phone, '+44 7700 900123');
    assert.equal(paidRow.gender, 'female');
    assert.equal(paidRow.package_name, 'Monthly');
    assert.match(paidRow.end_date_label, /^\d{2} [A-Z][a-z]{2} \d{4}$/);
    assert.ok(paidRow.check_in_time);
    assert.equal(paidRow.check_out_time, null);
    assert.equal(paidRow.still_in, true);
    assert.deepEqual(paidRow.standing, { key: 'paid', label: 'Paid' });
    assert.equal(paidRow.paid, true);

    const lapsedRow = row(lapsedLive);
    assert.deepEqual(lapsedRow.standing, { key: 'unpaid', label: 'Unpaid' });
    assert.equal(lapsedRow.paid, false);
    assert.equal(lapsedRow.status, 'membership_expired');
    assert.equal(lapsedRow.number, paidRow.number + 1, 'scanned straight after');

    const owesRow = row(owesLive);
    assert.deepEqual(owesRow.standing, { key: 'balance_due', label: 'Balance due £15' });
    assert.equal(owesRow.balance_due, 15);
    assert.equal(owesRow.paid, true, 'money owing on a running package is still paid');

    // The day's counts: every member once, split paid / unpaid.
    const members = new Set((await Attendance.find({ shiftDate: T.dateKey(), personType: 'member' }).select('personId').lean()).map((r) => String(r.personId)));
    assert.equal(counts.members, members.size);
    assert.equal(counts.paid + counts.unpaid, counts.members);
    assert.ok(counts.balance_due >= 1);
    assert.ok(counts.in_now >= 3);

    // Filters narrow the rows, not the counts or the numbers.
    const found = await h.call(admin.live, { query: { q: '900456' }, user: asOperator() });
    assert.deepEqual(found.body.records.map((r) => r.person_id), [String(lapsedLive._id)], 'found by phone number');
    assert.equal(found.body.records[0].number, lapsedRow.number);
    assert.deepEqual(found.body.counts, counts);
    const staffOnly = await h.call(admin.live, { query: { personType: 'staff' }, user: asOperator() });
    assert.ok(staffOnly.body.records.length > 0);
    assert.ok(staffOnly.body.records.every((r) => r.person_type === 'staff' && r.standing.key === 'staff' && r.package_name === ''));

    // The desk's board carries the expiry too.
    const board = await h.call(desktop.recent, { body: { limit: 200 } });
    const boardRow = board.body.entries.find((e) => e.name === 'Livepaid Fixture');
    assert.equal(boardRow.end_date_label, paidRow.end_date_label);
    assert.ok(board.body.entries.filter((e) => e.person_type === 'staff').every((e) => e.end_date_label === null));
  });
});
