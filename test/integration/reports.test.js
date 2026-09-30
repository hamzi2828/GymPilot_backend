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
//
//   members   two joined 3 Aug, one 20 Aug (23:30), one in July; a staff
//             account joined 3 Aug and is not a member

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
  const User = h.src('models/user');

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

    const person = (email, createdAt, role = 'user') => ({ firstName: email.split('@')[0], lastName: 'Test', email, role, isActive: true, createdAt: at(createdAt), updatedAt: at(createdAt) });
    await User.collection.insertMany([
      person('ann@reports.test', '2026-08-03T10:00:00Z'),
      person('ben@reports.test', '2026-08-03T15:00:00Z'),
      person('cat@reports.test', '2026-08-20T23:30:00Z'),
      person('dan@reports.test', '2026-07-15T10:00:00Z'),
      person('desk@reports.test', '2026-08-03T11:00:00Z', 'admin')
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

test('reports net follows every Accounts outflow line: an asset bought in the range comes off both', async () => {
  await h.inGym(gym, async () => {
    const Asset = h.src('accounts/models/assetModel');
    const bike = await Asset.create({ tag: 'AST-9001', name: 'Spin bike', quantity: 2, unitCost: 15, currency: 'GBP', purchasedOn: at('2026-08-10T12:00:00Z') });
    try {
      const [report, overview] = await Promise.all([
        h.call(reports.overview, { query: AUGUST }),
        h.call(accounts.overview, { query: AUGUST })
      ]);
      assert.equal(report.statusCode, 200, JSON.stringify(report.body));
      assert.equal(report.body.kpis.expenses, 55, 'the expenses figure is still the paid expenses');
      assert.equal(report.body.kpis.outflow, 85, 'expenses 55 + asset purchases 30');
      assert.equal(report.body.kpis.net, 57);
      assert.equal(overview.body.result.net, report.body.kpis.net, 'the two screens still agree');
    } finally {
      await Asset.deleteOne({ _id: bike._id });
    }
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

test('registrations: members who joined, per local day, beside the chart', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(reports.overview, { query: AUGUST });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.registrations, {
      total: 3,
      days: [
        { date: '2026-08-03', label: '03 Aug 2026', count: 2 },
        { date: '2026-08-20', label: '20 Aug 2026', count: 1 }
      ]
    });
    assert.equal(res.body.kpis.new_members, 3);
    const charted = Object.fromEntries(res.body.series.new_members.filter((b) => b.value).map((b) => [b.key, b.value]));
    assert.deepEqual(charted, { '2026-08-03': 2, '2026-08-20': 1 });

    // Over a long range the chart is by month and the table still by day.
    const year = await h.call(reports.overview, { query: { from: '2026-01-01', to: '2026-12-31' } });
    assert.equal(year.body.range.grain, 'month');
    const months = Object.fromEntries(year.body.series.new_members.filter((b) => b.value).map((b) => [b.key, b.value]));
    assert.deepEqual(months, { '2026-07': 1, '2026-08': 3 });
    assert.deepEqual(year.body.registrations.days.map((d) => d.date), ['2026-07-15', '2026-08-03', '2026-08-20']);
  });
});

function csvRows(res) {
  return String(res.body).replace(/^﻿/, '').trim().split('\r\n').map((line) => line.split(','));
}

test("expenses export names the gym's own heads, not their stored keys", async () => {
  await h.inGym(gym, async () => {
    const categories = h.src('accounts/services/categories');
    const Expense = h.src('accounts/models/expenseModel');
    const head = await categories.createHead('expense', 'Tea for members');
    const tea = await Expense.create({ reference: 'EXP-TEA-1', title: 'Tea', category: head.key, amount: 3, currency: 'GBP', status: 'paid', incurredOn: at('2026-08-12T10:00:00Z'), paidOn: at('2026-08-12T10:00:00Z') });
    try {
      const res = await h.call(reports.export, { params: { kind: 'expenses' }, query: AUGUST });
      assert.equal(res.statusCode, 200);
      const rows = csvRows(res);
      const title = rows[0].indexOf('Title');
      const category = rows[0].indexOf('Category');
      const row = rows.find((r) => r[title] === 'Tea');
      assert.ok(row, 'the expense is exported');
      assert.equal(row[category], 'Tea for members');
    } finally {
      await Expense.deleteOne({ _id: tea._id });
      await head.deleteOne();
    }
  });
});

test('members export: those who joined in the range, or everyone with all=1', async () => {
  await h.inGym(gym, async () => {
    const joined = await h.call(reports.export, { params: { kind: 'members' }, query: AUGUST });
    assert.equal(joined.statusCode, 200);
    assert.match(joined.headers['content-disposition'], /members_joined_2026-08-01_2026-08-31\.csv/);
    const rows = csvRows(joined);
    const email = rows[0].indexOf('Email');
    assert.deepEqual(rows.slice(1).map((r) => r[email]).sort(), ['ann@reports.test', 'ben@reports.test', 'cat@reports.test']);

    const everyone = await h.call(reports.export, { params: { kind: 'members' }, query: { ...AUGUST, all: '1' } });
    assert.match(everyone.headers['content-disposition'], /members_\d{4}-\d{2}-\d{2}\.csv/);
    assert.deepEqual(csvRows(everyone).slice(1).map((r) => r[email]).sort(), ['ann@reports.test', 'ben@reports.test', 'cat@reports.test', 'dan@reports.test']);
  });
});

test('every export also comes as a real .xlsx: the CSV\'s rows, amounts as numbers, dates as dates', async () => {
  const { unzip, readSheet, sheetNames, sheetObjects } = require('../helpers/readXlsx');
  const { dateSerial } = h.src('services/xlsx');
  const kinds = ['members', 'orders', 'attendance', 'bookings', 'leads', 'pt-sessions', 'expenses', 'payslips'];

  await h.inGym(gym, async () => {
    for (const kind of kinds) {
      const [csv, book] = await Promise.all([
        h.call(reports.export, { params: { kind }, query: AUGUST }),
        h.call(reports.export, { params: { kind }, query: { ...AUGUST, format: 'xlsx' } })
      ]);
      assert.equal(book.statusCode, 200, `${kind}: ${JSON.stringify(book.body)}`);
      assert.equal(book.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.match(book.headers['content-disposition'], /\.xlsx"$/);
      assert.equal(book.headers['content-disposition'].replace('.xlsx', '.csv'), csv.headers['content-disposition'], `${kind}: same file name`);

      const files = unzip(book.body);
      const sheet = readSheet(files);
      const csvLines = csvRows(csv);
      assert.deepEqual(sheet[0].map((c) => c.value), csvLines[0], `${kind}: same columns, same order`);
      assert.ok(sheet[0].every((c) => c.style === 1), `${kind}: header row is bold`);
      assert.equal(sheet.length, csvLines.length, `${kind}: same number of rows`);
      assert.equal(sheetNames(files).length, 1);
    }

    // The same export by its old name, with the ending instead of ?format.
    const suffixed = await h.call(reports.export, { params: { kind: 'orders.xlsx' }, query: AUGUST });
    assert.equal(suffixed.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const orders = sheetObjects(unzip((await h.call(reports.export, { params: { kind: 'orders' }, query: { ...AUGUST, format: 'xlsx' } })).body));
    const r1 = orders.find((row) => row.Order === 'R-1');
    assert.equal(r1.Amount, 100, 'an amount is a number cell');
    assert.equal(r1['Paid on'], dateSerial('2026-08-03'), 'a date is a date cell');

    const expenses = sheetObjects(unzip((await h.call(reports.export, { params: { kind: 'expenses' }, query: { ...AUGUST, format: 'xlsx' } })).body));
    assert.deepEqual(expenses.map((row) => row.Amount).sort((a, b) => a - b), [5, 50, 60, 80, 1000]);
    assert.equal(expenses.find((row) => row.Reference === 'E-1').Date, dateSerial('2026-08-02'));

    const members = sheetObjects(unzip((await h.call(reports.export, { params: { kind: 'members' }, query: { ...AUGUST, format: 'xlsx' } })).body));
    assert.deepEqual(members.map((row) => row.Joined).sort(), [dateSerial('2026-08-03'), dateSerial('2026-08-03'), dateSerial('2026-08-20')]);
  });
});

test('daily sales: each day\'s money by heading, adding up to the accounts screen\'s income', async () => {
  await h.inGym(gym, async () => {
    const [res, overview] = await Promise.all([
      h.call(reports.dailySales, { query: AUGUST }),
      h.call(accounts.overview, { query: AUGUST })
    ]);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const r = res.body;
    assert.equal(r.base_currency, 'GBP');
    assert.equal(r.days.length, 31, 'every day of August, quiet ones included');
    const day = (date) => r.days.find((d) => d.date === date);
    assert.equal(day('2026-08-03').new_signups, 100);
    assert.equal(day('2026-08-04').pos, 42, 'the no-currency sale is the gym\'s; the refunded one is not takings');
    assert.equal(day('2026-08-05').new_signups, 40);
    assert.equal(day('2026-08-06').refunds, -40);
    assert.equal(day('2026-08-06').total, -40);
    assert.equal(r.totals.total, 142);
    assert.equal(r.totals.total, overview.body.result.gross_income, 'the same income as the accounts screen');
    assert.deepEqual(r.by_method, [{ method: 'cash', label: 'Cash', amount: 142 }]);
    assert.deepEqual(r.other_currency, { count: 2, currencies: ['PKR'] });
  });
});

test('daily sales read the admission / trainer fee split and the payment\'s own method from the ledger rows', async () => {
  const L = h.src('accounts/services/ledger');
  const original = L.membershipPaymentStages;
  // The ledger's rows as the membership work shapes them: R-1's 100 was 20
  // admission and 10 trainer fee -- so 70 membership, the pipeline's own
  // amount - admission - trainerFee -- paid by JazzCash; R-2 was an instalment
  // of dues.
  L.membershipPaymentStages = (...args) => [
    ...original(...args),
    {
      $addFields: {
        admission: { $cond: [{ $eq: ['$orderNumber', 'R-1'] }, 20, '$admission'] },
        trainerFee: { $cond: [{ $eq: ['$orderNumber', 'R-1'] }, 10, '$trainerFee'] },
        method: { $cond: [{ $eq: ['$orderNumber', 'R-1'] }, 'jazzcash', '$method'] },
        kind: { $cond: [{ $eq: ['$orderNumber', 'R-2'] }, 'installment', '$kind'] }
      }
    },
    { $addFields: { membership: { $subtract: ['$amount', { $add: [{ $ifNull: ['$admission', 0] }, { $ifNull: ['$trainerFee', 0] }] }] } } }
  ];
  try {
    await h.inGym(gym, async () => {
      const res = await h.call(reports.dailySales, { query: AUGUST });
      const day = (date) => res.body.days.find((d) => d.date === date);
      assert.deepEqual(
        { new_signups: day('2026-08-03').new_signups, admission: day('2026-08-03').admission, trainer_fees: day('2026-08-03').trainer_fees, total: day('2026-08-03').total },
        { new_signups: 70, admission: 20, trainer_fees: 10, total: 100 }
      );
      assert.equal(day('2026-08-05').dues, 40);
      assert.equal(day('2026-08-05').new_signups, 0);
      assert.equal(res.body.totals.total, 142, 'a different split, the same money');
      assert.deepEqual(res.body.by_method.map((m) => [m.label, m.amount]), [['JazzCash', 100], ['Cash', 42]]);
    });
  } finally {
    L.membershipPaymentStages = original;
  }
});

test('daily sales export: CSV with a totals row; a workbook with the days and a payment-method sheet', async () => {
  const { unzip, readSheet, sheetNames, sheetObjects } = require('../helpers/readXlsx');
  const { dateSerial } = h.src('services/xlsx');
  await h.inGym(gym, async () => {
    const csv = await h.call(reports.export, { params: { kind: 'daily-sales' }, query: AUGUST });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers['content-disposition'], /daily_sales_2026-08-01_2026-08-31\.csv/);
    const lines = csvRows(csv);
    assert.deepEqual(lines[0], ['Date', 'New sign-ups', 'Renewals', 'Admission fees', 'Trainer fees', 'Dues collected', 'Membership refunds', 'POS sales', 'Total (GBP)', 'Cash', 'Membership payments', 'Till sales']);
    assert.equal(lines.length, 1 + 31 + 1);
    assert.deepEqual(lines[lines.length - 1].slice(0, 9), ['Total', '140', '0', '0', '0', '0', '-40', '42', '142']);

    const book = await h.call(reports.export, { params: { kind: 'daily-sales' }, query: { ...AUGUST, format: 'xlsx' } });
    const files = unzip(book.body);
    assert.deepEqual(sheetNames(files), ['Daily sales', 'By payment method']);
    const days = readSheet(files, 1);
    assert.equal(days.length, 1 + 31 + 1);
    assert.equal(days[1][0].value, dateSerial('2026-08-01'), 'dates are dates');
    const totals = days[days.length - 1];
    assert.ok(totals.every((c) => c.style === 1), 'the totals row is bold');
    assert.deepEqual(totals.slice(0, 9).map((c) => c.value), ['Total', 140, 0, 0, 0, 0, -40, 42, 142]);
    assert.deepEqual(sheetObjects(files, 2), [{ 'Payment method': 'Cash', 'Amount (GBP)': 142 }, { 'Payment method': 'Total', 'Amount (GBP)': 142 }]);
  });
});

test("top products: a product's margin is the till's profit on it -- its takings less the tax in them and any discount, less its cost", async () => {
  const pos = h.src('controller/posController');
  const Sale = h.src('models/saleModel');
  const Settings = h.src('models/settings');
  const MAY = { from: '2026-05-01', to: '2026-05-31' };
  const till = (req) => ({ user: { id: null }, roleSlug: 'admin', ...req });

  await h.inGym(gym, async () => {
    const make = async (body) => {
      const res = await h.call(pos.createProduct, till({ body }));
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      return res.body.data;
    };
    const tub = await make({ name: 'Protein tub', price: 30, cost: 18, stock: 20 });
    const shaker = await make({ name: 'Shaker', price: 10, cost: 4, stock: 20 });

    // 70 in the basket, 5 off: 65 paid, 13 of it the 25% tax, goods 40 --
    // the till's profit 12. Then a shaker with no tax: profit 6.
    await Settings.updateOne({ isActive: true }, { $set: { taxRate: 25 } });
    let big;
    try {
      big = await h.call(pos.createSale, till({ body: { items: [{ productId: tub.id, quantity: 2 }, { productId: shaker.id, quantity: 1 }], discount: 5, paymentMethod: 'card' } }));
    } finally {
      await Settings.updateOne({ isActive: true }, { $set: { taxRate: 0 } });
    }
    const small = await h.call(pos.createSale, till({ body: { items: [{ productId: shaker.id, quantity: 1 }], paymentMethod: 'cash' } }));
    for (const [res, day] of [[big, '2026-05-10'], [small, '2026-05-11']]) {
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      await Sale.updateOne({ _id: res.body.data.id }, { $set: { paidAt: at(`${day}T10:00:00Z`) } });
    }

    const [report, sales] = await Promise.all([h.call(reports.overview, { query: MAY }), h.call(pos.listSales, till({ query: MAY }))]);
    assert.equal(report.statusCode, 200, JSON.stringify(report.body));
    assert.equal(sales.body.summary.gross_profit.GBP, 18);

    // The big sale's 65 - 13 = 52 is shared by its lines' totals: the tubs
    // 60/70 of it, less their 36; the shaker 10/70, less 4. The small sale's
    // shaker made 6.
    const product = (name) => report.body.top_products.find((row) => row.name === name);
    assert.deepEqual(product('Protein tub'), { name: 'Protein tub', quantity: 2, total: 60, margin: 8.57 });
    assert.deepEqual(product('Shaker'), { name: 'Shaker', quantity: 2, total: 20, margin: 9.43 });
    const margins = report.body.top_products.reduce((sum, row) => sum + row.margin, 0);
    assert.equal(Math.round(margins * 100) / 100, sales.body.summary.gross_profit.GBP, 'the products add up to the till');
  });
});
