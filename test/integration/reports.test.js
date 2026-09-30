// The reports screen against a real MongoDB, checked against the accounts
// screen it must agree with.
//
// One gym in UTC, August 2026:
//
//   orders    R-1 paid 3 Aug 100 GBP
//             R-2 paid 5 Aug 40 GBP, refunded in full 6 Aug
//             R-3 paid 7 Aug 3000 PKR                       -> other currency
//   sales     30 GBP; 12 with no currency (the gym's own); 500 PKR; 20 GBP refunded
//   expenses  50 paid; 80 pending; 60 cancelled; 25 paid in August for a July
//             bill (incurred 30 Jul); 5 paid with no currency; 1000 PKR paid
//
//   revenue 100 + 40 - 40 + 30 + 12 = 142, paid expenses 50 + 5 = 55, net 87

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const test = h.suite(setup);

let gym;
let reports;
let accounts;

const at = (iso) => new Date(iso);
const AUGUST = { from: '2026-08-01', to: '2026-08-31' };

function order(n, { paidAt, amount, currency = 'gbp', status = 'paid', refund = null, method = 'cash', userId = null }) {
  const { Types } = h.state.mongoose;
  return {
    _id: new Types.ObjectId(),
    orderNumber: `R-${n}`,
    userId,
    packageId: new Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: String(amount), currency, period: 'month', features: [], kind: 'membership', durationDays: 0, sessions: 0, joiningFee: 0, billing: { mode: 'one_time', interval: 'month', intervalCount: 1, trialDays: 0 } },
    customerInfo: { fullName: `Customer ${n}`, email: `r${n}@reports.test`, phone: '', country: '' },
    payment: { method, amount, currency, status, paidAt, lastPaidAt: null },
    subscription: { startDate: paidAt, endDate: new Date(paidAt.getTime() + 30 * 86400000), isActive: status === 'paid', renewals: [] },
    status: status === 'refunded' ? 'cancelled' : 'active',
    refund: refund || { amount: null, reason: '', at: null, byUserId: null, stripeRefundId: null },
    createdAt: paidAt,
    updatedAt: paidAt
  };
}

async function setup() {
  reports = h.src('controller/reportsController');
  accounts = h.src('accounts/controller/accountsController');
  const PackageOrder = h.src('gymfolio/models/packageOrderModel');
  const Sale = h.src('models/saleModel');
  const Expense = h.src('accounts/models/expenseModel');

  gym = await h.createGym('reports-gym', { timezone: 'UTC', currency: 'GBP' });

  await h.inGym(gym, async () => {
    await PackageOrder.collection.insertMany([
      order(1, { paidAt: at('2026-08-03T10:00:00Z'), amount: 100 }),
      order(2, {
        paidAt: at('2026-08-05T10:00:00Z'),
        amount: 40,
        status: 'refunded',
        refund: { amount: 40, reason: 'changed mind', at: at('2026-08-06T10:00:00Z'), byUserId: null, stripeRefundId: null }
      }),
      order(3, { paidAt: at('2026-08-07T10:00:00Z'), amount: 3000, currency: 'pkr' })
    ]);

    const sale = (receiptNumber, total, currency, status = 'paid') => {
      const doc = { receiptNumber, items: [{ name: 'Water', quantity: 1, unitPrice: total, unitCost: 0, total }], total, paymentMethod: 'cash', status, paidAt: at('2026-08-04T12:00:00Z') };
      if (currency !== undefined) doc.currency = currency;
      return doc;
    };
    await Sale.collection.insertMany([
      sale('S-1', 30, 'GBP'),
      sale('S-2', 12, undefined),
      sale('S-3', 500, 'PKR'),
      sale('S-4', 20, 'GBP', 'refunded')
    ]);

    const expense = (reference, amount, status, incurredOn, { currency = 'GBP', paidOn } = {}) => {
      const doc = { reference, title: reference, category: 'other', amount, status, incurredOn: at(incurredOn), paidOn: paidOn ? at(paidOn) : null };
      if (currency !== undefined) doc.currency = currency;
      return doc;
    };
    await Expense.collection.insertMany([
      expense('E-1', 50, 'paid', '2026-08-02T09:00:00Z'),
      expense('E-2', 80, 'pending', '2026-08-02T09:00:00Z'),
      expense('E-3', 60, 'cancelled', '2026-08-02T09:00:00Z'),
      expense('E-4', 25, 'paid', '2026-07-30T09:00:00Z', { paidOn: '2026-08-02T09:00:00Z' }),
      expense('E-5', 5, 'paid', '2026-08-09T09:00:00Z', { currency: undefined }),
      expense('E-6', 1000, 'paid', '2026-08-09T09:00:00Z', { currency: 'PKR' })
    ]);
  });
}

test('reports net is the accounts net for the same range: paid expenses by the day they belong to', async () => {
  await h.inGym(gym, async () => {
    const [report, overview] = await Promise.all([
      h.call(reports.overview, { query: AUGUST }),
      h.call(accounts.overview, { query: AUGUST })
    ]);
    assert.equal(report.statusCode, 200, JSON.stringify(report.body));
    assert.equal(overview.statusCode, 200, JSON.stringify(overview.body));

    const k = report.body.kpis;
    assert.equal(k.revenue, 142, 'payments less refunds, plus the shop (a sale with no currency is the gym\'s)');
    assert.equal(k.expenses, 55, 'paid only; a July bill paid in August is July\'s');
    assert.equal(k.expenses_pending, 80, 'pending expenses are shown, not deducted');
    assert.equal(k.net, 87);

    assert.equal(overview.body.result.net, k.net, 'the two screens agree');
    assert.equal(overview.body.result.expenses, k.expenses);
    assert.equal(overview.body.result.gross_income, k.revenue);

    const charted = report.body.series.expenses.reduce((sum, point) => sum + point.value, 0);
    assert.equal(charted, 55, 'the expense line is the paid expenses the net deducts');
  });
});

test('reports leave other currencies out of the totals and count them, a blank currency is not one', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(reports.overview, { query: AUGUST });
    assert.deepEqual(res.body.other_currency, { count: 3, currencies: ['PKR'], orders: 1, expenses: 1, shop_sales: 1 });
    assert.equal(res.body.kpis.shop_revenue, 42);
    assert.equal(res.body.kpis.shop_sales, 2);
  });
});
