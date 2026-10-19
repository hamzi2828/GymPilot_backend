// Class booking against a real MongoDB, through the controller: numbered
// places (the unique seat index) mean the last place is taken exactly once
// even when requests arrive together, the one-live-booking index refuses a
// double tap, and two cancels of one booking give the credit back once and
// promote one person.
//
// The gym's clock is set to midday (h.middayZone) and every session is
// tomorrow or later, so cut-offs and the late-cancel window never interfere.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let T;
let User;
let GymClass;
let ClassBooking;
let PackageOrder;
let bookings;
let members;
let classes;
let tomorrow;
let weekday;

const raceOutcomes = [];

async function member(n) {
  const user = await User.create({ firstName: `Member${n}`, lastName: 'Test', email: `m${n}@booking.test`, memberCode: `GP-${String(n).padStart(4, '0')}` });
  const now = new Date();
  const order = await PackageOrder.create({
    orderNumber: `PACK-${n}`,
    userId: user._id,
    packageId: new h.state.mongoose.Types.ObjectId(),
    packageDetails: { name: '10-class pack', price: '80', currency: 'GBP', period: 'month', kind: 'session_pack', sessions: 10 },
    customerInfo: { fullName: `Member${n} Test`, email: `m${n}@booking.test` },
    payment: { method: 'cash', amount: 80, currency: 'GBP', status: 'paid', paidAt: now },
    subscription: { startDate: now, endDate: new Date(now.getTime() + 60 * 86400000), isActive: true },
    status: 'active',
    sessions: { total: 10, used: 0 }
  });
  return { user, order };
}

async function creditsUsed(m) {
  return (await PackageOrder.findById(m.order._id).lean()).sessions.used;
}

function book(m, gymClass, date) {
  return h.call(bookings.create, {
    user: { id: String(m.user._id) },
    body: { classId: String(gymClass._id), date, startTime: '18:00' }
  });
}

function cancel(m, bookingId) {
  return h.call(bookings.cancel, { user: { id: String(m.user._id) }, params: { id: String(bookingId) }, body: {} });
}

async function settle(check, { tries = 40, every = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  return false;
}

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  User = h.src('models/user');
  GymClass = h.src('gymfolio/models/gymClassModel');
  ClassBooking = h.src('gymfolio/models/classBookingModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  bookings = h.src('gymfolio/controller/classBookingController');

  gym = await h.createGym('booking-gym', { timezone: h.middayZone(), currency: 'GBP' });

  await h.inGym(gym, async () => {
    await h.ensureIndexes(ClassBooking, PackageOrder, User);
    tomorrow = T.shiftDateKey(T.dateKey(), 1);
    weekday = T.weekdayNameForKey(tomorrow);
    const slot = [{ day: weekday, startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
    classes = {
      spin: await GymClass.create({ name: 'Spin', description: 'Spin class', capacity: 1, schedule: slot }),
      yoga: await GymClass.create({ name: 'Yoga', description: 'Yoga class', capacity: 2, schedule: slot }),
      box: await GymClass.create({ name: 'Box', description: 'Boxing class', capacity: 1, schedule: slot }),
      hiit: await GymClass.create({ name: 'HIIT', description: 'HIIT class', capacity: 5, schedule: slot })
    };
    members = [];
    for (let n = 1; n <= 7; n++) members.push(await member(n));
  });
});

test('a booking goes through the real controller and takes one credit', async () => {
  await h.inGym(gym, async () => {
    const m = members[6];
    const before = await creditsUsed(m);
    const res = await book(m, classes.hiit, tomorrow);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'booked');
    assert.equal(res.body.data.credit_used, true);
    assert.equal(await creditsUsed(m), before + 1);
  });
});

test('the last place cannot be taken twice by two members booking at the same moment', async () => {
  await h.inGym(gym, async () => {
    const [a, b] = members;
    // Four runnings of the capacity-1 class, each raced by two members.
    for (let week = 0; week < 4; week++) {
      const date = T.shiftDateKey(tomorrow, week * 7);
      const usedBefore = [await creditsUsed(a), await creditsUsed(b)];
      const results = await Promise.all([book(a, classes.spin, date), book(b, classes.spin, date)]);
      for (const res of results) assert.equal(res.statusCode, 201, JSON.stringify(res.body));

      const booked = await ClassBooking.countBooked(classes.spin._id, date, '18:00');
      const waiting = await ClassBooking.countWaitlisted(classes.spin._id, date, '18:00');
      assert.ok(booked <= 1, `${date}: ${booked} people hold the one place`);
      assert.equal(booked + waiting, 2);

      // A credit is spent only by whoever holds a place.
      const usedAfter = [await creditsUsed(a), await creditsUsed(b)];
      const statuses = results.map((res) => res.body.data.status);
      statuses.forEach((status, i) => {
        assert.equal(usedAfter[i] - usedBefore[i], status === 'booked' ? 1 : 0, `${date}: member ${i} is ${status} with ${usedAfter[i] - usedBefore[i]} credits spent`);
      });
      raceOutcomes.push({ className: 'Spin', capacity: 1, racers: 2, date, booked, waiting, statuses });
    }
  });
});

test('three members racing for two places: never more than two booked', async () => {
  await h.inGym(gym, async () => {
    const racers = members.slice(2, 5);
    const results = await Promise.all(racers.map((m) => book(m, classes.yoga, tomorrow)));
    for (const res of results) assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const booked = await ClassBooking.countBooked(classes.yoga._id, tomorrow, '18:00');
    const waiting = await ClassBooking.countWaitlisted(classes.yoga._id, tomorrow, '18:00');
    assert.ok(booked <= 2, `${booked} booked into 2 places`);
    assert.equal(booked + waiting, 3);
    raceOutcomes.push({ className: 'Yoga', capacity: 2, racers: 3, date: tomorrow, booked, waiting, statuses: results.map((res) => res.body.data.status) });
  });
});

test(
  'members racing for the last places: every place is taken',
  () => {
    const lost = raceOutcomes.filter((outcome) => outcome.booked < Math.min(outcome.capacity, outcome.racers));
    assert.deepEqual(lost, [], `places lost in ${lost.length} of ${raceOutcomes.length} races: ${JSON.stringify(lost)}`);
  }
);

test('a double tap books once: the partial unique index refuses the second, and its credit comes back', async () => {
  await h.inGym(gym, async () => {
    const m = members[5];
    const date = T.shiftDateKey(tomorrow, 7);
    const before = await creditsUsed(m);
    const results = await Promise.all([book(m, classes.hiit, date), book(m, classes.hiit, date)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409], JSON.stringify(results.map((r) => r.body)));
    assert.equal(await ClassBooking.countDocuments({ userId: m.user._id, classId: classes.hiit._id, sessionDate: date }), 1);
    // The losing request's credit is handed back without being awaited.
    const back = await settle(async () => (await creditsUsed(m)) === before + 1);
    assert.ok(back, `pack shows ${await creditsUsed(m)} used, expected ${before + 1}`);
  });
});

test('two cancels of one booking: one succeeds, the credit comes back once, one person is promoted', async () => {
  await h.inGym(gym, async () => {
    const [holder, first, second] = members;
    const date = tomorrow;

    const held = await book(holder, classes.box, date);
    assert.equal(held.body.data.status, 'booked');
    const w1 = await book(first, classes.box, date);
    const w2 = await book(second, classes.box, date);
    assert.equal(w1.body.data.status, 'waitlisted');
    assert.equal(w1.body.data.waitlist_position, 1);
    assert.equal(w2.body.data.waitlist_position, 2);

    const holderBefore = await creditsUsed(holder);
    const firstBefore = await creditsUsed(first);
    const secondBefore = await creditsUsed(second);

    const results = await Promise.all([cancel(holder, held.body.data.id), cancel(holder, held.body.data.id)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
    const winner = results.find((r) => r.statusCode === 200);
    assert.equal(winner.body.promoted.id, w1.body.data.id);

    assert.equal(await creditsUsed(holder), holderBefore - 1, 'the credit went back once');
    assert.equal(await creditsUsed(first), firstBefore + 1, 'the promoted member pays for the place');
    assert.equal(await creditsUsed(second), secondBefore, 'still waiting, still free');

    const rows = await ClassBooking.find({ classId: classes.box._id, sessionDate: date }).lean();
    const by = (id) => rows.find((r) => String(r._id) === String(id));
    assert.equal(by(held.body.data.id).status, 'cancelled');
    assert.equal(by(w1.body.data.id).status, 'booked');
    assert.equal(by(w1.body.data.id).creditUsed, true);
    assert.equal(by(w2.body.data.id).status, 'waitlisted');
    assert.equal(by(w2.body.data.id).waitlistPosition, 1, 'the queue closes up');
    assert.equal(await ClassBooking.countBooked(classes.box._id, date, '18:00'), 1);
  });
});

test(
  'a credit handed back while another is being taken from the same pack loses neither',
  async () => {
    const { consumeSession, refundSession } = h.src('gymfolio/services/membershipService');
    await h.inGym(gym, async () => {
      const m = members[6];
      const start = await creditsUsed(m);
      // The interleaving a cancel (giveCreditBack: findById ... save) and a
      // booking on the same pack can produce: the cancel reads the order, the
      // booking's credit lands, then the cancel writes its copy back.
      const readByCancel = await PackageOrder.findById(m.order._id);
      await consumeSession(await PackageOrder.findById(m.order._id), { note: 'booking in between' });
      await refundSession(readByCancel);
      assert.equal(await creditsUsed(m), start, `one back and one taken should leave ${start} used, pack shows ${await creditsUsed(m)}`);
    });
  }
);

test('a credit handed back reopens a spent pack, and never takes the count below zero', async () => {
  const { consumeSession, refundSession } = h.src('gymfolio/services/membershipService');
  await h.inGym(gym, async () => {
    const { order } = await member(20);
    await PackageOrder.updateOne({ _id: order._id }, { $set: { 'sessions.total': 1 } });
    await consumeSession(await PackageOrder.findById(order._id), { note: 'the last one' });
    let pack = await PackageOrder.findById(order._id).lean();
    assert.equal(pack.status, 'expired');
    assert.ok(pack.sessions.exhaustedAt);

    await refundSession(await PackageOrder.findById(order._id));
    pack = await PackageOrder.findById(order._id).lean();
    assert.equal(pack.sessions.used, 0);
    assert.equal(pack.sessions.exhaustedAt, null);
    assert.equal(pack.status, 'active');
    assert.equal(pack.subscription.isActive, true);

    await refundSession(await PackageOrder.findById(order._id));
    assert.equal((await PackageOrder.findById(order._id).lean()).sessions.used, 0);
  });
});

// Places that were taken before places were numbered have no seat. They still
// count, and a race for what is left fills it exactly.
test('bookings without a seat number still take up places: racers get only what is left', async () => {
  await h.inGym(gym, async () => {
    const slot = [{ day: weekday, startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
    const pilates = await GymClass.create({ name: 'Pilates', description: 'Pilates class', capacity: 3, schedule: slot });
    const { Types } = h.state.mongoose;
    const legacy = [];
    for (let i = 0; i < 2; i++) {
      const row = { _id: new Types.ObjectId(), classId: pilates._id, className: 'Pilates', userId: new Types.ObjectId(), sessionDate: tomorrow, sessionStart: '18:00', status: 'booked', waitlistPosition: null, createdAt: new Date(), updatedAt: new Date() };
      await ClassBooking.collection.insertOne(row);
      legacy.push(row);
    }

    const racers = [await member(21), await member(22), await member(23)];
    const results = await Promise.all(racers.map((m) => book(m, pilates, tomorrow)));
    for (const res of results) assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual(results.map((res) => res.body.data.status).sort(), ['booked', 'waitlisted', 'waitlisted']);
    assert.equal(await ClassBooking.countBooked(pilates._id, tomorrow, '18:00'), 3);

    // A legacy place given up goes to the front of the queue, numbered.
    const res = await h.call(bookings.cancel, { user: { id: String(racers[0].user._id) }, isStaffBooking: true, params: { id: String(legacy[0]._id) }, body: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.promoted, 'somebody was promoted');
    const promoted = await ClassBooking.findById(res.body.promoted.id).lean();
    assert.equal(promoted.status, 'booked');
    assert.ok(promoted.seat >= 1 && promoted.seat <= 3, `seat ${promoted.seat}`);
    assert.equal(await ClassBooking.countBooked(pilates._id, tomorrow, '18:00'), 3);
  });
});

test('a cancel and a new booking racing for the freed place: it is taken exactly once', async () => {
  await h.inGym(gym, async () => {
    const slot = [{ day: weekday, startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
    const row = await GymClass.create({ name: 'Row', description: 'Rowing class', capacity: 1, schedule: slot });
    const [holder, waiting, newcomer] = [await member(24), await member(25), await member(26)];
    for (let week = 0; week < 4; week++) {
      const date = T.shiftDateKey(tomorrow, week * 7);
      const held = await book(holder, row, date);
      assert.equal(held.body.data.status, 'booked');
      assert.equal((await book(waiting, row, date)).body.data.status, 'waitlisted');

      const [cancelled, booked] = await Promise.all([cancel(holder, held.body.data.id), book(newcomer, row, date)]);
      assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.body));
      assert.equal(booked.statusCode, 201, JSON.stringify(booked.body));
      assert.equal(await ClassBooking.countBooked(row._id, date, '18:00'), 1, `${date}: the one place`);
      assert.equal(await ClassBooking.countWaitlisted(row._id, date, '18:00'), 1, `${date}: the other waits`);
    }
  });
});

test('the desk putting a no-show back into a place that has since gone: an override, not an error', async () => {
  await h.inGym(gym, async () => {
    const slot = [{ day: weekday, startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
    const barre = await GymClass.create({ name: 'Barre', description: 'Barre class', capacity: 1, schedule: slot });
    const [first, second, third] = [await member(27), await member(28), await member(29)];
    const staff = { id: String(first.user._id) };

    const held = await book(first, barre, tomorrow);
    const marked = await h.call(bookings.setStatus, { user: staff, params: { id: held.body.data.id }, body: { status: 'no_show' } });
    assert.equal(marked.statusCode, 200, JSON.stringify(marked.body));
    // The no-show gave the place up; the next member takes it.
    assert.equal((await book(second, barre, tomorrow)).body.data.status, 'booked');

    const back = await h.call(bookings.setStatus, { user: staff, params: { id: held.body.data.id }, body: { status: 'booked' } });
    assert.equal(back.statusCode, 200, JSON.stringify(back.body));
    assert.equal(await ClassBooking.countBooked(barre._id, tomorrow, '18:00'), 2);
    // It still counts: nobody else is let in.
    assert.equal((await book(third, barre, tomorrow)).body.data.status, 'waitlisted');
  });
});

test('a membership sold to start later books the classes from its first day, and is told when it starts before then', async () => {
  await h.inGym(gym, async () => {
    const slot = [{ day: weekday, startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
    const stretch = await GymClass.create({ name: 'Stretch', description: 'Stretch class', capacity: 10, schedule: slot });

    // A monthly membership (no sessions) paid today, starting on `startKey`.
    async function startingOn(n, startKey) {
      const user = await User.create({ firstName: `Later${n}`, lastName: 'Test', email: `later${n}@booking.test` });
      const start = T.startOfLocalDay(startKey);
      await PackageOrder.create({
        orderNumber: `LATER-${n}`,
        userId: user._id,
        packageId: new h.state.mongoose.Types.ObjectId(),
        packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
        customerInfo: { fullName: `Later${n} Test`, email: user.email },
        payment: { method: 'cash', amount: 40, currency: 'GBP', status: 'paid', paidAt: new Date() },
        subscription: { startDate: start, endDate: new Date(start.getTime() + 30 * 86400000), isActive: true },
        status: 'active'
      });
      return { user };
    }

    // Starts tomorrow: tomorrow's class is inside it.
    const fromTomorrow = await startingOn(1, tomorrow);
    const covered = await book(fromTomorrow, stretch, tomorrow);
    assert.equal(covered.statusCode, 201, JSON.stringify(covered.body));
    assert.equal(covered.body.membership_warning, null);
    assert.equal(covered.body.data.membership_status, 'active');

    // Starts the day after: the booking is recorded, and the member is told
    // when the membership starts -- not that a payment is awaited.
    const dayAfter = T.shiftDateKey(tomorrow, 1);
    const tooSoon = await book(await startingOn(2, dayAfter), stretch, tomorrow);
    assert.equal(tooSoon.statusCode, 201, JSON.stringify(tooSoon.body));
    assert.equal(tooSoon.body.membership_warning, `Your membership starts on ${T.dateLabelForKey(dayAfter)} — classes can be booked from then.`);
    assert.equal(tooSoon.body.data.membership_status, 'pending');
  });
});

// The gym calls a session off (a timetable change) while a member is
// cancelling their own place on it. The member's cancel is held back until
// the gym's has read the bookings and is working through them, which is the
// order that used to cancel that booking twice.
test('the gym cancelling a session as a member cancels their place: the credit comes back once', async () => {
  await h.inGym(gym, async () => {
    const exceptions = h.src('gymfolio/controller/classExceptionController');
    const date = T.shiftDateKey(tomorrow, 14);
    const slot = [{ day: weekday, startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
    const circuits = await GymClass.create({ name: 'Circuits', description: 'Circuits class', capacity: 10, schedule: slot });

    const people = [];
    for (let n = 150; n < 156; n++) people.push(await member(n));
    const held = [];
    for (const m of people) {
      // Several used already, so a credit handed back twice shows.
      await PackageOrder.updateOne({ _id: m.order._id }, { $set: { 'sessions.used': 5 } });
      const res = await book(m, circuits, date);
      assert.equal(res.body.data.status, 'booked', JSON.stringify(res.body));
      held.push(res.body.data.id);
    }
    const last = people.length - 1;

    const calledOff = h.call(exceptions.create, { user: { id: String(people[0].user._id) }, body: { classId: String(circuits._id), date, startTime: '18:00', kind: 'cancelled', note: 'Coach is ill' } });
    const underWay = await settle(async () => (await ClassBooking.findById(held[0]).select('status').lean()).status === 'cancelled', { tries: 2000, every: 0 });
    assert.ok(underWay, 'the gym got as far as the first booking');
    const own = await cancel(people[last], held[last]);
    const res = await calledOff;
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));

    // Whichever of the two reached the last booking first cancelled it.
    assert.ok([200, 409].includes(own.statusCode), JSON.stringify(own.body));
    assert.equal(res.body.cancelled_bookings + (own.statusCode === 200 ? 1 : 0), people.length);
    for (const [i, m] of people.entries()) {
      assert.equal((await ClassBooking.findById(held[i]).lean()).status, 'cancelled');
      assert.equal(await creditsUsed(m), 5, `member ${i}: one credit taken to book, one given back`);
    }
  });
});

// A class that stops running takes its coming bookings with it: switched off
// from the list, switched off from the edit form, or deleted.
test('deactivating or deleting a class cancels its upcoming bookings, returns the credits and tells the members', async () => {
  await h.inGym(gym, async () => {
    const classesController = h.src('gymfolio/controller/gymClassController');
    const today = T.dateKey();
    const staff = { id: String(members[0].user._id) };
    const slot = [{ day: weekday, startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
    const stop = {
      toggle: (c) => h.call(classesController.toggleClassStatus, { user: staff, params: { id: String(c._id) }, body: {} }),
      edit: (c) => h.call(classesController.updateClass, { user: staff, params: { id: String(c._id) }, body: { isActive: 'false' } }),
      remove: (c) => h.call(classesController.deleteClass, { user: staff, params: { id: String(c._id) } })
    };

    let n = 160;
    for (const [how, run] of Object.entries(stop)) {
      const gymClass = await GymClass.create({ name: `Zumba ${how}`, description: 'Zumba class', capacity: 2, schedule: slot });
      const [a, b, c, earlier] = [await member(n++), await member(n++), await member(n++), await member(n++)];
      const held = [await book(a, gymClass, tomorrow), await book(b, gymClass, tomorrow)];
      const queued = await book(c, gymClass, tomorrow);
      assert.deepEqual([...held, queued].map((r) => r.body.data.status), ['booked', 'booked', 'waitlisted'], how);
      // This morning's session, which has been and gone: not touched.
      await PackageOrder.updateOne({ _id: earlier.order._id }, { $set: { 'sessions.used': 1 } });
      const past = await ClassBooking.create({ classId: gymClass._id, className: gymClass.name, userId: earlier.user._id, sessionDate: today, sessionStart: '09:00', status: 'booked', seat: 1, creditUsed: true, orderId: earlier.order._id });

      const told = h.calls.notifications.filter((x) => x.name === 'bookingCancelled').length;
      const res = await run(gymClass);
      assert.equal(res.statusCode, 200, `${how}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.cancelled_bookings, 3, how);
      assert.match(res.body.message, /3 upcoming booking\(s\) were cancelled and the members told\.$/, how);

      for (const r of [...held, queued]) {
        const row = await ClassBooking.findById(r.body.data.id).lean();
        assert.equal(row.status, 'cancelled', how);
        assert.equal(row.cancelReason, `Zumba ${how} is no longer running`);
        assert.equal(row.waitlistPosition, null);
      }
      assert.deepEqual([await creditsUsed(a), await creditsUsed(b), await creditsUsed(c)], [0, 0, 0], `${how}: the credits are back`);
      assert.equal((await ClassBooking.findById(past._id).lean()).status, 'booked', `${how}: a session already held is left alone`);
      assert.equal(await creditsUsed(earlier), 1);
      const nowTold = await settle(() => h.calls.notifications.filter((x) => x.name === 'bookingCancelled').length === told + 3);
      assert.ok(nowTold, `${how}: three members told`);

      if (how !== 'remove') {
        // Switched back on: nothing to cancel, and nothing comes back by itself.
        const on = await stop.toggle(gymClass);
        assert.equal(on.body.cancelled_bookings, 0);
        assert.equal(on.body.message, 'Class activated successfully');
        assert.equal(await ClassBooking.countBooked(gymClass._id, tomorrow, '18:00'), 0);
      } else {
        assert.equal(await GymClass.findById(gymClass._id), null);
      }
    }
  });
});

// A class that started at 09:00 today (the gym's clock reads midday). The
// controller will not book into it, so the rows are written as they would
// have been when it was booked: one place held on a pack credit, one waiting.
test('after the class has started a member cannot cancel; the desk can, and nobody is promoted', async () => {
  await h.inGym(gym, async () => {
    const today = T.dateKey();
    const slot = [{ day: T.weekdayNameForKey(today), startTime: '09:00', endTime: '10:00', instructorName: 'Coach' }];
    const dawn = await GymClass.create({ name: 'Dawn', description: 'Early class', capacity: 1, schedule: slot });
    const [holder, waiter] = [await member(140), await member(141)];
    await PackageOrder.updateOne({ _id: holder.order._id }, { $set: { 'sessions.used': 1 } });

    const row = (m, extra) => ({ classId: dawn._id, className: 'Dawn', userId: m.user._id, memberName: `${m.user.firstName} Test`, sessionDate: today, sessionStart: '09:00', sessionEnd: '10:00', ...extra });
    const held = await ClassBooking.create(row(holder, { status: 'booked', seat: 1, creditUsed: true, orderId: holder.order._id }));
    const queued = await ClassBooking.create(row(waiter, { status: 'waitlisted', waitlistPosition: 1 }));

    // The member, after the class: refused, and nothing has moved.
    const refused = await cancel(holder, held._id);
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body));
    assert.match(refused.body.message, /already started/);
    assert.match(refused.body.message, /front desk/);
    assert.equal((await ClassBooking.findById(held._id).lean()).status, 'booked');
    assert.equal(await creditsUsed(holder), 1, 'no credit back for a class that has been and gone');
    assert.equal((await ClassBooking.findById(queued._id).lean()).status, 'waitlisted');
    assert.equal(await creditsUsed(waiter), 0);

    // The desk putting a mistake right: cancelled and the credit returned,
    // but the waiting member is not moved into a finished class or charged.
    const desk = await h.call(bookings.cancel, { user: { id: String(waiter.user._id) }, isStaffBooking: true, params: { id: String(held._id) }, body: {} });
    assert.equal(desk.statusCode, 200, JSON.stringify(desk.body));
    assert.equal(desk.body.promoted, null);
    assert.equal(desk.body.data.status, 'cancelled');
    assert.equal(await creditsUsed(holder), 0);
    const still = await ClassBooking.findById(queued._id).lean();
    assert.equal(still.status, 'waitlisted');
    assert.equal(still.waitlistPosition, 1);
    assert.equal(await creditsUsed(waiter), 0);

    // A stale place on the waiting list can still be given up by the member.
    const gaveUp = await cancel(waiter, queued._id);
    assert.equal(gaveUp.statusCode, 200, JSON.stringify(gaveUp.body));
    assert.equal(gaveUp.body.promoted, null);
  });
});

// ---- Refusals about the member's own membership ------------------------------
//
// A 402 from booking is about the member -- a lapsed membership, a pack with
// nothing left -- and says so with a code (MEMBERSHIP_REQUIRED or
// NO_SESSIONS_LEFT), so the apps show the message beside the class instead
// of reading any 402 as "the gym is closed".

test('booking with no membership at a gym that requires one: 402 MEMBERSHIP_REQUIRED, with the same message', async () => {
  const strict = await h.createGym('booking-strict-gym', { timezone: h.middayZone(), currency: 'GBP', settings: { booking: { requireActiveMembership: true } } });
  await h.inGym(strict, async () => {
    await h.ensureIndexes(ClassBooking, PackageOrder, User);
    const date = T.shiftDateKey(T.dateKey(), 1);
    const gymClass = await GymClass.create({ name: 'Strict', description: 'Members only', capacity: 5, schedule: [{ day: T.weekdayNameForKey(date), startTime: '18:00', endTime: '19:00' }] });

    const nobody = await User.create({ firstName: 'No', lastName: 'Plan', email: 'noplan@booking.test' });
    const res = await book({ user: nobody }, gymClass, date);
    assert.equal(res.statusCode, 402, JSON.stringify(res.body));
    assert.equal(res.body.code, 'MEMBERSHIP_REQUIRED');
    assert.equal(res.body.message, 'There is no membership on this account — please speak to the front desk.');

    // A pack with nothing left reads as that, not as a lapsed membership.
    const spent = await member(9150);
    await PackageOrder.updateOne({ _id: spent.order._id }, { $set: { 'sessions.used': 10, 'sessions.exhaustedAt': new Date(), status: 'expired', 'subscription.isActive': false } });
    const empty = await book(spent, gymClass, date);
    assert.equal(empty.statusCode, 402, JSON.stringify(empty.body));
    assert.equal(empty.body.code, 'NO_SESSIONS_LEFT');
    assert.equal(await ClassBooking.countDocuments({ classId: gymClass._id }), 0);
  });
});

test('booking on a pack with no sessions left: 402 NO_SESSIONS_LEFT, and nothing is booked', async () => {
  await h.inGym(gym, async () => {
    const date = T.shiftDateKey(tomorrow, 14);
    // The last credit taken a moment ago: still active, nothing left.
    const justUsedUp = await member(9151);
    await PackageOrder.updateOne({ _id: justUsedUp.order._id }, { $set: { 'sessions.used': 10 } });
    const res = await book(justUsedUp, classes.hiit, date);
    assert.equal(res.statusCode, 402, JSON.stringify(res.body));
    assert.equal(res.body.code, 'NO_SESSIONS_LEFT');
    assert.equal(res.body.message, 'No sessions left on this pack');

    // Spent and closed by the last booking: the same answer, not "expired".
    const closed = await member(9152);
    await PackageOrder.updateOne({ _id: closed.order._id }, { $set: { 'sessions.used': 10, 'sessions.exhaustedAt': new Date(), status: 'expired', 'subscription.isActive': false } });
    const again = await book(closed, classes.hiit, date);
    assert.equal(again.statusCode, 402, JSON.stringify(again.body));
    assert.equal(again.body.code, 'NO_SESSIONS_LEFT');

    assert.equal(await ClassBooking.countDocuments({ classId: classes.hiit._id, sessionDate: date }), 0);
    assert.equal(await creditsUsed(justUsedUp), 10);
  });
});

// A late cancel keeps the credit -- but only a place booked on a credit had
// one to keep. A place on the waiting list, or on a plan that takes none,
// is simply cancelled.
test('a late cancel says the credit stays used only when a credit was taken and kept', async () => {
  await h.inGym(gym, async () => {
    const today = T.dateKey();
    // An hour or two from now (the gym's clock reads midday): inside the
    // two-hour window, not started.
    const soon = (name) => GymClass.create({ name, description: 'Soon', capacity: 1, schedule: [{ day: T.weekdayNameForKey(today), startTime: '14:00', endTime: '15:00' }] });
    const row = (gymClass, m, extra) => ({ classId: gymClass._id, className: gymClass.name, userId: m.user._id, memberName: 'Late Test', sessionDate: today, sessionStart: '14:00', sessionEnd: '15:00', ...extra });

    // On a credit: kept, and said so.
    const credited = await member(9153);
    await PackageOrder.updateOne({ _id: credited.order._id }, { $set: { 'sessions.used': 1 } });
    const onCredit = await ClassBooking.create(row(await soon('Late credit'), credited, { status: 'booked', seat: 1, creditUsed: true, orderId: credited.order._id }));
    const kept = await cancel(credited, onCredit._id);
    assert.equal(kept.statusCode, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.data.late_cancel, true);
    assert.equal(kept.body.message, 'Cancelled. This was inside the 2-hour window, so the session credit stays used.');
    assert.equal(await creditsUsed(credited), 1);

    // On the waiting list: there was no credit.
    const waiting = await member(9154);
    const queued = await ClassBooking.create(row(await soon('Late wait'), waiting, { status: 'waitlisted', waitlistPosition: 1 }));
    const fromList = await cancel(waiting, queued._id);
    assert.equal(fromList.statusCode, 200, JSON.stringify(fromList.body));
    assert.equal(fromList.body.message, 'Booking cancelled.');
    assert.equal(await creditsUsed(waiting), 0);

    // A place on a plan that takes no credits.
    const monthly = await member(9155);
    const noCredit = await ClassBooking.create(row(await soon('Late plain'), monthly, { status: 'booked', seat: 1, creditUsed: false }));
    const plain = await cancel(monthly, noCredit._id);
    assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.message, 'Booking cancelled.');
    assert.ok(!/credit/i.test(plain.body.message));
  });
});
