// The rules behind the office's attendance corrections, without a database:
// the staff open window (a forgotten check-out is not closed by the next
// day's scan), what "open" and "no check-out" mean for staff and for voided
// visits, the desk's wording for subscriptions that renew themselves and for
// a used-up session pack, and the correction endpoints' refusals that come
// before any read. The same rules against a real MongoDB are in
// test/integration/attendance.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.ATTENDANCE_OPEN_VISIT_HOURS;
delete process.env.ATTENDANCE_STAFF_SHIFT_GRACE_HOURS;
delete process.env.ATTENDANCE_STAFF_OPEN_HOURS;
delete process.env.ATTENDANCE_EXPIRY_WARNING_DAYS;

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const stale = require('../../src/attendance/services/staleVisits');
const { membershipVerdict } = require('../../src/attendance/services/punchService');
const corrections = require('../../src/attendance/controller/attendanceCorrectionController');
const Attendance = require('../../src/attendance/models/attendanceModel');
const Settings = require('../../src/models/settings');

const gym = { _id: '0000000000000000000000b3', slug: 'unit-gym-corrections', database: { name: 'gympilot_unit_gym_corrections' }, locale: { timezone: 'UTC' } };

const HOUR = 60 * 60 * 1000;
const at = (iso) => new Date(iso);
const roster = (startTime, endTime) => ({ hasSchedule: true, startTime, endTime });

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function call(handler, req) {
  const res = fakeRes();
  await handler({ params: {}, body: {}, query: {}, user: { id: '0000000000000000000000a1' }, ...req }, res);
  return res;
}

test('a staff visit is open until the rostered shift ends plus the grace -- or the staff default without a roster', async () => {
  await runWithTenant(gym, () => {
    assert.equal(stale.STAFF_SHIFT_GRACE_HOURS, 4);
    assert.equal(stale.STAFF_OPEN_HOURS, 14);

    // In at 08:55 for 09:00-17:00: open until 21:00.
    assert.equal(stale.staffOpenUntil(roster('09:00', '17:00'), at('2026-09-21T08:55:00Z'), '2026-09-21').toISOString(), '2026-09-21T21:00:00.000Z');

    // A night shift ends the next morning.
    assert.equal(stale.staffOpenUntil(roster('22:00', '06:00'), at('2026-09-21T21:50:00Z'), '2026-09-21').toISOString(), '2026-09-22T10:00:00.000Z');

    // Arriving after the rostered shift has ended is a shift the roster does
    // not describe: the staff default from the check-in.
    assert.equal(stale.staffOpenUntil(roster('09:00', '17:00'), at('2026-09-21T18:00:00Z'), '2026-09-21').toISOString(), '2026-09-22T08:00:00.000Z');

    // No roster, or one that cannot be read: the staff default.
    const noRoster = { hasSchedule: false, startTime: '', endTime: '' };
    assert.equal(stale.staffOpenUntil(noRoster, at('2026-09-21T16:00:00Z'), '2026-09-21').toISOString(), '2026-09-22T06:00:00.000Z');
    assert.equal(stale.staffOpenUntil(roster('9am', '5pm'), at('2026-09-21T16:00:00Z'), '2026-09-21').toISOString(), '2026-09-22T06:00:00.000Z');

    // Never longer than a member's window: 03:00 in for 04:00-23:00 would be
    // 24 hours with the grace; it stops at 18.
    assert.equal(stale.staffOpenUntil(roster('04:00', '23:00'), at('2026-09-21T03:00:00Z'), '2026-09-21').toISOString(), '2026-09-21T21:00:00.000Z');
  });
});

test('the forgotten check-out from the audit: in at 16:00, back at 09:00 is a new visit, not a 17-hour shift', async () => {
  await runWithTenant(gym, () => {
    const visit = {
      personType: 'staff',
      checkInAt: at('2026-09-21T16:00:00Z'),
      checkOutAt: null,
      openUntil: stale.staffOpenUntil(roster('14:00', '22:00'), at('2026-09-21T16:00:00Z'), '2026-09-21')
    };
    const nextMorning = at('2026-09-22T09:00:00Z');
    assert.equal(visit.openUntil.toISOString(), '2026-09-22T02:00:00.000Z');
    assert.equal(stale.isOpenVisit(visit, nextMorning), false, 'the 09:00 scan does not close it');
    assert.equal(stale.missedCheckOut(visit, nextMorning), true, 'it shows as "No check-out" for the office');
    assert.equal(stale.isOpenVisit(visit, at('2026-09-21T23:30:00Z')), true, 'overtime inside the grace still closes it');
  });
});

test('"open" keeps the window every reader already asks for, shortened by openUntil, and never includes a voided visit', () => {
  const now = at('2026-09-21T12:00:00Z');
  const match = stale.openVisitMatch(now);
  assert.equal(match.checkOutAt, null);
  assert.deepEqual(match.autoClosed, { $ne: true });
  assert.equal(match.checkInAt.$gte.getTime(), now.getTime() - 18 * HOUR);
  assert.deepEqual(match.voided, { $ne: true });
  assert.deepEqual(match.openUntil, { $not: { $lte: now } });

  const missed = stale.missedCheckOutMatch(now);
  assert.deepEqual(missed.voided, { $ne: true });
  assert.ok(missed.$or.some((clause) => clause.openUntil && clause.openUntil.$lte === now));

  const member = { checkInAt: at('2026-09-21T10:00:00Z'), checkOutAt: null };
  assert.equal(stale.isOpenVisit(member, now), true, 'a row without openUntil has the general window');
  assert.equal(stale.isOpenVisit({ ...member, openUntil: at('2026-09-21T11:00:00Z') }, now), false);
  assert.equal(stale.isOpenVisit({ ...member, openUntil: at('2026-09-21T13:00:00Z') }, now), true);

  const voided = { ...member, voided: true };
  assert.equal(stale.isOpenVisit(voided, now), false);
  assert.equal(stale.missedCheckOut(voided, now), false, 'a voided visit is not a check-out to chase');
  assert.equal(stale.missedCheckOut({ ...voided, checkInAt: at('2026-09-10T10:00:00Z') }, now), false);
});

test('an auto-renewing subscription is not "expiring": no amber, no renewal pitch, just when it renews', async () => {
  await runWithTenant(gym, () => {
    const endDate = at('2026-09-24T12:00:00Z');
    const base = { status: 'active', orderId: null, packageName: 'Monthly', endDate, daysLeft: 3, sessionsLeft: null };

    const renews = membershipVerdict({ ...base, autoRenews: true });
    assert.equal(renews.status, 'membership_active');
    assert.equal(renews.label, 'Renews automatically on 24 Sep 2026');
    assert.equal(renews.warning, null);

    const ending = membershipVerdict(base);
    assert.equal(ending.status, 'membership_expiring');
    assert.match(ending.warning, /EXPIRES IN 3 DAYS/);

    // Outside the warning window nothing changes either way.
    assert.equal(membershipVerdict({ ...base, daysLeft: 20, autoRenews: true }).label, 'Active · 20 days left');
  });
});

test('a used-up session pack whose end date is still ahead is not "expired 30 days ago"', () => {
  const usedUp = membershipVerdict({ status: 'expired', orderId: null, packageName: '10 sessions', endDate: null, daysLeft: 30, sessionsLeft: 0 });
  assert.equal(usedUp.status, 'membership_expired');
  assert.equal(usedUp.label, 'No sessions left · ends in 30 days');
  assert.doesNotMatch(usedUp.label, /ago/);
  assert.match(usedUp.warning, /EXPIRED/);
  assert.equal(membershipVerdict({ status: 'expired', daysLeft: 1, sessionsLeft: 0 }).label, 'No sessions left · ends in 1 day');

  // Lapsed by date, pack or not: how long ago, as before.
  assert.equal(membershipVerdict({ status: 'expired', daysLeft: -4, sessionsLeft: 0 }).label, 'Expired 4 days ago');
  assert.equal(membershipVerdict({ status: 'expired', daysLeft: null }).label, 'Expired');
});

test('a row carries its corrections in the admin API\'s vocabulary', async () => {
  await runWithTenant(gym, () => {
    assert.deepEqual(corrections.correctionFields({}), {
      voided: false,
      voided_at: null,
      void_reason: '',
      edited: false,
      corrections: 0,
      last_correction: null
    });

    const fields = corrections.correctionFields({
      voided: true,
      voidedAt: at('2026-09-21T12:00:00Z'),
      voidReason: 'Wrong person',
      edits: [
        { action: 'edit', at: at('2026-09-21T11:00:00Z'), byName: 'Ada Admin', note: 'Forgot to scan out' },
        { action: 'void', at: at('2026-09-21T12:00:00Z'), byName: 'Ada Admin', note: 'Wrong person' }
      ]
    });
    assert.equal(fields.voided, true);
    assert.equal(fields.void_reason, 'Wrong person');
    assert.equal(fields.edited, true);
    assert.equal(fields.corrections, 2);
    assert.equal(fields.last_correction.action, 'void');
    assert.equal(fields.last_correction.by_name, 'Ada Admin');
    assert.equal(fields.last_correction.at_label, '21 Sep 2026 12:00 PM');

    assert.equal(corrections.correctionFields({ edits: [{ action: 'void', note: 'x' }] }).edited, false, 'a void alone is not an edit');
  });
});

test('the attendance row and the settings can hold what the corrections write', async () => {
  await runWithTenant(gym, () => {
    for (const path of ['openUntil', 'voided', 'voidedAt', 'voidReason', 'edits']) {
      assert.ok(Attendance.schema.path(path), `attendance has ${path}`);
    }
    const edit = Attendance.schema.path('edits').schema;
    for (const path of ['action', 'at', 'by', 'byName', 'note', 'before', 'after']) {
      assert.ok(edit.path(path), `a correction records ${path}`);
    }
    assert.deepEqual(edit.path('action').enumValues, ['edit', 'void']);
    assert.equal(Settings.schema.path('attendance.memberScanOut').defaultValue, true, 'members scan out unless a gym says otherwise');
  });
});

test('corrections are refused before anything is read when the request cannot be one', async () => {
  await runWithTenant(gym, async () => {
    const id = '0000000000000000000000c1';
    const expect = async (res, status, pattern) => {
      assert.equal(res.statusCode, status, JSON.stringify(res.body));
      assert.equal(res.body.success, false);
      assert.match(res.body.message, pattern);
    };

    await expect(await call(corrections.editTimes, { params: { id: 'nope' } }), 400, /Invalid/);
    await expect(await call(corrections.editTimes, { params: { id }, body: { checkOutAt: '2026-09-21T17:00' } }), 400, /note/i);
    await expect(await call(corrections.editTimes, { params: { id }, body: { note: '   ' } }), 400, /note/i);
    await expect(await call(corrections.editTimes, { params: { id }, body: { note: 'x' } }), 400, /check-in or a check-out/);
    await expect(await call(corrections.editTimes, { params: { id }, body: { note: 'x', checkInAt: 'yesterday' } }), 400, /check-in time could not be read/);
    await expect(await call(corrections.editTimes, { params: { id }, body: { note: 'x', checkOutAt: '2026-02-31T10:00' } }), 400, /check-out time could not be read/);
    await expect(await call(corrections.editTimes, { params: { id }, body: { note: 'x', checkOutAt: '2026-09-21T25:00' } }), 400, /could not be read/);
    await expect(await call(corrections.editTimes, { params: { id }, body: { note: 'x', checkOutAt: '2026-09-21' } }), 400, /could not be read/, 'a bare date is not a time');
    await expect(await call(corrections.editTimes, { params: { id }, body: { note: 'x', checkOutAt: null } }), 400, /could not be read/);

    await expect(await call(corrections.voidVisit, { params: { id: 'nope' } }), 400, /Invalid/);
    await expect(await call(corrections.voidVisit, { params: { id }, body: {} }), 400, /reason/);

    await expect(await call(corrections.updateSettings, { body: { memberScanOut: 'false' } }), 400, /true or false/);
    await expect(await call(corrections.updateSettings, { body: {} }), 400, /true or false/);
  });
});
