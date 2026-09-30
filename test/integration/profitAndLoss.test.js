// The Accounts overview's profit and loss against a real MongoDB, with orders
// seeded in the shape the membership money contract gives them (payment
// joining/trainer fees, instalments, trainerAssignment with the commission
// worked out), shop sales, PT sessions, expenses, assets bought with and
// without an expense, and a payslip paid through the HR screen.
//
// September 2026, GBP, UTC:
//
//   O1  paid 5 Sep 150 (joining 20, trainer fee 30), trainer commission 15
//   O3  paid 12 Sep 80, refunded in full 20 Sep
//   shop sale 15 Sep 25
//   PT  completed 8 Sep (commission 40) and 9 Sep (60, paid at the desk)
//   rent 1000 paid; electricity 200 unpaid
//   rower 2 x 500 bought 3 Sep, filed as an expense too; mats 300 bought 20 Sep
//   payslip paid 25 Sep: net 2500 of which 100 PT commission
//
//   revenue  230 + 25 - 80                      = 175
//   outflow  commission 115, expenses 1000, assets 1300, salaries 2400 = 4815
//   net                                          = -4640
//
// The membership / admission / trainer-fee split of O1 is the membership
// pipeline's; here only its sum is asserted, which holds with or without it
// (the split itself: test/unit/profitAndLoss.test.js).

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let accrualGym;
let PackageOrder;
let PtSession;
let Payslip;
let Expense;
let Asset;
let Sale;
let User;
let accounts;
let expenses;
let assets;
let hr;

const at = (iso) => new Date(iso);

function order(n, { paidAt, amount, status = 'paid', refund, payment = {}, trainerAssignment, installments }) {
  const { Types } = h.state.mongoose;
  const doc = {
    _id: new Types.ObjectId(),
    orderNumber: `PL-${n}`,
    userId: null,
    packageId: new Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: String(amount), currency: 'gbp', period: 'month', features: [], kind: 'membership', durationDays: 30, sessions: 0, joiningFee: payment.joiningFee || 0, billing: { mode: 'one_time', interval: 'month', intervalCount: 1, trialDays: 0 } },
    customerInfo: { fullName: `Customer ${n}`, email: `c${n}@pnl.test`, phone: '', country: '' },
    payment: { method: 'cash', amount, currency: 'gbp', status, paidAt, lastPaidAt: null, ...payment },
    subscription: { startDate: paidAt, endDate: paidAt ? new Date(paidAt.getTime() + 30 * 86400000) : null, isActive: status === 'paid', renewals: [] },
    status: status === 'paid' ? 'active' : status === 'refunded' ? 'cancelled' : 'pending',
    createdAt: paidAt || at('2026-09-01T00:00:00Z'),
    updatedAt: paidAt || at('2026-09-01T00:00:00Z')
  };
  if (installments) doc.payment.installments = installments;
  if (trainerAssignment) doc.trainerAssignment = trainerAssignment;
  doc.refund = refund || { amount: null, reason: '', at: null, byUserId: null, stripeRefundId: null };
  return doc;
}

const assignment = (commissionAmount) => {
  const { Types } = h.state.mongoose;
  return { trainerId: new Types.ObjectId(), trainerName: 'Tara Trainer', fee: 30, commissionType: 'percent', commissionValue: 50, commissionAmount };
};

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  PtSession = h.src('gymfolio/models/ptSessionModel');
  Payslip = h.src('models/payslipModel');
  Expense = h.src('accounts/models/expenseModel');
  Asset = h.src('accounts/models/assetModel');
  Sale = h.src('models/saleModel');
  User = h.src('models/user');
  accounts = h.src('accounts/controller/accountsController');
  expenses = h.src('accounts/controller/expenseController');
  assets = h.src('accounts/controller/assetController');
  hr = h.src('controller/hrController');

  gym = await h.createGym('pnl-gym', { timezone: 'UTC', currency: 'GBP' });
  accrualGym = await h.createGym('pnl-accrual-gym', { timezone: 'UTC', currency: 'GBP' });

  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder, PtSession, Payslip, Expense, Asset);
    const { Types } = h.state.mongoose;
    const admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@pnl.test', role: 'admin' });
    const staff = await User.create({
      firstName: 'Tara',
      lastName: 'Trainer',
      email: 'tara@pnl.test',
      role: 'trainer',
      employment: { isStaff: true, payroll: { basis: 'salaried', salary: 2400, currency: 'GBP', cycle: 'monthly' } }
    });
    const user = { id: String(admin._id), firstName: 'Ada', lastName: 'Admin' };

    await PackageOrder.collection.insertMany([
      order(1, { paidAt: at('2026-09-05T10:00:00Z'), amount: 150, payment: { joiningFee: 20, trainerFee: 30, amountPaid: 150, balanceDue: 0 }, trainerAssignment: assignment(15) }),
      order(3, {
        paidAt: at('2026-09-12T10:00:00Z'),
        amount: 80,
        status: 'refunded',
        refund: { amount: 80, reason: 'moved away', at: at('2026-09-20T10:00:00Z'), byUserId: null, stripeRefundId: null }
      }),
      // August: nothing of it is September's.
      order(4, { paidAt: at('2026-08-20T10:00:00Z'), amount: 70, trainerAssignment: assignment(9) })
    ]);

    await Sale.collection.insertOne({ number: 'S-1', items: [], total: 25, currency: 'GBP', status: 'paid', paymentMethod: 'cash', paidAt: at('2026-09-15T10:00:00Z') });

    const member = new Types.ObjectId();
    const trainerId = new Types.ObjectId();
    await PtSession.collection.insertMany([
      { trainerId, trainerName: 'Tara', memberId: member, date: '2026-09-08', startTime: '09:00', status: 'completed', price: 400, currency: 'GBP', commission: { basis: 'percent', percent: 10, amount: 40 } },
      { trainerId, trainerName: 'Tara', memberId: member, date: '2026-09-09', startTime: '09:00', status: 'completed', price: 0, currency: '', commission: { basis: 'amount', percent: 0, amount: 60 } },
      { trainerId, trainerName: 'Tara', memberId: member, date: '2026-09-10', startTime: '09:00', status: 'cancelled', price: 400, currency: 'GBP', commission: { basis: 'percent', percent: 0, amount: 0 } }
    ]);

    await h.call(expenses.create, { user, body: { title: 'Rent', category: 'rent', amount: 1000, incurredOn: '2026-09-01', status: 'paid' } });
    await h.call(expenses.create, { user, body: { title: 'Electricity', category: 'utilities', amount: 200, incurredOn: '2026-09-02', status: 'pending' } });

    const rower = await h.call(assets.create, { user, body: { name: 'Rower', category: 'cardio', quantity: '2', unitCost: '500', purchasedOn: '2026-09-03', recordExpense: true } });
    assert.equal(rower.statusCode, 201, JSON.stringify(rower.body));
    await h.call(assets.create, { user, body: { name: 'Mats', category: 'functional', unitCost: '300', purchasedOn: '2026-09-20', recordExpense: false } });
    await h.call(assets.create, { user, body: { name: 'Old bike', category: 'cardio', unitCost: '900', purchasedOn: '2026-08-10', recordExpense: true } });

    const slip = await Payslip.create({
      number: 'PAY-2026-0001',
      staffId: staff._id,
      staffName: 'Tara Trainer',
      period: { from: '2026-09-01', to: '2026-09-30', label: 'Sep 2026' },
      currency: 'GBP',
      base: 2400,
      ptSessions: 2,
      ptCommission: 100,
      status: 'issued'
    });
    slip.recalculate();
    await slip.save();
    const paid = await h.call(hr.setPayslipStatus, { params: { id: String(slip._id), action: 'pay' }, body: { paidOn: '2026-09-25T12:00:00Z' }, user, roleSlug: 'admin' });
    assert.equal(paid.statusCode, 200, JSON.stringify(paid.body));
  });

  // Commission accrual only: an order paid in instalments across two months,
  // one paid at once, and one that never was.
  await h.inGym(accrualGym, async () => {
    await h.ensureIndexes(PackageOrder);
    await PackageOrder.collection.insertMany([
      order(10, {
        paidAt: at('2026-09-10T10:00:00Z'),
        amount: 100,
        payment: { amountPaid: 100, balanceDue: 0 },
        installments: [
          { amount: 50, joiningFee: 0, trainerFee: 0, method: 'jazzcash', at: at('2026-08-28T10:00:00Z'), by: null, note: '' },
          { amount: 50, joiningFee: 0, trainerFee: 0, method: 'cash', at: at('2026-09-10T10:00:00Z'), by: null, note: '' }
        ],
        trainerAssignment: assignment(12)
      }),
      order(11, { paidAt: at('2026-09-02T10:00:00Z'), amount: 60, trainerAssignment: assignment(7) }),
      order(12, { paidAt: null, amount: 60, status: 'pending', trainerAssignment: assignment(9) })
    ]);
  });
});

const september = { from: '2026-09-01', to: '2026-09-30' };
const line = (lines, key) => lines.find((entry) => entry.key === key);

test('revenue lines: memberships (with their admission and trainer fees), the shop, less refunds', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(accounts.overview, { query: september });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const p = res.body.profit_and_loss;
    const memberships = ['membership', 'admission', 'trainer_fees'].reduce((sum, key) => sum + line(p.revenue, key).base_amount, 0);
    assert.equal(memberships, 230);
    assert.equal(line(p.revenue, 'shop').base_amount, 25);
    assert.equal(line(p.revenue, 'refunds').base_amount, 80);
    assert.equal(p.total_revenue, 175);
    // The shop figure the overview used to work out and drop.
    assert.equal(res.body.income.shop.base_amount, 25);
  });
});

test('outflow lines count every cost once: the payslip not its expense, the asset not its expense, PT commission not twice', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(accounts.overview, { query: september });
    const p = res.body.profit_and_loss;

    const commission = line(p.outflow, 'trainer_commission');
    assert.equal(commission.memberships.base_amount, 15, "O1's, accrued on its first payment");
    assert.equal(commission.personal_training.base_amount, 100);
    assert.equal(commission.base_amount, 115);

    assert.equal(line(p.outflow, 'expenses').base_amount, 1000, 'rent only: not the unpaid bill, the salary expense or the rower expense');
    assert.deepEqual(p.set_aside, { payslip_expenses: 1, asset_purchase_expenses: 1 });
    assert.equal(line(p.outflow, 'asset_purchases').base_amount, 1300);
    assert.equal(line(p.outflow, 'salaries').base_amount, 2400, 'the payslip less its PT commission');

    assert.equal(p.total_outflow, 4815);
    assert.equal(p.net_profit, -4640);
    assert.equal(p.mixed_currencies, false);

    // The headline figures are the profit and loss's.
    assert.deepEqual(
      { gross: res.body.result.gross_income, out: res.body.result.expenses, net: res.body.result.net },
      { gross: 175, out: 4815, net: -4640 }
    );
    // And so is the trend, day by day.
    const points = res.body.trend.points;
    const sum = (field) => Math.round(points.reduce((total, point) => total + point[field], 0) * 100) / 100;
    assert.equal(sum('revenue'), 175);
    assert.equal(sum('expense'), 4815);
    assert.equal(sum('net'), -4640);
    const day = (key) => points.find((point) => point.key === key);
    assert.equal(day('2026-09-03').expense, 1000, 'the rower on the day it was bought, once');
    assert.equal(day('2026-09-09').expense, 60, 'PT commission on the session day');
    assert.equal(day('2026-09-25').expense, 2400);
  });
});

test('the month the rower was not bought in has no asset purchase, and August has its own', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(accounts.overview, { query: { from: '2026-08-01', to: '2026-08-31' } });
    const p = res.body.profit_and_loss;
    assert.equal(line(p.outflow, 'asset_purchases').base_amount, 900);
    assert.equal(line(p.outflow, 'expenses').base_amount, 0, 'the old bike once, as an asset');
    assert.equal(line(p.outflow, 'trainer_commission').memberships.base_amount, 9);
  });
});

test('membership commission accrues on the first payment: the first instalment when there are several', async () => {
  await h.inGym(accrualGym, async () => {
    const aug = await h.call(accounts.overview, { query: { from: '2026-08-01', to: '2026-08-31' } });
    assert.equal(line(aug.body.profit_and_loss.outflow, 'trainer_commission').memberships.base_amount, 12);
    const sep = await h.call(accounts.overview, { query: september });
    assert.equal(line(sep.body.profit_and_loss.outflow, 'trainer_commission').memberships.base_amount, 7, 'not the instalment order again, not the unpaid one');
  });
});

test('a single day is a period of its own', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(accounts.overview, { query: { from: '2026-09-25', to: '2026-09-25' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.range.label, h.src('attendance/services/timeUtils').dateLabelForKey('2026-09-25'));
    assert.equal(res.body.profit_and_loss.total_outflow, 2400);
    assert.equal(res.body.trend.points.length, 1);
  });
});
