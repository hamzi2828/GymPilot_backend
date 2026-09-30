// services/dailySales.buildDailySales: which money goes in which column, the
// columns adding up to each day's total, refunds and other currencies, and
// the totals by payment method -- from grouped rows shaped like the ledger's
// payment rows, including the admission / trainer fee / membership split and
// the initial / renewal / installment kinds.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDailySales, exportColumns, methodLabel } = require('../../src/services/dailySales');

const D1 = '2026-08-01';
const D2 = '2026-08-02';
const D3 = '2026-08-03';
const D4 = '2026-08-04';

const payments = [
  // A sign-up: 1000 = 200 admission + 300 trainer fee + 500 membership (no
  // membership share given: it is what the fees leave).
  { day: D1, kind: 'initial', method: 'cash', currency: 'GBP', amount: 1000, admission: 200, trainerFee: 300, n: 1 },
  // A renewal that states its membership share.
  { day: D1, kind: 'renewal', method: 'jazzcash', currency: 'GBP', amount: 800, admission: 0, trainerFee: 0, membership: 800, n: 1 },
  // Dues paid later: the whole instalment is dues, whatever it covered.
  { day: D2, kind: 'installment', method: 'easypaisa', currency: 'GBP', amount: 400, admission: 50, trainerFee: 0, membership: 350, n: 1 },
  // A payment from before the split existed: all membership money.
  { day: D2, kind: 'initial', method: 'stripe', currency: 'GBP', amount: 600, n: 2 },
  // No currency: the gym's own.
  { day: D3, kind: 'renewal', method: 'bank_transfer', currency: '', amount: 25, n: 1 },
  // Another currency: left out, counted.
  { day: D1, kind: 'initial', method: 'cash', currency: 'PKR', amount: 5000, n: 1 },
  // Outside the range: ignored.
  { day: '2026-07-31', kind: 'initial', method: 'cash', currency: 'GBP', amount: 999, n: 1 }
];
const refunds = [{ day: D2, method: 'cash', currency: 'GBP', amount: 100, n: 1 }];
const sales = [
  { day: D1, method: 'cash', currency: 'GBP', total: 150, n: 3 },
  { day: D2, method: 'card', currency: 'GBP', total: 70, n: 1 },
  { day: D2, method: 'cash', currency: 'USD', total: 10, n: 1 }
];

const report = buildDailySales({ from: D1, to: D4, base: 'GBP', payments, refunds, sales });
const pick = (day) => ({
  new_signups: day.new_signups,
  renewals: day.renewals,
  admission: day.admission,
  trainer_fees: day.trainer_fees,
  dues: day.dues,
  refunds: day.refunds,
  pos: day.pos,
  total: day.total
});

test('every day of the range is a row, quiet days included', () => {
  assert.deepEqual(report.days.map((d) => d.date), [D1, D2, D3, D4]);
  assert.equal(report.days[0].label, '01 Aug 2026');
  assert.deepEqual(pick(report.days[3]), { new_signups: 0, renewals: 0, admission: 0, trainer_fees: 0, dues: 0, refunds: 0, pos: 0, total: 0 });
});

test('a payment splits into sign-up or renewal money, admission and trainer fees; instalments are dues', () => {
  assert.deepEqual(pick(report.days[0]), { new_signups: 500, renewals: 800, admission: 200, trainer_fees: 300, dues: 0, refunds: 0, pos: 150, total: 1950 });
  assert.deepEqual(pick(report.days[1]), { new_signups: 600, renewals: 0, admission: 0, trainer_fees: 0, dues: 400, refunds: -100, pos: 70, total: 970 });
  assert.deepEqual(pick(report.days[2]), { new_signups: 0, renewals: 25, admission: 0, trainer_fees: 0, dues: 0, refunds: 0, pos: 0, total: 25 });
  assert.equal(report.days[0].payments, 2);
  assert.equal(report.days[0].sales, 3);
  assert.equal(report.days[1].payments, 3);
});

test('totals add the days, and each total is the sum of its columns', () => {
  assert.deepEqual(pick(report.totals), { new_signups: 1100, renewals: 825, admission: 200, trainer_fees: 300, dues: 400, refunds: -100, pos: 220, total: 2945 });
  assert.equal(report.totals.label, 'Total');
  assert.equal(report.days.reduce((sum, d) => sum + d.total, 0), report.totals.total);
});

test('by payment method: membership payments, refunds and the till together, largest first', () => {
  assert.deepEqual(report.by_method, [
    { method: 'cash', label: 'Cash', amount: 1050 },
    { method: 'jazzcash', label: 'JazzCash', amount: 800 },
    { method: 'stripe', label: 'Card (online)', amount: 600 },
    { method: 'easypaisa', label: 'Easypaisa', amount: 400 },
    { method: 'card', label: 'Card (desk)', amount: 70 },
    { method: 'bank_transfer', label: 'Bank transfer', amount: 25 }
  ]);
  assert.equal(report.by_method.reduce((sum, m) => sum + m.amount, 0), report.totals.total, 'the methods account for every penny');
  assert.deepEqual(report.days[1].methods, { easypaisa: 400, stripe: 600, cash: -100, card: 70 });
  assert.equal(report.totals.methods.cash, 1050);
});

test('other currencies are left out of every figure and counted', () => {
  assert.deepEqual(report.other_currency, { count: 2, currencies: ['PKR', 'USD'] });
});

test('payment method labels, the mobile wallets included', () => {
  assert.equal(methodLabel('jazzcash'), 'JazzCash');
  assert.equal(methodLabel('easypaisa'), 'Easypaisa');
  assert.equal(methodLabel('wallet'), 'Other mobile wallet');
  assert.equal(methodLabel('crypto_coin'), 'Crypto coin');
  assert.equal(methodLabel(''), 'Other');
});

test('export columns: the headings, then one per payment method that took money', () => {
  const columns = exportColumns({ ...report, base_currency: 'GBP' });
  assert.deepEqual(columns.map((c) => c.label), [
    'Date', 'New sign-ups', 'Renewals', 'Admission fees', 'Trainer fees', 'Dues collected', 'Membership refunds', 'POS sales', 'Total (GBP)',
    'Cash', 'JazzCash', 'Card (online)', 'Easypaisa', 'Card (desk)', 'Bank transfer',
    'Membership payments', 'Till sales'
  ]);
  const cash = columns.find((c) => c.label === 'Cash');
  assert.equal(cash.value(report.days[1]), -100);
  assert.equal(cash.value(report.days[3]), 0);
  assert.equal(columns[0].value(report.totals), 'Total');
});
