// The public timetable lists every class's sessions as one list, and the
// website shows each day's sessions in that order. Each class's own sessions
// were sorted, but the classes were laid end to end, so a Monday showed one
// class's 18:00 before another class's 07:00.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { storage } = require('../../src/platform/tenantContext');
const { expandAll } = require('../../src/gymfolio/services/classSessions');

const inKarachi = (fn) =>
  storage.run({ gym: { _id: 'karachi', slug: 'karachi', locale: { timezone: 'Asia/Karachi' } } }, fn);

const id = () => new mongoose.Types.ObjectId();

// 2026-01-12 is a Monday, 2026-01-13 a Tuesday.
const evening = {
  _id: id(),
  name: 'Boxing',
  schedule: [
    { day: 'Monday', startTime: '18:00', endTime: '19:00' },
    { day: 'Tuesday', startTime: '06:30', endTime: '07:30' }
  ]
};
const morning = {
  _id: id(),
  name: 'Yoga',
  schedule: [{ day: 'Monday', startTime: '07:00', endTime: '08:00' }]
};
const sameTime = {
  _id: id(),
  name: 'Aerobics',
  schedule: [{ day: 'Monday', startTime: '18:00', endTime: '19:00' }]
};

test('sessions from several classes come out in date, then time order', () =>
  inKarachi(() => {
    const list = expandAll([evening, morning], '2026-01-12', '2026-01-13');
    assert.deepEqual(
      list.map((s) => `${s.date} ${s.start_time} ${s.class_name}`),
      ['2026-01-12 07:00 Yoga', '2026-01-12 18:00 Boxing', '2026-01-13 06:30 Boxing']
    );
  }));

test('two classes at the same time are listed alphabetically', () =>
  inKarachi(() => {
    const list = expandAll([evening, sameTime, morning], '2026-01-12', '2026-01-12');
    assert.deepEqual(
      list.map((s) => `${s.start_time} ${s.class_name}`),
      ['07:00 Yoga', '18:00 Aerobics', '18:00 Boxing']
    );
  }));

test('no classes, no sessions', () =>
  inKarachi(() => {
    assert.deepEqual(expandAll([], '2026-01-12', '2026-01-18'), []);
  }));
