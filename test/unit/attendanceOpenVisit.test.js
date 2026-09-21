// The one-open-visit rule, without a database: the attendance row carries an
// `open` flag under a partial unique index, a check-out gives the flag up,
// and so does the daily close of forgotten visits. The race it prevents --
// two scans arriving together both checking the person in -- is exercised
// against a real MongoDB in test/integration/attendance.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.ATTENDANCE_OPEN_VISIT_HOURS;

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

const gym = { _id: '0000000000000000000000b2', slug: 'unit-gym-open', database: { name: 'gympilot_unit_gym_open' }, locale: { timezone: 'UTC' } };

test('one open visit per person: a unique index on the open flag, and only on it', async () => {
  await runWithTenant(gym, () => {
    assert.ok(Attendance.schema.path('open'), 'attendance has an open flag');
    assert.equal(Attendance.schema.path('open').defaultValue, undefined, 'absent unless a check-in sets it');

    const found = Attendance.schema.indexes().find(([, options]) => options && options.name === 'one_open_visit_per_person');
    assert.ok(found, 'the one-open-visit index is declared');
    const [keys, options] = found;
    assert.deepEqual(keys, { personType: 1, personId: 1 });
    assert.equal(options.unique, true);
    // Partial on the flag alone, so finished visits and rows from before the
    // flag existed are outside it.
    assert.deepEqual(options.partialFilterExpression, { open: true });
  });
});

test('the daily close of forgotten visits also gives up their open flag', async () => {
  await runWithTenant(gym, async () => {
    const original = Attendance.updateMany;
    let seen = null;
    Attendance.updateMany = async (filter, update) => {
      seen = { filter, update };
      return { modifiedCount: 1 };
    };
    try {
      await stale.closeStaleVisits({ now: new Date('2026-09-21T12:00:00Z') });
      assert.deepEqual(seen.update.$unset, { open: '' });
      assert.equal(seen.update.$set.autoClosed, true);
    } finally {
      Attendance.updateMany = original;
    }
  });
});

test('a check-out gives up the open flag', async () => {
  await runWithTenant(gym, async () => {
    const trainerId = new mongoose.Types.ObjectId();
    const trainer = { _id: trainerId, isActive: true, name: 'Sam Coach', staffCode: 'TR-0008', role: 'Coach', availability: [] };
    let saved = 0;
    const visit = {
      _id: new mongoose.Types.ObjectId(),
      personType: 'staff',
      personId: trainerId,
      personName: 'Sam Coach',
      personCode: 'TR-0008',
      shiftDate: '2026-09-21',
      checkInAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      checkOutAt: null,
      checkIn: { byName: 'Front Desk', device: 'DESK-1' },
      checkOut: {},
      workedMinutes: null,
      schedule: { hasSchedule: false, startTime: '', endTime: '' },
      status: 'no_schedule',
      statusLabel: 'Not rostered today',
      open: true,
      save: async () => {
        saved += 1;
      }
    };

    const originalFindById = Trainer.findById;
    const originalFindOne = Attendance.findOne;
    Trainer.findById = async () => trainer;
    Attendance.findOne = () => ({ sort: async () => visit });
    try {
      const result = await punch.recordPunch({
        personType: 'staff',
        personId: String(trainerId),
        operator: { _id: new mongoose.Types.ObjectId(), firstName: 'Front', lastName: 'Desk' },
        device: { deviceLabel: 'DESK-1' },
        method: 'fingerprint'
      });
      assert.equal(result.action, 'check_out', result.message);
      assert.equal(saved, 1);
      assert.equal(visit.open, undefined, 'the finished visit no longer holds the slot');
    } finally {
      Trainer.findById = originalFindById;
      Attendance.findOne = originalFindOne;
    }
  });
});
