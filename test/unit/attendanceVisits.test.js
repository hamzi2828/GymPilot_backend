// Attendance rules that need no database: the "still inside" window, the
// daily close of forgotten visits, a staff check-out keeping the arrival
// verdict, and the desk token's sliding renewal.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.ATTENDANCE_OPEN_VISIT_HOURS;
delete process.env.ATTENDANCE_MIN_PUNCH_GAP_SECONDS;

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const stale = require('../../src/attendance/services/staleVisits');
const punch = require('../../src/attendance/services/punchService');
const Attendance = require('../../src/attendance/models/attendanceModel');
const Trainer = require('../../src/gymfolio/models/trainerModel');
const DesktopToken = require('../../src/attendance/models/desktopTokenModel');

const gym = { _id: '0000000000000000000000b1', slug: 'unit-gym', database: { name: 'gympilot_unit_gym' }, locale: { timezone: 'UTC' } };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date('2026-09-21T12:00:00Z');
const ago = (ms) => new Date(now.getTime() - ms);

test('one window decides both the punch and "still inside"', () => {
  assert.equal(stale.OPEN_VISIT_HOURS, 18);
  assert.equal(punch.OPEN_VISIT_HOURS, stale.OPEN_VISIT_HOURS, 'the punch uses the same constant');
  assert.equal(stale.openVisitCutoff(now).getTime(), now.getTime() - 18 * HOUR);

  const match = stale.openVisitMatch(now);
  assert.equal(match.checkOutAt, null);
  assert.deepEqual(match.autoClosed, { $ne: true });
  assert.equal(match.checkInAt.$gte.getTime(), now.getTime() - 18 * HOUR);
});

test('a visit is inside, checked out, or ended without a check-out -- never inside for ever', () => {
  const inside = { checkInAt: ago(2 * HOUR), checkOutAt: null };
  const forgotten = { checkInAt: ago(3 * DAY), checkOutAt: null };
  const marked = { checkInAt: ago(2 * HOUR), checkOutAt: null, autoClosed: true };
  const left = { checkInAt: ago(3 * HOUR), checkOutAt: ago(HOUR) };

  assert.equal(stale.isOpenVisit(inside, now), true);
  assert.equal(stale.missedCheckOut(inside, now), false);

  assert.equal(stale.isOpenVisit(forgotten, now), false, 'last week is not "inside" today');
  assert.equal(stale.missedCheckOut(forgotten, now), true, 'even before the daily job marks it');

  assert.equal(stale.isOpenVisit(marked, now), false);
  assert.equal(stale.missedCheckOut(marked, now), true);

  assert.equal(stale.isOpenVisit(left, now), false);
  assert.equal(stale.missedCheckOut(left, now), false);
});

test('closeStaleVisits marks only open visits past the window, without inventing a check-out', async () => {
  await runWithTenant(gym, async () => {
    const calls = [];
    const originalUpdate = Attendance.updateMany;
    const originalCount = Attendance.countDocuments;
    Attendance.updateMany = async (filter, update) => {
      calls.push({ op: 'update', filter, update });
      return { modifiedCount: 4 };
    };
    Attendance.countDocuments = async (filter) => {
      calls.push({ op: 'count', filter });
      return 7;
    };

    try {
      assert.equal(await stale.closeStaleVisits({ now }), 4);
      const [{ filter, update }] = calls;
      assert.equal(filter.checkOutAt, null);
      assert.deepEqual(filter.autoClosed, { $ne: true });
      assert.equal(filter.checkInAt.$lt.getTime(), now.getTime() - 18 * HOUR);
      assert.deepEqual(Object.keys(update.$set).sort(), ['autoClosed', 'autoClosedAt']);
      assert.equal(update.$set.autoClosed, true);
      assert.equal(update.$set.autoClosedAt, now);

      assert.equal(await stale.closeStaleVisits({ now, dryRun: true }), 7);
      assert.equal(calls[1].op, 'count', 'a dry run only counts');
      assert.equal(calls.length, 2);
    } finally {
      Attendance.updateMany = originalUpdate;
      Attendance.countDocuments = originalCount;
    }
  });
});

test('the attendance row can store the departure verdict, the auto-close and the desk location', async () => {
  await runWithTenant(gym, () => {
    for (const path of ['departureStatus', 'departureLabel', 'departureVarianceMinutes', 'autoClosed', 'autoClosedAt']) {
      assert.ok(Attendance.schema.path(path), `attendance has ${path}`);
    }
    assert.ok(Attendance.schema.path('checkIn').schema.path('location'), 'a punch records its location');
  });
});

test('the desk describes a finished shift by its departure, the office keeps the arrival', () => {
  const staffOpen = { personType: 'staff', status: 'late', statusLabel: 'Late by 20 m', checkOutAt: null };
  assert.deepEqual(punch.currentVerdict(staffOpen), { status: 'late', label: 'Late by 20 m' });

  const staffLeft = { ...staffOpen, checkOutAt: now, departureStatus: 'on_time', departureLabel: 'On time' };
  assert.deepEqual(punch.currentVerdict(staffLeft), { status: 'on_time', label: 'On time' });

  // Closed before departure fields existed: the verdict it stored is the one.
  const legacy = { personType: 'staff', status: 'early', statusLabel: 'Left 10 m early', checkOutAt: now };
  assert.deepEqual(punch.currentVerdict(legacy), { status: 'early', label: 'Left 10 m early' });

  const member = { personType: 'member', status: 'membership_expired', statusLabel: 'Expired', checkOutAt: now };
  assert.deepEqual(punch.currentVerdict(member), { status: 'membership_expired', label: 'Expired' });
});

test('a staff check-out stores the departure beside the arrival instead of over it', async () => {
  await runWithTenant(gym, async () => {
    const trainerId = new mongoose.Types.ObjectId();
    const trainer = {
      _id: trainerId,
      isActive: true,
      name: 'Sam Coach',
      staffCode: 'TR-0007',
      role: 'Coach',
      availability: []
    };

    let saved = 0;
    const open = {
      _id: new mongoose.Types.ObjectId(),
      personType: 'staff',
      personId: trainerId,
      personName: 'Sam Coach',
      personCode: 'TR-0007',
      shiftDate: '2026-09-21',
      checkInAt: new Date(Date.now() - 8 * HOUR),
      checkOutAt: null,
      checkIn: { byName: 'Front Desk', device: 'DESK-1' },
      checkOut: {},
      workedMinutes: null,
      // A day-long roster, so the departure is "early" (or on time in the
      // last minute of the day) whenever the test runs.
      schedule: { hasSchedule: true, startTime: '00:00', endTime: '23:59' },
      status: 'late',
      statusLabel: 'Late by 20 m',
      varianceMinutes: 20,
      save: async () => {
        saved += 1;
      }
    };

    const originalFindById = Trainer.findById;
    const originalFindOne = Attendance.findOne;
    Trainer.findById = async () => trainer;
    Attendance.findOne = () => ({ sort: async () => open });

    try {
      const result = await punch.recordPunch({
        personType: 'staff',
        personId: String(trainerId),
        operator: { _id: new mongoose.Types.ObjectId(), firstName: 'Front', lastName: 'Desk', attendanceLocation: 'Johar Town' },
        device: { deviceLabel: 'DESK-2', osUser: 'desk', clientApp: 'test', ip: '127.0.0.1' },
        method: 'fingerprint'
      });

      assert.equal(result.success, true);
      assert.equal(result.action, 'check_out');
      assert.equal(saved, 1);

      // The arrival is untouched...
      assert.equal(open.status, 'late');
      assert.equal(open.statusLabel, 'Late by 20 m');
      assert.equal(open.varianceMinutes, 20);
      // ...and the departure sits beside it.
      assert.ok(['early', 'on_time'].includes(open.departureStatus), open.departureStatus);
      assert.ok(open.departureLabel);
      assert.equal(typeof open.departureVarianceMinutes, 'number');
      assert.equal(open.checkOut.location, 'Johar Town');

      // The desk's receipt reads as it always did (the departure), with the
      // arrival on its own line.
      assert.equal(result.detail.status, open.departureStatus);
      assert.equal(result.detail.status_label, open.departureLabel);
      const arrival = result.detail.rows.find((row) => row.caption === 'Arrival');
      assert.ok(arrival, 'receipt has an Arrival row');
      assert.equal(arrival.value, 'Late by 20 m');
    } finally {
      Trainer.findById = originalFindById;
      Attendance.findOne = originalFindOne;
    }
  });
});

test('a desk token in use is renewed in its last week, within its lifetime, and never revived', async () => {
  await runWithTenant(gym, () => {
    const renew = DesktopToken.renewedExpiry;
    const fresh = { createdAt: ago(10 * DAY), expiresAt: new Date(now.getTime() + 20 * DAY) };
    assert.equal(renew(fresh, now), null, 'plenty of time left: left alone');

    const lastWeek = { createdAt: ago(27 * DAY), expiresAt: new Date(now.getTime() + 3 * DAY) };
    assert.equal(renew(lastWeek, now).getTime(), now.getTime() + 30 * DAY);

    assert.equal(renew({ createdAt: ago(31 * DAY), expiresAt: ago(HOUR) }, now), null, 'expired stays expired');
    assert.equal(renew({ ...lastWeek, revokedAt: ago(HOUR) }, now), null, 'revoked stays revoked');

    const old = { createdAt: ago(170 * DAY), expiresAt: new Date(now.getTime() + 3 * DAY) };
    assert.equal(renew(old, now).getTime(), old.createdAt.getTime() + 180 * DAY, 'capped at its lifetime');

    const atCap = { createdAt: ago(178 * DAY), expiresAt: new Date(now.getTime() + 2 * DAY) };
    assert.equal(renew(atCap, now), null, 'no further once the lifetime is used up');
  });
});
