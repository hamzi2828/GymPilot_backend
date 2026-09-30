// What the desk may set when it sells or renews a membership: a later start
// (a date, or so many days from today), a discount with its note, a
// different total, no joining fee, and a personal trainer with their fee
// and commission -- each checked, a bad one refused with a 400 naming it.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let PackageOrder;
let Package;
let User;
let Trainer;
let orders;
let lifecycle;
let T;
let monthly;
let coach;
let retired;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  Trainer = h.src('gymfolio/models/trainerModel');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  lifecycle = h.src('gymfolio/controller/membershipController');
  T = h.src('attendance/services/timeUtils');
  gym = await h.createGym('desk-gym', { timezone: 'Asia/Karachi', currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'], joiningFee: 2000 });
    coach = await Trainer.create({ name: 'Coach Kamran', role: 'Head coach', isActive: true });
    retired = await Trainer.create({ name: 'Old Coach', role: 'Coach', isActive: false });
  });
});

const staff = { id: 'staff', email: 'desk@desk.test' };
let seq = 0;
async function member() {
  seq += 1;
  return User.create({ firstName: 'Desk', lastName: `Member${seq}`, email: `desk${seq}@desk.test`, role: 'user' });
}
const assign = (who, body = {}) =>
  h.call(orders.assignPackageToUser, { body: { userId: String(who._id), packageId: String(monthly._id), ...body }, user: staff });
const renew = (order, body = {}) => h.call(lifecycle.renew, { params: { id: String(order._id) }, body, user: staff });

test('startAfterDays: registered today, the term starts that many days on and runs a month from there', async () => {
  await h.inGym(gym, async () => {
    const res = await assign(await member(), { startAfterDays: 3 });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const order = res.body.data;
    const expected = T.startOfLocalDay(T.shiftDateKey(T.dateKey(new Date()), 3));
    assert.equal(new Date(order.subscription.startDate).getTime(), expected.getTime());
    assert.equal(T.dateKey(new Date(order.subscription.startDate)), T.shiftDateKey(T.dateKey(new Date()), 3));
    // A calendar month after the start, not after today.
    const end = new Date(order.subscription.endDate);
    assert.ok(end.getTime() - expected.getTime() >= 28 * DAY && end.getTime() - expected.getTime() <= 31 * DAY);
    // Registered (and paid) today.
    assert.ok(Date.now() - new Date(order.payment.paidAt).getTime() < 60000);
  });
});

test('startDate: a bare date is the start of that day at the gym', async () => {
  await h.inGym(gym, async () => {
    const key = T.shiftDateKey(T.dateKey(new Date()), 10);
    const res = await assign(await member(), { startDate: key });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(new Date(res.body.data.subscription.startDate).getTime(), T.startOfLocalDay(key).getTime());
  });
});

test('a start that cannot be used is refused, naming the field', async () => {
  await h.inGym(gym, async () => {
    const who = await member();
    for (const [body, pattern] of [
      [{ startDate: '2026-10-01', startAfterDays: 2 }, /not both/],
      [{ startDate: 'next tuesday' }, /startDate is not a date/],
      [{ startDate: T.shiftDateKey(T.dateKey(new Date()), 400) }, /at most 365 days ahead/],
      [{ startAfterDays: -1 }, /startAfterDays/],
      [{ startAfterDays: 2.5 }, /startAfterDays/]
    ]) {
      const res = await assign(who, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_TERMS');
      assert.match(res.body.message, pattern);
    }
    assert.equal(await PackageOrder.countDocuments({ userId: who._id }), 0);
  });
});

test('a discount with its note, an override, and a waived joining fee', async () => {
  await h.inGym(gym, async () => {
    const discounted = await assign(await member(), { discountAmount: 1000, discountNote: 'Student' });
    assert.equal(discounted.body.data.payment.amount, 6000);
    assert.equal(discounted.body.data.payment.joiningFee, 2000);
    assert.equal(discounted.body.data.payment.discountAmount, 1000);
    assert.equal(discounted.body.data.payment.discountNote, 'Student');

    const overridden = await assign(await member(), { amountOverride: '4,500' });
    assert.equal(overridden.body.data.payment.amount, 4500);
    assert.equal(overridden.body.data.payment.joiningFee, 2000);

    // The old field name still works.
    const legacyName = await assign(await member(), { amount: 3000 });
    assert.equal(legacyName.body.data.payment.amount, 3000);

    const waived = await assign(await member(), { waiveJoiningFee: true });
    assert.equal(waived.body.data.payment.amount, 5000);
    assert.equal(waived.body.data.payment.joiningFee, 0);

    for (const bad of [{ discountAmount: -5 }, { amountOverride: 'lots' }]) {
      const res = await assign(await member(), bad);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
      assert.equal(res.body.code, 'INVALID_TERMS');
    }
  });
});

test('a trainer sold with the membership: fee on top, commission recorded, member assigned', async () => {
  await h.inGym(gym, async () => {
    const who = await member();
    const res = await assign(who, {
      trainerId: String(coach._id),
      trainerFee: 3000,
      trainerCommissionType: 'percent',
      trainerCommissionValue: 20,
      notes: 'Mornings only'
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const order = res.body.data;
    assert.equal(order.payment.amount, 10000);
    assert.equal(order.payment.joiningFee, 2000);
    assert.equal(order.payment.trainerFee, 3000);
    assert.equal(order.notes, 'Mornings only');
    // As the API sends it.
    assert.deepEqual(JSON.parse(JSON.stringify(order.trainerAssignment)), {
      trainerId: String(coach._id),
      trainerName: 'Coach Kamran',
      fee: 3000,
      commissionType: 'percent',
      commissionValue: 20,
      commissionAmount: 600
    });
    const fresh = await User.findById(who._id).select('assignedTrainerId').lean();
    assert.equal(String(fresh.assignedTrainerId), String(coach._id));

    const fixed = await assign(await member(), { trainerId: String(coach._id), trainerFee: 3000, trainerCommissionType: 'amount', trainerCommissionValue: 750 });
    assert.equal(fixed.body.data.trainerAssignment.commissionAmount, 750);

    // Sold without one: no assignment at all.
    const none = await assign(await member(), {});
    assert.equal(none.body.data.trainerAssignment, null);
    assert.equal(none.body.data.payment.trainerFee, 0);
  });
});

test('trainer terms that cannot be used are refused', async () => {
  await h.inGym(gym, async () => {
    const who = await member();
    const cases = [
      [{ trainerFee: 3000 }, 400, /Choose the trainer/],
      [{ trainerId: 'coach' }, 400, /trainerId/],
      [{ trainerId: String(coach._id), trainerCommissionType: 'bonus' }, 400, /percent' or 'amount/],
      [{ trainerId: String(coach._id), trainerCommissionValue: 120 }, 400, /over 100/],
      [{ trainerId: String(new h.state.mongoose.Types.ObjectId()) }, 404, /trainer was not found/],
      [{ trainerId: String(retired._id) }, 409, /not an active trainer/]
    ];
    for (const [body, status, pattern] of cases) {
      const res = await assign(who, body);
      assert.equal(res.statusCode, status, JSON.stringify(body));
      assert.match(res.body.message, pattern);
    }
    assert.equal(await PackageOrder.countDocuments({ userId: who._id }), 0);
  });
});

test('renewing at the desk: a start date, a discount, an override and a method', async () => {
  await h.inGym(gym, async () => {
    const who = await member();
    const first = (await assign(who, {})).body.data;

    const key = T.shiftDateKey(T.dateKey(new Date()), 60);
    const res = await renew(first, { startDate: key, discountAmount: 500, discountNote: 'Loyalty', paymentMethod: 'jazzcash' });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    const renewal = res.body.data;
    assert.equal(new Date(renewal.subscription.startDate).getTime(), T.startOfLocalDay(key).getTime());
    assert.equal(renewal.payment.amount, 4500);
    assert.equal(renewal.payment.joiningFee, 0);
    assert.equal(renewal.payment.discountNote, 'Loyalty');
    assert.equal(renewal.payment.method, 'jazzcash');

    const overridden = await renew(first, { amountOverride: 4000 });
    assert.equal(overridden.body.data.payment.amount, 4000);

    const withTrainer = await renew(first, { trainerId: String(coach._id) });
    assert.equal(withTrainer.statusCode, 400);
    assert.match(withTrainer.body.message, /not on a renewal/);
  });
});
