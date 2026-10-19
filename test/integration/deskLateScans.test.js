// Punches the Windows desk queued while offline and sent later, placed among
// what other desks and the daily job recorded in the meantime, against a real
// MongoDB. Each carries `scanned_at`, and is judged by that moment:
//
//   * the daily job may have closed a visit as forgotten between the scan and
//     its upload: the queued scan is still that visit's check-out, never a
//     made-up check-in;
//   * a scan from before the person's latest visit is an earlier, separate
//     visit: recorded, shown as "No check-out" unless the queue closes it,
//     and never dropped as "already checked in";
//   * a scan inside a visit recorded in and out around it adds nothing, and
//     says so in its own words;
//   * a scan seconds from another desk's punch is that punch's repeat.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let User;
let PackageOrder;
let Attendance;
let desktop;
let staleVisits;
let operator;

const deskA = { deviceLabel: 'DESK-A', osUser: 'frontdesk', clientApp: 'GymPilotAttendanceDesktop/1.5.0', ip: '10.0.0.1' };
const deskB = { deviceLabel: 'DESK-B', osUser: 'frontdesk', clientApp: 'GymPilotAttendanceDesktop/1.5.0', ip: '10.0.0.2' };

const test = h.suite(async () => {
  User = h.src('models/user');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Attendance = h.src('attendance/models/attendanceModel');
  desktop = h.src('attendance/controller/desktopAppController');
  staleVisits = h.src('attendance/services/staleVisits');

  gym = await h.createGym('late-scans-gym', { timezone: h.middayZone() });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(Attendance, User);
    operator = await User.create({ firstName: 'Desk', lastName: 'Late', email: 'desk@late.test', role: 'admin', allowAttendanceApp: true });
  });
});

const inGym = (fn) => h.inGym(gym, fn);
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000);

let seq = 0;
// A member with a paid, running membership.
async function member() {
  seq += 1;
  return inGym(async () => {
    const now = new Date();
    const user = await User.create({ firstName: 'Late', lastName: `Scan${seq}`, email: `late${seq}@late.test` });
    await PackageOrder.create({
      orderNumber: `LATE-${seq}`,
      userId: user._id,
      packageId: new h.state.mongoose.Types.ObjectId(),
      packageDetails: { name: 'Monthly', price: '50', currency: 'GBP', period: 'month' },
      customerInfo: { fullName: `Late Scan${seq}`, email: user.email },
      payment: { method: 'cash', amount: 50, currency: 'GBP', status: 'paid', paidAt: now },
      subscription: { startDate: new Date(now.getTime() - 30 * 86400000), endDate: new Date(now.getTime() + 30 * 86400000), isActive: true },
      status: 'active'
    });
    return user;
  });
}

// A punch from a desk: live, or queued with the time it was scanned.
let requests = 0;
function punch(person, { at, device = deskA } = {}) {
  requests += 1;
  const body = { person_type: 'member', person_id: String(person._id), method: 'fingerprint' };
  if (at) Object.assign(body, { scanned_at: at.toISOString(), request_id: `late-scan-${requests}-${seq}` });
  return inGym(() => h.call(desktop.punch, { desktopUser: operator, deviceContext: device, body }));
}
const visits = (person) => inGym(() => Attendance.find({ personId: person._id }).sort({ checkInAt: 1 }).lean());

test('a queued check-out that lands after the daily job closed the visit still closes it, at the time it was scanned', async () => {
  const ana = await member();
  const inAt = hoursAgo(20);
  const outAt = hoursAgo(19);

  // Checked in at desk B; desk A, offline, scans her out an hour later.
  const first = await punch(ana, { at: inAt, device: deskB });
  assert.equal(first.body.detail.action, 'check_in', JSON.stringify(first.body));

  // The daily job runs before desk A is back online: the visit is past the
  // window, so it is closed as forgotten.
  const closed = await inGym(() => staleVisits.closeStaleVisits());
  assert.ok(closed >= 1);
  let [visit] = await visits(ana);
  assert.equal(visit.autoClosed, true);

  const late = await punch(ana, { at: outAt });
  assert.equal(late.statusCode, 200, JSON.stringify(late.body));
  assert.equal(late.body.success, true, late.body.message);
  assert.equal(late.body.detail.action, 'check_out', 'the check-out it was, not a new check-in');

  const rows = await visits(ana);
  assert.equal(rows.length, 1, 'no made-up visit');
  [visit] = rows;
  assert.equal(visit.checkOutAt.getTime(), outAt.getTime());
  assert.equal(visit.workedMinutes, 60);
  assert.equal(visit.autoClosed, false, 'no longer a visit without a check-out');
  assert.equal(visit.autoClosedAt, null);
  assert.equal(visit.checkOut.device, 'DESK-A');
  assert.equal(visit.checkOut.offline, true);
  assert.equal(visit.open, undefined);
});

test('the queued check-out closes the old visit and leaves the one she has started since alone', async () => {
  const bea = await member();
  await punch(bea, { at: hoursAgo(21), device: deskB });
  await inGym(() => staleVisits.closeStaleVisits());
  // Back today, checked in at desk B half an hour ago.
  const today = await punch(bea, { at: hoursAgo(0.5), device: deskB });
  assert.equal(today.body.detail.action, 'check_in');

  const late = await punch(bea, { at: hoursAgo(19.5) });
  assert.equal(late.body.detail.action, 'check_out', JSON.stringify(late.body));

  const [old, current] = await visits(bea);
  assert.equal(old.workedMinutes, 90);
  assert.equal(old.autoClosed, false);
  assert.equal(current.checkOutAt, null);
  assert.equal(current.open, true, 'today\'s visit keeps its slot');
  // A scan now is today's way out.
  const out = await punch(bea, { device: deskB });
  assert.equal(out.body.detail.action, 'check_out');
  assert.equal((await visits(bea)).length, 2);
});

test('a visit already past its window at the scan stays the forgotten visit it was: the scan is a new visit', async () => {
  const cal = await member();
  await punch(cal, { at: hoursAgo(40), device: deskB });
  await inGym(() => staleVisits.closeStaleVisits({ now: hoursAgo(20) }));
  const late = await punch(cal, { at: hoursAgo(10) });
  assert.equal(late.body.detail.action, 'check_in', JSON.stringify(late.body));
  const rows = await visits(cal);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].autoClosed, true, 'still the forgotten visit it was');
});

test('a queued scan from before her latest visit is an earlier visit of its own, and the queue can close it', async () => {
  const dee = await member();
  // Desk B (online): in two hours ago, out one hour ago.
  await punch(dee, { at: hoursAgo(2), device: deskB });
  await punch(dee, { at: hoursAgo(1), device: deskB });

  // Desk A's queue: an earlier visit, four hours ago to three.
  const inAt = hoursAgo(4);
  const queuedIn = await punch(dee, { at: inAt });
  assert.equal(queuedIn.body.success, true, JSON.stringify(queuedIn.body));
  assert.equal(queuedIn.body.ignored, undefined, 'not dropped as a repeat');
  assert.equal(queuedIn.body.detail.action, 'check_in');
  assert.match(queuedIn.body.message, /earlier visit/);

  let rows = await visits(dee);
  assert.equal(rows.length, 2);
  const [earlier, later] = rows;
  assert.equal(earlier.checkInAt.getTime(), inAt.getTime());
  assert.equal(earlier.open, undefined, 'never the open visit');
  assert.equal(earlier.autoClosed, true, 'no check-out on record yet');
  assert.equal(earlier.autoClosedAt.getTime(), later.checkInAt.getTime());

  const queuedOut = await punch(dee, { at: hoursAgo(3) });
  assert.equal(queuedOut.body.detail.action, 'check_out', JSON.stringify(queuedOut.body));
  rows = await visits(dee);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].workedMinutes, 60);
  assert.equal(rows[0].autoClosed, false);
  assert.equal(rows[1].workedMinutes, 60, 'desk B\'s visit untouched');
});

test('a queued scan from before a visit still going on is recorded behind it, and the open visit keeps its slot', async () => {
  const eve = await member();
  const now = await punch(eve, { at: hoursAgo(1), device: deskB });
  assert.equal(now.body.detail.action, 'check_in');

  const queued = await punch(eve, { at: hoursAgo(3) });
  assert.equal(queued.body.success, true, JSON.stringify(queued.body));
  assert.equal(queued.body.detail.action, 'check_in');

  const [earlier, current] = await visits(eve);
  assert.equal(earlier.open, undefined);
  assert.equal(earlier.autoClosed, true);
  assert.equal(current.open, true);
  assert.equal(current.checkOutAt, null);

  const out = await punch(eve, { device: deskB });
  assert.equal(out.body.detail.action, 'check_out', 'a scan now closes the visit going on');
  assert.equal((await visits(eve))[1].checkOutAt !== null, true);
});

test('a queued scan inside a visit recorded in and out around it adds nothing, and says why', async () => {
  const fay = await member();
  await punch(fay, { at: hoursAgo(3), device: deskB });
  await punch(fay, { at: hoursAgo(1), device: deskB });

  const inside = await punch(fay, { at: hoursAgo(2) });
  assert.equal(inside.statusCode, 200);
  assert.equal(inside.body.success, false);
  assert.equal(inside.body.ignored, true);
  assert.equal(inside.body.code, 'INSIDE_RECORDED_VISIT');
  assert.match(inside.body.message, /^Already on record: checked in at .+ and out at .+\.$/);
  assert.equal(inside.body.detail.action, 'ignore');

  const rows = await visits(fay);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workedMinutes, 120, 'the visit as desk B recorded it');
});

test('a queued scan seconds from another desk\'s punch is that punch\'s repeat', async () => {
  const gus = await member();
  const arrived = hoursAgo(2);
  await punch(gus, { at: arrived, device: deskB });

  const justBefore = await punch(gus, { at: new Date(arrived.getTime() - 20000) });
  assert.equal(justBefore.body.ignored, true, JSON.stringify(justBefore.body));
  assert.equal(justBefore.body.code, undefined);
  assert.match(justBefore.body.message, /Already checked in/);

  await punch(gus, { at: hoursAgo(1), device: deskB });
  const justAfterOut = await punch(gus, { at: new Date(hoursAgo(1).getTime() + 20000) });
  assert.equal(justAfterOut.body.ignored, true, JSON.stringify(justAfterOut.body));
  assert.match(justAfterOut.body.message, /Already checked out/);

  assert.equal((await visits(gus)).length, 1);
});

test('where members only scan in, a queued scan ends the visit it finds at its own time and is placed behind the next', async () => {
  const corrections = h.src('attendance/controller/attendanceCorrectionController');
  const asOperator = { id: String(operator._id), email: operator.email, role: 'admin' };
  const setScanOut = (memberScanOut) => inGym(() => h.call(corrections.updateSettings, { body: { memberScanOut }, user: asOperator }));
  assert.equal((await setScanOut(false)).statusCode, 200);
  try {
    const ivy = await member();
    await punch(ivy, { at: hoursAgo(3), device: deskB });
    // Desk B's next scan an hour ago is her next visit; the first ends there.
    const nextAt = hoursAgo(1);
    await punch(ivy, { at: nextAt, device: deskB });
    let rows = await visits(ivy);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].autoClosedAt.getTime(), nextAt.getTime());

    // Desk A scanned her two hours ago: a visit of its own between the two.
    const at = hoursAgo(2);
    const queued = await punch(ivy, { at });
    assert.equal(queued.body.success, true, JSON.stringify(queued.body));
    assert.equal(queued.body.detail.action, 'check_in');

    rows = await visits(ivy);
    assert.equal(rows.length, 3);
    const [first, middle, last] = rows;
    assert.equal(first.autoClosedAt.getTime(), at.getTime(), 'the first visit ended at the queued scan');
    assert.equal(middle.checkInAt.getTime(), at.getTime());
    assert.equal(middle.open, undefined);
    assert.equal(middle.autoClosedAt.getTime(), last.checkInAt.getTime());
    assert.equal(last.open, true, 'the latest visit keeps its slot');
  } finally {
    await setScanOut(true);
  }
});

test('a live punch is placed as it always was', async () => {
  const hal = await member();
  const first = await punch(hal);
  assert.equal(first.body.detail.action, 'check_in');
  const again = await punch(hal);
  assert.equal(again.body.ignored, true);
  assert.equal(again.body.code, undefined);
  const [row] = await visits(hal);
  assert.equal(row.open, true);
  assert.equal(row.autoClosed, false);
});
