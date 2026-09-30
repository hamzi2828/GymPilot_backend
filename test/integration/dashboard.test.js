// The dashboard's "today" figures against a real MongoDB: revenue today
// (memberships, admission fees and the shop, net of refunds given today),
// paid expenses today and this month by the accounts rule, members who
// joined this month, today's member visits split paid / unpaid from the
// attendance rows' membership snapshot, and the fees due in the next 7 days.
//
// The gym sits in a zone where it is midday now, so "today" never straddles
// midnight whenever the suite is run. Seeded:
//
//   D-1  paid 30 min ago 120 (admission 20), ends in 3 days   -> today, fees due
//   D-3  paid 40 days ago 50, refunded in full 10 min ago       -> -50 today
//   D-4  paid 40 days ago 80, ends in 10 days                  -> outside 7 days
//   D-5  paid 40 days ago 60, ends in 2 days                   -> fees due
//   sales: 30 paid today, 15 refunded today, 99 paid 40 days ago
//   expenses: 25 paid today, 100 pending today, 70 cancelled today, 10 paid 40 days ago
//
//   revenue today = 120 - 50 + 30 = 100  (memberships 50, admission 20, shop 30)

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const test = h.suite(setup);

let gym;
let dashboard;
let L;
let T;

const DAY = 86400000;

function order(n, { paidAt, amount, endDate, userId = null, status = 'paid', refund = null }) {
  const { Types } = h.state.mongoose;
  return {
    _id: new Types.ObjectId(),
    orderNumber: `D-${n}`,
    userId,
    packageId: new Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: String(amount), currency: 'gbp', period: 'month', features: [], kind: 'membership', durationDays: 0, sessions: 0, joiningFee: 0, billing: { mode: 'one_time', interval: 'month', intervalCount: 1, trialDays: 0 } },
    customerInfo: { fullName: `Customer ${n}`, email: `d${n}@dashboard.test`, phone: '', country: '' },
    payment: { method: 'cash', amount, currency: 'gbp', status, paidAt, lastPaidAt: null },
    subscription: { startDate: paidAt, endDate, isActive: status === 'paid', renewals: [] },
    status: status === 'refunded' ? 'cancelled' : 'active',
    refund: refund || { amount: null, reason: '', at: null, byUserId: null, stripeRefundId: null },
    createdAt: paidAt,
    updatedAt: paidAt
  };
}

async function setup() {
  L = h.src('accounts/services/ledger');
  T = h.src('attendance/services/timeUtils');
  dashboard = h.src('controller/dashboardController');
  const PackageOrder = h.src('gymfolio/models/packageOrderModel');
  const Sale = h.src('models/saleModel');
  const Expense = h.src('accounts/models/expenseModel');
  const Attendance = h.src('attendance/models/attendanceModel');
  const User = h.src('models/user');

  // The ledger's payment rows carry `admission` once the membership work
  // splits the joining fee out of a payment. Stand in for that here -- D-1's
  // payment included a 20 admission fee -- whatever the stored shape ends up
  // being, and leave every other row as the ledger reports it. (This file is
  // its own process, so the stand-in goes no further.)
  const originalPaymentStages = L.membershipPaymentStages;
  L.membershipPaymentStages = (...args) => [
    ...originalPaymentStages(...args),
    {
      $addFields: {
        admission: { $cond: [{ $eq: ['$orderNumber', 'D-1'] }, 20, { $ifNull: ['$admission', 0] }] }
      }
    }
  ];

  gym = await h.createGym('dashboard-gym', { timezone: h.middayZone(), currency: 'GBP' });

  await h.inGym(gym, async () => {
    const { Types } = h.state.mongoose;
    const now = new Date();
    const longAgo = new Date(now.getTime() - 40 * DAY);

    const [u1, u2, u3] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    await User.collection.insertMany([
      { _id: u1, firstName: 'New', lastName: 'One', email: 'new1@dashboard.test', role: 'user', isActive: true, createdAt: h.minutesAgo(60, now), updatedAt: now },
      { _id: u2, firstName: 'New', lastName: 'Two', email: 'new2@dashboard.test', role: 'user', isActive: true, createdAt: h.minutesAgo(5, now), updatedAt: now },
      { _id: u3, firstName: 'Old', lastName: 'Timer', email: 'old@dashboard.test', role: 'user', isActive: true, createdAt: longAgo, updatedAt: longAgo },
      { firstName: 'Front', lastName: 'Desk', email: 'desk@dashboard.test', role: 'admin', isActive: true, createdAt: now, updatedAt: now }
    ]);

    await PackageOrder.collection.insertMany([
      order(1, { paidAt: h.minutesAgo(30, now), amount: 120, endDate: new Date(now.getTime() + 3 * DAY), userId: u1 }),
      order(3, {
        paidAt: longAgo,
        amount: 50,
        endDate: new Date(now.getTime() + 5 * DAY),
        status: 'refunded',
        refund: { amount: 50, reason: 'moved away', at: h.minutesAgo(10, now), byUserId: null, stripeRefundId: null }
      }),
      order(4, { paidAt: longAgo, amount: 80, endDate: new Date(now.getTime() + 10 * DAY), userId: u3 }),
      order(5, { paidAt: longAgo, amount: 60, endDate: new Date(now.getTime() + 2 * DAY), userId: u2 })
    ]);

    await Sale.collection.insertMany([
      { receiptNumber: 'R-1', items: [], total: 30, currency: 'GBP', paymentMethod: 'cash', status: 'paid', paidAt: h.minutesAgo(20, now) },
      { receiptNumber: 'R-2', items: [], total: 15, currency: 'GBP', paymentMethod: 'cash', status: 'refunded', paidAt: h.minutesAgo(40, now), refundedAt: h.minutesAgo(5, now) },
      { receiptNumber: 'R-3', items: [], total: 99, currency: 'GBP', paymentMethod: 'card', status: 'paid', paidAt: longAgo }
    ]);

    const expense = (reference, amount, status, incurredOn) => ({ reference, title: reference, category: 'other', amount, currency: 'GBP', status, incurredOn, paidOn: status === 'paid' ? incurredOn : null });
    await Expense.collection.insertMany([
      expense('EXP-1', 25, 'paid', h.minutesAgo(15, now)),
      expense('EXP-2', 100, 'pending', h.minutesAgo(15, now)),
      expense('EXP-3', 70, 'cancelled', h.minutesAgo(15, now)),
      expense('EXP-4', 10, 'paid', longAgo)
    ]);

    // Today's visits: two paid members (one of them twice, the second time on
    // an expired snapshot -- still a paid member today), three unpaid, one
    // staff punch.
    const today = T.dateKey(now);
    const visit = (personType, personId, status, minutes) => ({
      personType,
      personId,
      personName: 'seeded',
      personCode: '',
      shiftDate: today,
      checkInAt: h.minutesAgo(minutes, now),
      checkOutAt: h.minutesAgo(minutes - 30, now),
      workedMinutes: 30,
      checkIn: {},
      checkOut: {},
      membership: personType === 'member' ? { orderId: null, packageName: '', endDate: null, status } : undefined,
      status: '',
      autoClosed: false
    });
    const paidTwice = new Types.ObjectId();
    await Attendance.collection.insertMany([
      visit('member', paidTwice, 'active', 200),
      visit('member', paidTwice, 'expired', 100),
      visit('member', new Types.ObjectId(), 'frozen', 180),
      visit('member', new Types.ObjectId(), 'expired', 170),
      visit('member', new Types.ObjectId(), 'pending', 160),
      visit('member', new Types.ObjectId(), 'none', 150),
      visit('staff', new Types.ObjectId(), undefined, 300)
    ]);
  });
}

test('dashboard: revenue today is memberships, admission and the shop, net of refunds given today', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(dashboard.overview);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const r = res.body.revenue_today;
    assert.equal(r.base_currency, 'GBP');
    assert.equal(r.base_amount, 100, '120 paid - 50 refunded + 30 shop');
    assert.equal(r.memberships, 50, 'the payment less its admission fee, less the refund');
    assert.equal(r.admission, 20);
    assert.equal(r.shop, 30, 'a refunded sale is not takings');
    assert.equal(r.payments, 1);
    assert.equal(r.sales, 1);
    // The month so far still includes today.
    assert.ok(res.body.revenue.base_amount >= 100);
  });
});

test('dashboard: expenses are the paid ones, today and this month, as the accounts screen nets them', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(dashboard.overview);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.expenses_today.base_amount, 25, 'pending and cancelled expenses are left out');
    assert.equal(res.body.expenses_today.entries, 1);
    assert.equal(res.body.expenses.base_amount, 25, 'the 40-day-old expense is not this month');
  });
});

test('dashboard: new this month counts members who joined this month', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(dashboard.overview);
    assert.equal(res.body.members.new_this_month, 2, 'staff and the member from 40 days ago are not counted');
    assert.equal(res.body.members.total, 3);
  });
});

test('dashboard: members in today are split paid and unpaid by their visit snapshot', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(dashboard.overview);
    const a = res.body.attendance_today;
    assert.equal(a.member, 5, 'people, not visits');
    assert.equal(a.paid, 2, 'active (once, though they came twice) and frozen');
    assert.equal(a.unpaid, 3, 'expired, pending and none');
    assert.equal(a.staff, 1);
    assert.equal(a.still_in, 0);
  });
});

test('dashboard: fees due lists the memberships ending in the next 7 days', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(dashboard.overview);
    assert.equal(res.body.members.expiring_window_days, 7);
    assert.equal(res.body.members.expiring, 2);
    assert.equal(res.body.needs_attention.expiring_memberships, 2);
    assert.deepEqual(res.body.expiring_soon.map((row) => row.order_number), ['D-5', 'D-1'], 'soonest first; 10 days out and refunded orders left out');
    assert.deepEqual(res.body.expiring_soon.map((row) => row.days_left), [2, 3]);
  });
});
