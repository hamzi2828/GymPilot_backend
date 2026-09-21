// The member journey around the daily job, against a real MongoDB:
//
//   * expiry reminders skip a subscription that renews itself and a member
//     who has already renewed -- and pick them up again once that changes;
//   * auto no-show marks a member who checked in for the class attended, and
//     only the ones who did not turn up as no-shows;
//   * signing up online sends the welcome (which carries the app username);
//   * deleting an account first stops the member's card subscription, and
//     refuses when it cannot.
//
// The gym's clock is set to midday (h.middayZone), so "in 7 days" and
// "yesterday at 18:00" never straddle midnight whenever the suite runs.

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let T;
let User;
let PackageOrder;
let ClassBooking;
let Attendance;
let reminders;
let notify;
let users;
let payments;

const expiring = [];

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  User = h.src('models/user');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  ClassBooking = h.src('gymfolio/models/classBookingModel');
  Attendance = h.src('attendance/models/attendanceModel');
  reminders = h.src('services/reminderJobs');
  notify = h.src('services/gymNotifications');
  users = h.src('controller/userController');
  payments = h.src('services/gymfolioPaymentService');

  // The harness records notifications and answers null; the reminder job
  // only marks a notice sent when the send says it succeeded.
  notify.membershipExpiring = async (order, member, days) => {
    expiring.push({ order: order.orderNumber, days, email: member && member.email });
    return { success: true };
  };

  gym = await h.createGym('reminders-gym', { timezone: h.middayZone(), settings: { booking: { autoNoShow: true } } });
  await h.inGym(gym, () => h.ensureIndexes(User, PackageOrder, ClassBooking, Attendance));
});

const oid = () => new h.state.mongoose.Types.ObjectId();
let seq = 0;

async function member(first) {
  seq += 1;
  return User.create({ firstName: first, lastName: 'Member', email: `${first.toLowerCase()}${seq}@reminders.test` });
}

function order(user, { number, endDate, stripe = null, startDate = new Date(), status = 'active', payment = 'paid' }) {
  return PackageOrder.create({
    orderNumber: number,
    userId: user._id,
    packageId: oid(),
    packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
    customerInfo: { fullName: `${user.firstName} Member`, email: user.email },
    payment: {
      method: stripe ? 'stripe' : 'cash',
      amount: 40,
      currency: 'GBP',
      status: payment,
      paidAt: new Date(),
      stripeSubscriptionId: stripe ? stripe.id : null
    },
    subscription: {
      startDate,
      endDate,
      isActive: true,
      autoRenew: !!stripe && stripe.autoRenew !== false,
      cancelAtPeriodEnd: !!(stripe && stripe.cancelAtPeriodEnd),
      stripeStatus: stripe ? stripe.status || 'active' : ''
    },
    status
  });
}

const token = (user) => `Bearer ${jwt.sign({ id: String(user._id), email: user.email, role: user.role }, process.env.JWT_SECRET)}`;

/* ------------------------------ expiry notices ------------------------------ */

test('expiry notices: a subscription that renews itself and a member who already renewed are not told to renew', async () => {
  await h.inGym(gym, async () => {
    const inAWeek = T.localInstant(T.shiftDateKey(T.dateKey(), 7), 12, 0);
    const cash = await member('Cash');
    const auto = await member('Auto');
    const stopping = await member('Stopping');
    const renewed = await member('Renewed');

    await order(cash, { number: 'REM-CASH', endDate: inAWeek });
    await order(auto, { number: 'REM-AUTO', endDate: inAWeek, stripe: { id: 'sub_auto' } });
    await order(stopping, { number: 'REM-STOP', endDate: inAWeek, stripe: { id: 'sub_stop', cancelAtPeriodEnd: true, autoRenew: false } });
    await order(renewed, { number: 'REM-OLD', endDate: inAWeek });
    // Renewed at the desk: the next term starts when this one ends.
    await order(renewed, { number: 'REM-NEXT', startDate: inAWeek, endDate: new Date(inAWeek.getTime() + 30 * 86400000) });

    expiring.length = 0;
    const result = await reminders.sendExpiryReminders();

    assert.deepEqual(expiring.map((e) => e.order).sort(), ['REM-CASH', 'REM-STOP']);
    assert.ok(expiring.every((e) => e.days === 7));
    const why = Object.fromEntries(result.skipped.map((s) => [s.order, s.reason]));
    assert.equal(why['REM-AUTO'], 'renews automatically');
    assert.equal(why['REM-OLD'], 'already renewed');

    const sentFor = async (number) => (await PackageOrder.findOne({ orderNumber: number }).lean()).remindersSent;
    assert.deepEqual(await sentFor('REM-CASH'), [7]);
    assert.deepEqual(await sentFor('REM-STOP'), [7]);
    // Skipped, not marked: nothing was sent.
    assert.deepEqual(await sentFor('REM-AUTO'), []);
    assert.deepEqual(await sentFor('REM-OLD'), []);
  });
});

test('expiry notices: switching renewal off later brings the notices that are left', async () => {
  await h.inGym(gym, async () => {
    expiring.length = 0;
    let result = await reminders.sendExpiryReminders();
    assert.deepEqual(expiring, [], 'nothing twice, nothing new');
    const why = Object.fromEntries(result.skipped.map((s) => [s.order, s.reason]));
    assert.equal(why['REM-CASH'], 'already sent');
    assert.equal(why['REM-AUTO'], 'renews automatically');

    // The member cancels at period end (the webhook's customer.subscription.updated).
    await PackageOrder.updateOne(
      { orderNumber: 'REM-AUTO' },
      { $set: { 'subscription.cancelAtPeriodEnd': true, 'subscription.autoRenew': false } }
    );
    result = await reminders.sendExpiryReminders();
    assert.deepEqual(expiring.map((e) => e.order), ['REM-AUTO']);
  });
});

/* ------------------------------ auto no-show ------------------------------- */

test('auto no-show: a member who checked in for the class is marked attended, the rest no-shows', async () => {
  await h.inGym(gym, async () => {
    const today = T.dateKey();
    const yesterday = T.shiftDateKey(today, -1);
    const twoDaysAgo = T.shiftDateKey(today, -2);
    const classId = oid();
    const at = (key, hh, mm) => T.localInstant(key, hh, mm);

    const people = {};
    for (const name of ['Present', 'Absent', 'Morning', 'Unchecked', 'Waiting', 'Today', 'Older']) people[name] = await member(name);

    const book = (who, sessionDate, extra = {}) =>
      ClassBooking.create({
        classId,
        className: 'Spin',
        userId: people[who]._id,
        memberName: who,
        sessionDate,
        sessionStart: '18:00',
        sessionEnd: '19:00',
        status: 'booked',
        ...extra
      });
    const visit = (who, shiftDate, checkInAt, checkOutAt = null) =>
      Attendance.create({ personType: 'member', personId: people[who]._id, personName: who, shiftDate, checkInAt, checkOutAt });

    await book('Present', yesterday);
    await book('Absent', yesterday);
    await book('Morning', yesterday);
    await book('Unchecked', yesterday);
    await book('Waiting', yesterday, { status: 'waitlisted', waitlistPosition: 1 });
    await book('Today', today);
    await book('Older', twoDaysAgo);

    await visit('Present', yesterday, at(yesterday, 17, 45), at(yesterday, 19, 5));
    await visit('Morning', yesterday, at(yesterday, 8, 0), at(yesterday, 9, 0));
    // Never scanned out: the check-in alone, half an hour before the class.
    await visit('Unchecked', yesterday, at(yesterday, 17, 30));
    await visit('Older', twoDaysAgo, at(twoDaysAgo, 18, 5), at(twoDaysAgo, 19, 0));
    // Another member's visit at class time proves nothing about "Absent".
    await visit('Today', yesterday, at(yesterday, 17, 50), at(yesterday, 19, 0));

    const statusOf = async (who) => (await ClassBooking.findOne({ userId: people[who]._id }).lean()).status;

    const dry = await reminders.markMissedBookings({ dryRun: true });
    assert.deepEqual(dry, { enabled: true, marked: 2, attended: 3, dryRun: true });
    assert.equal(await statusOf('Present'), 'booked', 'a dry run writes nothing');

    const result = await reminders.markMissedBookings();
    assert.deepEqual(result, { enabled: true, marked: 2, attended: 3 });

    assert.equal(await statusOf('Present'), 'attended');
    assert.equal(await statusOf('Unchecked'), 'attended');
    assert.equal(await statusOf('Older'), 'attended');
    assert.equal(await statusOf('Absent'), 'no_show');
    assert.equal(await statusOf('Morning'), 'no_show', 'the morning visit was not the evening class');
    assert.equal(await statusOf('Waiting'), 'waitlisted');
    assert.equal(await statusOf('Today'), 'booked', 'today\'s class has not happened yet');

    const present = await ClassBooking.findOne({ userId: people.Present._id }).lean();
    assert.equal(present.attendedAt.getTime(), at(yesterday, 17, 45).getTime(), 'attended from the check-in');

    // Nothing left to settle.
    assert.deepEqual(await reminders.markMissedBookings(), { enabled: true, marked: 0, attended: 0 });
  });
});

/* -------------------------------- welcome ---------------------------------- */

test('signing up online sends the welcome, with the new account (and its username)', async () => {
  await h.inGym(gym, async () => {
    h.calls.notifications.length = 0;
    const res = await h.call(users.createUser, {
      body: { firstName: 'Nina', lastName: 'New', email: 'nina@reminders.test', password: 'long-enough-password' }
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const welcome = h.calls.notifications.filter((n) => n.name === 'memberWelcome');
    assert.equal(welcome.length, 1);
    const [account] = welcome[0].args;
    assert.equal(account.email, 'nina@reminders.test');
    assert.ok(account.username, 'the username is on the account the welcome is built from');
  });
});

/* ----------------------------- account deletion ---------------------------- */

// Sets (or, with undefined, hides) the payment service's cancel helper for
// one test -- as an own property, so a real one on the prototype is shadowed.
async function withCancelHelper(helper, fn) {
  const had = Object.prototype.hasOwnProperty.call(payments, 'cancelMemberSubscriptions');
  const previous = payments.cancelMemberSubscriptions;
  payments.cancelMemberSubscriptions = helper;
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    if (had) payments.cancelMemberSubscriptions = previous;
    else delete payments.cancelMemberSubscriptions;
  }
}

// What the payment service throws when Stripe would not stop a subscription.
function stripeCancelFailed(orderNumber) {
  const error = new Error(`Stripe could not stop this member's card subscription: ${orderNumber} (outage). Try again, or cancel it in the Stripe dashboard first.`);
  error.status = 502;
  error.code = 'STRIPE_CANCEL_FAILED';
  return error;
}

test('deleting your account stops your card subscription first -- through the real payment service', async () => {
  const cancelled = [];
  h.setStripe({
    subscriptions: {
      cancel: async (id) => {
        cancelled.push(id);
        return { id, status: 'canceled' };
      }
    }
  });
  try {
    await h.inGym(gym, async () => {
      const subscriber = await member('Leaving');
      const live = await order(subscriber, { number: 'DEL-0', endDate: new Date(Date.now() + 20 * 86400000), stripe: { id: 'sub_leaving' } });

      const res = await h.call(users.deleteUser, { headers: { authorization: token(subscriber) } });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepEqual(cancelled, ['sub_leaving']);
      assert.equal(await User.exists({ _id: subscriber._id }), null);

      const after = await PackageOrder.findById(live._id).lean();
      assert.equal(after.status, 'cancelled');
      assert.equal(after.subscription.stripeStatus, 'canceled');
      assert.equal(after.cancellation.source, 'member');
      assert.equal(String(after.cancellation.by), String(subscriber._id));
    });
  } finally {
    h.setStripe(null);
  }
});

test('deleting your account is refused, and nothing is deleted, when the subscription cannot be stopped', async () => {
  await h.inGym(gym, async () => {
    const subscriber = await member('Stuck');
    await order(subscriber, { number: 'DEL-1', endDate: new Date(Date.now() + 20 * 86400000), stripe: { id: 'sub_stuck' } });

    const asked = [];
    let res = await withCancelHelper(
      async (id, options) => {
        asked.push({ id: String(id), source: options.source, by: String(options.by) });
        throw stripeCancelFailed('DEL-1');
      },
      () => h.call(users.deleteUser, { headers: { authorization: token(subscriber) } })
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'SUBSCRIPTION_ACTIVE');
    assert.doesNotMatch(res.body.message, /Stripe dashboard/, 'a member is not sent to the gym\'s Stripe account');
    assert.deepEqual(asked, [{ id: String(subscriber._id), source: 'member', by: String(subscriber._id) }]);
    assert.ok(await User.exists({ _id: subscriber._id }));

    // Any other failure: refused all the same.
    res = await withCancelHelper(
      async () => {
        throw new Error('connection reset');
      },
      () => h.call(users.deleteUser, { headers: { authorization: token(subscriber) } })
    );
    assert.equal(res.statusCode, 409);
    assert.ok(await User.exists({ _id: subscriber._id }));
  });
});

test('without the cancel helper, an account still being billed is refused; one that is not goes', async () => {
  await h.inGym(gym, async () => {
    const billed = await member('Billed');
    await order(billed, { number: 'DEL-2', endDate: new Date(Date.now() + 20 * 86400000), stripe: { id: 'sub_billed' } });
    const stopping = await member('Stopped');
    await order(stopping, { number: 'DEL-3', endDate: new Date(Date.now() + 20 * 86400000), stripe: { id: 'sub_stopped', cancelAtPeriodEnd: true, autoRenew: false } });
    const cashOnly = await member('Cashonly');
    await order(cashOnly, { number: 'DEL-4', endDate: new Date(Date.now() + 20 * 86400000) });

    await withCancelHelper(undefined, async () => {
      const refused = await h.call(users.deleteUser, { headers: { authorization: token(billed) } });
      assert.equal(refused.statusCode, 409);
      assert.ok(await User.exists({ _id: billed._id }));

      for (const person of [stopping, cashOnly]) {
        const res = await h.call(users.deleteUser, { headers: { authorization: token(person) } });
        assert.equal(res.statusCode, 200, `${person.firstName}: ${JSON.stringify(res.body)}`);
        assert.equal(await User.exists({ _id: person._id }), null);
      }
    });
  });
});

test('an admin deleting a member goes through the same check', async () => {
  await h.inGym(gym, async () => {
    const admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@reminders.test', role: 'admin' });
    const target = await member('Target');
    await order(target, { number: 'DEL-5', endDate: new Date(Date.now() + 20 * 86400000), stripe: { id: 'sub_target' } });
    const req = { params: { id: String(target._id) }, headers: { authorization: token(admin) }, roleSlug: 'admin' };

    // Staff are told what the payment service said: which order, and what to do.
    let res = await withCancelHelper(
      async () => {
        throw stripeCancelFailed('DEL-5');
      },
      () => h.call(users.deleteUserById, req)
    );
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /DEL-5.*Stripe dashboard/);
    assert.ok(await User.exists({ _id: target._id }));

    // Without that detail, the generic staff wording.
    res = await withCancelHelper(
      async () => {
        throw new Error('connection reset');
      },
      () => h.call(users.deleteUserById, req)
    );
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /Package Orders/);

    const asked = [];
    res = await withCancelHelper(
      async (id, options) => {
        asked.push({ id: String(id), source: options.source, by: String(options.by) });
        return { cancelled: ['DEL-5'] };
      },
      () => h.call(users.deleteUserById, req)
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(asked, [{ id: String(target._id), source: 'staff', by: String(admin._id) }]);
    assert.equal(await User.exists({ _id: target._id }), null);
  });
});
