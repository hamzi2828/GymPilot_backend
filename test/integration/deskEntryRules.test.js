// The front desk's entry rules and its offline queue, against a real MongoDB.
//
// Entry rules: a gym may turn away an expired, unpaid or package-less member
// instead of checking them in with a red warning. Off (the default) the desk
// warns and lets them in, as it always has; on, nothing is recorded and the
// answer says "refused" with the reason. Someone already inside can always
// scan out.
//
// The offline queue: the Windows desk sends punches it took without a
// connection later, each with `scanned_at`. That time is the punch's time,
// so a morning's queue sent at noon pairs its check-ins and check-outs as
// they happened. Only a staff desk may send it, only with a request_id, and
// only within a window.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let User;
let PackageOrder;
let Attendance;
let desktop;
let corrections;
let operator;

const device = { deviceLabel: 'DESK-OFF', osUser: 'frontdesk', clientApp: 'integration', ip: '127.0.0.1' };

const test = h.suite(async () => {
  User = h.src('models/user');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Attendance = h.src('attendance/models/attendanceModel');
  desktop = h.src('attendance/controller/desktopAppController');
  corrections = h.src('attendance/controller/attendanceCorrectionController');

  gym = await h.createGym('entry-rules-gym', { timezone: h.middayZone(), currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(Attendance, User);
    operator = await User.create({ firstName: 'Desk', lastName: 'Rules', email: 'desk@entry.test', role: 'admin' });
  });
});

const asOperator = () => ({ id: String(operator._id), email: operator.email, role: 'admin' });
const putSettings = (body) => h.call(corrections.updateSettings, { body, user: asOperator() });
const readSettings = () => h.call(corrections.settings, { user: asOperator() });

let seq = 0;
const kioskToken = { _id: 'kiosk-token-1', clientApp: 'GymPilotKiosk/1.0' };
const deskPunch = (person, body = {}, extra = {}) =>
  h.call(desktop.punch, {
    desktopUser: operator,
    deviceContext: device,
    body: { person_type: 'member', person_id: String(person._id), method: 'fingerprint', ...body },
    ...extra
  });
const visits = (person) => Attendance.find({ personId: person._id }).sort({ checkInAt: 1 }).lean();

// A member with one order ending `endIn` days from now (negative: ended);
// `noOrder` for someone who never bought one.
async function memberWith({ endIn = 40, balanceDue = 0, orderStatus = 'active', noOrder = false } = {}) {
  seq += 1;
  const now = new Date();
  const user = await User.create({ firstName: 'Ent', lastName: `Rule${seq}`, email: `rule${seq}@entry.test` });
  if (noOrder) return user;
  await PackageOrder.create({
    orderNumber: `ENT-${seq}`,
    userId: user._id,
    packageId: new h.state.mongoose.Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: '6000', currency: 'PKR', period: 'month' },
    customerInfo: { fullName: `Ent Rule${seq}`, email: user.email },
    payment: { method: 'cash', amount: 6000, currency: 'PKR', status: 'paid', paidAt: now },
    subscription: { startDate: new Date(now.getTime() - 30 * 86400000), endDate: new Date(now.getTime() + endIn * 86400000), isActive: endIn > 0 },
    status: orderStatus
  });
  if (balanceDue > 0) {
    await PackageOrder.collection.updateOne({ userId: user._id }, { $set: { 'payment.balanceDue': balanceDue } });
  }
  return user;
}

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000);

test('entry rules are off by default: expired, unpaid and no-package members are let in with a warning', async () => {
  await h.inGym(gym, async () => {
    const settings = (await readSettings()).body.settings;
    assert.deepEqual(settings.refuse_entry, { expired: false, unpaid: false, no_package: false });

    for (const person of [await memberWith({ endIn: -5 }), await memberWith({ balanceDue: 2500 }), await memberWith({ noOrder: true })]) {
      const res = await deskPunch(person);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true, res.body.message);
      assert.equal(res.body.detail.action, 'check_in');
      assert.ok(res.body.detail.warning, 'still warned');
      assert.equal(res.body.refused, undefined);
      assert.equal((await visits(person)).length, 1);
    }
  });
});

test('entry rules on: each case is refused with a plain reason, nothing recorded, the problem sound; a member in good standing still gets in', async () => {
  await h.inGym(gym, async () => {
    const saved = await putSettings({ refuseEntry: { expired: true, unpaid: true, noPackage: true } });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.settings.refuse_entry, { expired: true, unpaid: true, no_package: true });
    assert.equal(saved.body.settings.member_scan_out, true, 'other settings untouched');

    try {
      const cases = [
        [await memberWith({ endIn: -5 }), 'expired', /^Entry refused — Membership expired\.$/],
        [await memberWith({ balanceDue: 2500 }), 'unpaid', /^Entry refused — Balance due PKR 2,500\.$/],
        [await memberWith({ endIn: 40, orderStatus: 'past_due' }), 'unpaid', /^Entry refused — Card payment failed\.$/],
        [await memberWith({ noOrder: true }), 'no_package', /^Entry refused — No active membership\.$/]
      ];
      for (const [person, reason, message] of cases) {
        const res = await deskPunch(person, { request_id: `refuse-${person._id}` });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.success, false);
        assert.equal(res.body.refused, true);
        assert.equal(res.body.code, 'ENTRY_REFUSED');
        assert.equal(res.body.reason, reason);
        assert.match(res.body.message, message);
        assert.equal(res.body.detail.action, 'refused');
        assert.equal(res.body.detail.refused, true);
        assert.match(res.body.detail.warning, /^ENTRY REFUSED — /);
        assert.equal(res.body.detail.alert.level, 'problem');
        assert.ok(!res.body.detail.rows.some((r) => r.caption === 'Check in'), 'no visit rows on a refusal');
        assert.equal((await visits(person)).length, 0, `${reason}: nothing recorded`);
      }

      const fine = await memberWith({ endIn: 40 });
      const ok = await deskPunch(fine);
      assert.equal(ok.body.success, true, ok.body.message);
      assert.equal(ok.body.detail.action, 'check_in');
    } finally {
      await putSettings({ refuseEntry: { expired: false, unpaid: false, noPackage: false } });
    }
  });
});

test('one rule at a time: refusing expired members still lets an unpaid one in with the warning', async () => {
  await h.inGym(gym, async () => {
    await putSettings({ refuseEntry: { expired: true } });
    try {
      const owes = await memberWith({ balanceDue: 900 });
      const res = await deskPunch(owes);
      assert.equal(res.body.success, true, res.body.message);
      assert.match(res.body.detail.warning, /Balance due/);

      const lapsed = await memberWith({ endIn: -2 });
      const no = await deskPunch(lapsed);
      assert.equal(no.body.refused, true);
      assert.equal(no.body.reason, 'expired');
    } finally {
      await putSettings({ refuseEntry: { expired: false } });
    }
  });
});

test('someone already inside can always scan out, whatever the rules say', async () => {
  await h.inGym(gym, async () => {
    const lapsed = await memberWith({ endIn: -3 });
    const inside = await deskPunch(lapsed, { scanned_at: hoursAgo(2).toISOString(), request_id: `inside-${lapsed._id}-in` });
    assert.equal(inside.body.detail.action, 'check_in', JSON.stringify(inside.body));

    await putSettings({ refuseEntry: { expired: true } });
    try {
      const out = await deskPunch(lapsed);
      assert.equal(out.body.success, true, out.body.message);
      assert.equal(out.body.detail.action, 'check_out');
    } finally {
      await putSettings({ refuseEntry: { expired: false } });
    }
  });
});

test('a queued scan is recorded at the time it was scanned, and a queue pairs its check-in and check-out', async () => {
  await h.inGym(gym, async () => {
    const person = await memberWith();
    const inAt = hoursAgo(5);
    const outAt = hoursAgo(3.5);

    const first = await deskPunch(person, { scanned_at: inAt.toISOString(), request_id: 'offline-queue-in-0001' });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.detail.action, 'check_in');
    const second = await deskPunch(person, { scanned_at: outAt.toISOString(), request_id: 'offline-queue-out-0001' });
    assert.equal(second.body.detail.action, 'check_out', 'an hour and a half later: the way out, not a repeat');

    const rows = await visits(person);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].checkInAt.getTime(), inAt.getTime());
    assert.equal(rows[0].checkOutAt.getTime(), outAt.getTime());
    assert.equal(rows[0].workedMinutes, 90);
    assert.equal(rows[0].checkIn.offline, true);
    assert.equal(rows[0].checkOut.offline, true);

    // The queue sent again (the answer was lost): the same answers, nothing new.
    const againIn = await deskPunch(person, { scanned_at: inAt.toISOString(), request_id: 'offline-queue-in-0001' });
    const againOut = await deskPunch(person, { scanned_at: outAt.toISOString(), request_id: 'offline-queue-out-0001' });
    assert.equal(againIn.body.repeated, true);
    assert.equal(againIn.body.detail.action, 'check_in');
    assert.equal(againOut.body.repeated, true);
    assert.equal(againOut.body.detail.action, 'check_out');
    assert.equal((await visits(person)).length, 1);

    // A live punch now is the next visit, not a check-out of the old one.
    const live = await deskPunch(person);
    assert.equal(live.body.detail.action, 'check_in');
    assert.equal((await visits(person))[1].checkIn.offline, undefined);
  });
});

test('a queued scan for a gym that refuses unpaid members is refused on arrival, and nothing is recorded', async () => {
  await h.inGym(gym, async () => {
    await putSettings({ refuseEntry: { unpaid: true } });
    try {
      const owes = await memberWith({ balanceDue: 1500 });
      const res = await deskPunch(owes, { scanned_at: hoursAgo(1).toISOString(), request_id: 'offline-refused-0001' });
      assert.equal(res.body.refused, true, JSON.stringify(res.body));
      assert.equal(res.body.reason, 'unpaid');
      assert.equal((await visits(owes)).length, 0);
    } finally {
      await putSettings({ refuseEntry: { unpaid: false } });
    }
  });
});

test('scanned_at is refused when too old, in the future, unreadable, without a request_id, or from a web kiosk', async () => {
  await h.inGym(gym, async () => {
    const person = await memberWith();
    const cases = [
      [{ scanned_at: hoursAgo(73).toISOString(), request_id: 'too-old-scan-0001' }, /more than 72 hours old/],
      [{ scanned_at: new Date(Date.now() + 10 * 60000).toISOString(), request_id: 'future-scan-0001' }, /in the future/],
      [{ scanned_at: 'yesterday-ish', request_id: 'garbled-scan-0001' }, /must be a date and time/],
      [{ scanned_at: hoursAgo(1).toISOString() }, /needs a request_id/]
    ];
    for (const [body, message] of cases) {
      const res = await deskPunch(person, body);
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.match(res.body.message, message);
    }

    const kiosk = await deskPunch(person, { scanned_at: hoursAgo(1).toISOString(), request_id: 'kiosk-scan-0001' }, { desktopToken: kioskToken });
    assert.equal(kiosk.statusCode, 400, JSON.stringify(kiosk.body));
    assert.match(kiosk.body.message, /web kiosk cannot send scanned_at/);
    assert.equal((await visits(person)).length, 0);

    // A desk clock a minute fast is "now", not refused.
    const skew = await deskPunch(person, { scanned_at: new Date(Date.now() + 60000).toISOString(), request_id: 'skewed-scan-0001' });
    assert.equal(skew.body.success, true, JSON.stringify(skew.body));
    assert.ok((await visits(person))[0].checkInAt.getTime() <= Date.now());
  });
});

test('the settings PUT refuses an entry rule that is not true or false', async () => {
  await h.inGym(gym, async () => {
    const bad = await putSettings({ refuseEntry: { expired: 'yes' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.message, /refuseEntry.expired must be true or false/);
    const notObject = await putSettings({ refuseEntry: true });
    assert.equal(notObject.statusCode, 400);
  });
});
