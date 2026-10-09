// What cancelling a class booking does, from when the class starts
// (classBookingController.cancelOutcome): a member cannot give a place up
// once the class has started, and a place freed after the start is never
// handed to the waiting list. The whole cancel, against a real database, is
// in test/integration/classBooking.test.js.
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
const { cancelOutcome } = require('../../src/gymfolio/controller/classBookingController');

// A London gym in January (GMT): the 18:00 class starts at 18:00Z.
const inLondon = (fn) => storage.run({ gym: { _id: 'london', slug: 'london', locale: { timezone: 'Europe/London' } } }, fn);
const booked = { status: 'booked', sessionDate: '2026-01-13', sessionStart: '18:00' };
const waiting = { ...booked, status: 'waitlisted' };
const at = (iso) => ({ now: new Date(iso) });

test('well before the class: a member cancels, keeps the credit, and the waiting list moves up', () =>
  inLondon(() => {
    assert.deepEqual(cancelOutcome(booked, { cancelHours: 2 }, at('2026-01-13T10:00:00Z')), { refused: false, late: false, promote: true });
  }));

test('inside the cancel-by window: the place is freed but the credit stays used', () =>
  inLondon(() => {
    assert.deepEqual(cancelOutcome(booked, { cancelHours: 2 }, at('2026-01-13T17:00:00Z')), { refused: false, late: true, promote: true });
    // Staff cancelling never costs the member.
    assert.deepEqual(cancelOutcome(booked, { cancelHours: 2 }, { byStaff: true, now: new Date('2026-01-13T17:00:00Z') }), { refused: false, late: false, promote: true });
  }));

test('once the class has started a member cannot cancel, whatever the cancel-by window', () =>
  inLondon(() => {
    for (const cancelHours of [0, 2, 24]) {
      for (const now of ['2026-01-13T18:00:00Z', '2026-01-13T19:30:00Z', '2026-01-20T09:00:00Z']) {
        const outcome = cancelOutcome(booked, { cancelHours }, at(now));
        assert.equal(outcome.refused, true, `cancelHours ${cancelHours} at ${now}`);
        assert.equal(outcome.promote, false);
      }
    }
    // With no window nothing was "late" before, so the credit came back
    // after the class. A minute before the start it still does.
    assert.deepEqual(cancelOutcome(booked, { cancelHours: 0 }, at('2026-01-13T17:59:00Z')), { refused: false, late: false, promote: true });
  }));

test('the desk can still cancel after the start, and nobody is promoted into a class that has begun', () =>
  inLondon(() => {
    assert.deepEqual(cancelOutcome(booked, { cancelHours: 2 }, { byStaff: true, now: new Date('2026-01-13T19:30:00Z') }), { refused: false, late: false, promote: false });
  }));

test('a place on the waiting list can be given up at any time and promotes nobody', () =>
  inLondon(() => {
    assert.deepEqual(cancelOutcome(waiting, { cancelHours: 0 }, at('2026-01-13T10:00:00Z')), { refused: false, late: false, promote: false });
    assert.equal(cancelOutcome(waiting, { cancelHours: 0 }, at('2026-01-13T19:30:00Z')).refused, false);
  }));

// A class deleted or switched off cancels its bookings still to come
// (gymClassController.upcomingBookings is which ones those are).
test('the bookings a stopped class takes with it are on later days and later today, not on sessions already started', () =>
  inLondon(() => {
    const { upcomingBookings } = require('../../src/gymfolio/controller/gymClassController');
    assert.deepEqual(upcomingBookings('class-1', new Date('2026-01-13T18:30:00Z')), {
      classId: 'class-1',
      $or: [{ sessionDate: { $gt: '2026-01-13' } }, { sessionDate: '2026-01-13', sessionStart: { $gt: '18:30' } }]
    });
    // In July London is an hour ahead of UTC: 23:30Z is already the next day there.
    assert.deepEqual(upcomingBookings('class-1', new Date('2026-07-13T23:30:00Z')).$or, [
      { sessionDate: { $gt: '2026-07-14' } },
      { sessionDate: '2026-07-14', sessionStart: { $gt: '00:30' } }
    ]);
  }));
