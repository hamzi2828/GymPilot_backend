// Deleting an account gives its places up, against a real MongoDB.
//
// A member who deleted their account used to keep their class bookings: the
// class stayed "full" for somebody who could never come, and whoever was on
// the waiting list stayed there. Deleting now cancels every upcoming class
// place and PT session the account holds, and the freed place goes to the
// next in line exactly as when a booking is cancelled.
//
// The gym's clock is set to midday (h.middayZone) and every session is
// tomorrow or later, so cut-offs and cancel windows never interfere.

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let T;
let User;
let GymClass;
let ClassBooking;
let PtSession;
let users;
let bookings;
let admin;
let tomorrow;
let slot;

const bearer = (account) => `Bearer ${jwt.sign({ id: String(account._id), email: account.email, role: account.role || 'user' }, process.env.JWT_SECRET)}`;

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  User = h.src('models/user');
  GymClass = h.src('gymfolio/models/gymClassModel');
  ClassBooking = h.src('gymfolio/models/classBookingModel');
  PtSession = h.src('gymfolio/models/ptSessionModel');
  users = h.src('controller/userController');
  bookings = h.src('gymfolio/controller/classBookingController');

  gym = await h.createGym('deletion-bookings-gym', { timezone: h.middayZone(), currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(ClassBooking, PtSession, User);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@deletion-bookings.test', role: 'admin', password: 'x', employment: { isStaff: true } });
    tomorrow = T.shiftDateKey(T.dateKey(), 1);
    slot = [{ day: T.weekdayNameForKey(tomorrow), startTime: '18:00', endTime: '19:00', instructorName: 'Coach' }];
  });
});

let n = 0;
function member(firstName) {
  n += 1;
  return User.create({ firstName, lastName: 'Test', email: `${firstName.toLowerCase()}${n}@deletion-bookings.test`, memberCode: `GP-${String(n).padStart(4, '0')}` });
}

function book(account, gymClass) {
  return h.call(bookings.create, {
    user: { id: String(account._id) },
    body: { classId: String(gymClass._id), date: tomorrow, startTime: '18:00' }
  });
}

// A full one-place class, its holder, and somebody waiting for it.
async function fullClass(name) {
  const gymClass = await GymClass.create({ name, description: `${name} class`, capacity: 1, schedule: slot });
  const holder = await member(`${name}Holder`);
  const waiting = await member(`${name}Waiting`);
  const first = await book(holder, gymClass);
  assert.equal(first.statusCode, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.status, 'booked');
  const second = await book(waiting, gymClass);
  assert.equal(second.statusCode, 201, JSON.stringify(second.body));
  assert.equal(second.body.data.status, 'waitlisted');
  return { gymClass, holder, waiting, holderBooking: first.body.data.id, waitingBooking: second.body.data.id };
}

async function assertPlaceMovedOn({ gymClass, holderBooking, waitingBooking }) {
  const gone = await ClassBooking.findById(holderBooking).lean();
  assert.equal(gone.status, 'cancelled');
  assert.equal(gone.cancelReason, 'Account deleted');
  const promoted = await ClassBooking.findById(waitingBooking).lean();
  assert.equal(promoted.status, 'booked', 'the waiting member has the place');
  assert.equal(promoted.waitlistPosition, null);
  assert.equal(await ClassBooking.countBooked(gymClass._id, tomorrow, '18:00'), 1);
  assert.equal(await ClassBooking.countWaitlisted(gymClass._id, tomorrow, '18:00'), 0);
}

test('a booked member deleting their account hands the place to the waiting list', async () => {
  await h.inGym(gym, async () => {
    const setup = await fullClass('Spin');
    const res = await h.call(users.deleteUser, { headers: { authorization: bearer(setup.holder) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(await User.exists({ _id: setup.holder._id }), null);
    await assertPlaceMovedOn(setup);
  });
});

test('so does staff deleting the member from the Users screen', async () => {
  await h.inGym(gym, async () => {
    const setup = await fullClass('Yoga');
    const res = await h.call(users.deleteUserById, {
      headers: { authorization: bearer(admin) },
      user: { id: String(admin._id), role: 'admin' },
      roleSlug: 'admin',
      params: { id: String(setup.holder._id) }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    await assertPlaceMovedOn(setup);
    assert.equal(String((await ClassBooking.findById(setup.holderBooking).lean()).cancelledBy), String(admin._id));
  });
});

test('a waiting member deleting their account leaves the waiting list', async () => {
  await h.inGym(gym, async () => {
    const setup = await fullClass('Box');
    const res = await h.call(users.deleteUser, { headers: { authorization: bearer(setup.waiting) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal((await ClassBooking.findById(setup.waitingBooking).lean()).status, 'cancelled');
    assert.equal((await ClassBooking.findById(setup.holderBooking).lean()).status, 'booked');
    assert.equal(await ClassBooking.countWaitlisted(setup.gymClass._id, tomorrow, '18:00'), 0);
  });
});

test('upcoming PT sessions are cancelled, past ones are left as they were', async () => {
  await h.inGym(gym, async () => {
    const pat = await member('Pat');
    const base = { trainerId: new h.state.mongoose.Types.ObjectId(), trainerName: 'Coach', memberId: pat._id, memberName: 'Pat Test', price: 3000, currency: 'PKR' };
    const upcoming = await PtSession.create({ ...base, date: T.shiftDateKey(T.dateKey(), 2), startTime: '10:00', endTime: '11:00' });
    const past = await PtSession.create({ ...base, date: T.shiftDateKey(T.dateKey(), -2), startTime: '10:00', endTime: '11:00', status: 'completed' });

    const res = await h.call(users.deleteUser, { headers: { authorization: bearer(pat) } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const after = await PtSession.findById(upcoming._id).lean();
    assert.equal(after.status, 'cancelled');
    assert.equal(after.lateCancel, false);
    assert.equal((await PtSession.findById(past._id).lean()).status, 'completed');
  });
});
