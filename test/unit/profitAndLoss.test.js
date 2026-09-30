// The profit and loss behind the Accounts overview
// (accounts/services/profitAndLoss.js): the revenue and outflow lines, and
// that money recorded in two places -- a payslip and the salary expense it
// filed, a payslip's PT commission and the sessions that earned it, an asset
// and the purchase expense filed with it -- is counted once. No database:
// the rows are what the overview and gather() read.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const pnl = require('../../src/accounts/services/profitAndLoss');

const at = (iso) => new Date(iso);

// Membership payments as ledger.membershipPaymentStages returns them, with
// the split the membership pipeline adds (admission, trainerFee, membership)
// -- and one from before the split, which is all membership.
const payments = [
  { kind: 'initial', method: 'cash', at: at('2026-09-05T10:00:00Z'), amount: 150, currency: 'GBP', admission: 20, trainerFee: 30, membership: 100 },
  { kind: 'installment', method: 'jazzcash', at: at('2026-09-06T10:00:00Z'), amount: 60, currency: 'GBP', admission: 10, trainerFee: 0 },
  { kind: 'renewal', method: 'stripe', at: at('2026-09-07T10:00:00Z'), amount: 50, currency: 'GBP' },
  { kind: 'initial', method: 'cash', at: at('2026-09-08T10:00:00Z'), amount: 5000, currency: 'PKR', admission: 1000, trainerFee: 0, membership: 4000 }
];

const refunds = [{ at: at('2026-09-20T10:00:00Z'), amount: 40, currency: 'GBP' }];
const sales = [{ paidAt: at('2026-09-15T10:00:00Z'), total: 25, currency: 'GBP' }];

const expenses = [
  { _id: 'e-rent', status: 'paid', category: 'rent', amount: 1000, currency: 'GBP', incurredOn: at('2026-09-01T12:00:00Z') },
  { _id: 'e-unpaid', status: 'pending', category: 'utilities', amount: 200, currency: 'GBP', incurredOn: at('2026-09-02T12:00:00Z') },
  // Filed by a paid payslip: the payslip is counted instead.
  { _id: 'e-salary', status: 'paid', category: 'salaries', amount: 2500, currency: 'GBP', incurredOn: at('2026-09-25T12:00:00Z') },
  // Filed with an asset: the asset is counted instead.
  { _id: 'e-rower', status: 'paid', category: 'equipment', assetId: 'a-rower', amount: 1000, currency: 'GBP', incurredOn: at('2026-09-03T12:00:00Z') },
  // Linked to an asset but not its purchase (a repair): still an expense.
  { _id: 'e-repair', status: 'paid', category: 'maintenance', assetId: 'a-rower', amount: 70, currency: 'GBP', incurredOn: at('2026-09-04T12:00:00Z') },
  // An equipment expense whose asset has gone from the register: nothing else counts it.
  { _id: 'e-orphan', status: 'paid', category: 'equipment', assetId: 'a-gone', amount: 90, currency: 'GBP', incurredOn: at('2026-09-04T12:00:00Z') }
];

const extra = {
  membershipCommissions: [{ at: at('2026-09-05T10:00:00Z'), amount: 15, currency: 'GBP' }],
  ptCommissions: [
    { _id: { date: '2026-09-08', currency: 'GBP' }, amount: 40, sessions: 1 },
    // A session paid at the desk has no currency: the gym's.
    { _id: { date: '2026-09-09', currency: '' }, amount: 60, sessions: 1 }
  ],
  payslips: [{ net: 2500, ptCommission: 100, currency: 'GBP', paidOn: at('2026-09-25T12:00:00Z') }],
  payslipExpenseIds: new Set(['e-salary']),
  assetsBought: [
    { name: 'Rower', unitCost: 500, quantity: 2, currency: 'GBP', purchasedOn: at('2026-09-03T12:00:00Z') },
    { name: 'Mats', unitCost: 300, quantity: 1, currency: 'GBP', purchasedOn: at('2026-09-20T12:00:00Z') }
  ],
  purchaseAssetIds: new Set(['a-rower'])
};

const result = () => pnl.build({ base: 'GBP', payments, refunds, sales, expenses, extra });
const line = (lines, key) => lines.find((entry) => entry.key === key);

test('revenue: membership, admission and trainer fees from each payment; a payment before the split is all membership', () => {
  const r = result();
  assert.deepEqual(r.revenue.map((entry) => entry.key), ['membership', 'admission', 'trainer_fees', 'shop', 'refunds']);
  // 100 + (60 - 10) + 50
  assert.equal(line(r.revenue, 'membership').base_amount, 200);
  assert.equal(line(r.revenue, 'admission').base_amount, 30);
  assert.equal(line(r.revenue, 'trainer_fees').base_amount, 30);
  assert.equal(line(r.revenue, 'shop').base_amount, 25);
  assert.equal(line(r.revenue, 'refunds').base_amount, 40);
  assert.equal(line(r.revenue, 'refunds').deducted, true);
  // 200 + 30 + 30 + 25 - 40
  assert.equal(r.total_revenue, 245);
  // The PKR payment is listed on its lines, never added in.
  assert.deepEqual(line(r.revenue, 'membership').by_currency, [{ currency: 'GBP', amount: 200 }, { currency: 'PKR', amount: 4000 }]);
  assert.equal(r.mixed_currencies, true);
});

test('outflow: commission on memberships and PT, expenses paid, assets bought, salaries paid -- each once', () => {
  const r = result();
  assert.deepEqual(r.outflow.map((entry) => entry.key), ['trainer_commission', 'expenses', 'asset_purchases', 'salaries']);

  const commission = line(r.outflow, 'trainer_commission');
  assert.equal(commission.base_amount, 115);
  assert.equal(commission.memberships.base_amount, 15);
  assert.equal(commission.personal_training.base_amount, 100);

  // Rent, the repair and the orphaned equipment row; not the unpaid bill,
  // the payslip's salary expense or the asset's purchase expense.
  assert.equal(line(r.outflow, 'expenses').base_amount, 1160);
  assert.deepEqual(r.set_aside, { payslip_expenses: 1, asset_purchase_expenses: 1 });

  // 2 x 500 + 300: the rower once, on the day it was bought.
  assert.equal(line(r.outflow, 'asset_purchases').base_amount, 1300);

  // The payslip less the PT commission already under trainer commission.
  assert.equal(line(r.outflow, 'salaries').base_amount, 2400);

  assert.equal(r.total_outflow, 115 + 1160 + 1300 + 2400);
  assert.equal(r.net_profit, 245 - 4975);
  assert.equal(r.margin, Math.round(((245 - 4975) / 245) * 1000) / 10);
});

test('the dated items add up to the lines, in the base currency only', () => {
  const r = result();
  const sum = (items) => Math.round(items.reduce((total, item) => total + item.amount, 0) * 100) / 100;
  assert.equal(sum(r.items.revenue), r.total_revenue);
  assert.equal(sum(r.items.outflow), r.total_outflow);
  // PT commission is dated by the session's local day.
  assert.ok(r.items.outflow.some((item) => item.at === '2026-09-09' && item.amount === 60));
  assert.ok(!r.items.revenue.some((item) => item.amount === 5000), 'the PKR payment is not in the base-currency trend');
});

test('commission a refund took back comes off trainer commission, dated on the refund', () => {
  const r = pnl.build({
    base: 'GBP',
    extra: {
      ...extra,
      membershipCommissionReversals: [
        { at: at('2026-09-21T10:00:00Z'), amount: 15, currency: 'GBP' },
        { at: at('2026-09-22T10:00:00Z'), amount: 300, currency: 'PKR' }
      ]
    }
  });
  const commission = line(r.outflow, 'trainer_commission');
  assert.equal(commission.memberships.base_amount, 0, '15 accrued, 15 taken back');
  assert.deepEqual(commission.memberships.by_currency, [{ currency: 'PKR', amount: -300 }]);
  assert.equal(commission.base_amount, 100, 'the PT commission is untouched');
  assert.ok(r.items.outflow.some((item) => item.at.getTime() === at('2026-09-21T10:00:00Z').getTime() && item.amount === -15));
  const sum = (items) => Math.round(items.reduce((total, item) => total + item.amount, 0) * 100) / 100;
  assert.equal(sum(r.items.outflow), r.total_outflow);
});

test('nothing recorded is a zero, not a gap', () => {
  const r = pnl.build({ base: 'GBP', extra: {} });
  assert.equal(r.total_revenue, 0);
  assert.equal(r.total_outflow, 0);
  assert.equal(r.net_profit, 0);
  assert.equal(r.margin, null);
  assert.equal(r.mixed_currencies, false);
});

test('a payment\'s split, with and without the fields', () => {
  assert.deepEqual(pnl.splitPayment({ amount: 150, admission: 20, trainerFee: 30, membership: 100 }), { membership: 100, admission: 20, trainerFee: 30 });
  assert.deepEqual(pnl.splitPayment({ amount: 150, admission: 20 }), { membership: 130, admission: 20, trainerFee: 0 });
  assert.deepEqual(pnl.splitPayment({ amount: 150 }), { membership: 150, admission: 0, trainerFee: 0 });
});
