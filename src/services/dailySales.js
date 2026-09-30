// src/services/dailySales.js
//
// The daily sales sheet: for every day in a range, the money that came in
// and under which heading, and how it was paid -- the page a gym owner checks
// against the till and the bank at the end of the day.
//
// Money is counted by the accounts rules (accounts/services/ledger.js), so a
// day's total here is that day's income on the accounts screen: every
// membership payment on the day it arrived, less the refunds given that day,
// plus the till's paid sales. Only the gym's own currency is added up; rows
// in any other currency are counted and left out, never converted.
//
// Each payment the ledger reports carries how it splits: the admission
// (joining) fee, the trainer fee, and the membership itself (what is left),
// and whether it was a first payment, a renewal or an instalment of dues
// owed. Payments recorded before that split existed have none of it, and
// count wholly as membership money of their kind.
//
// A renewal is either kind the ledger knows: Stripe charging an order again
// (kind 'renewal'), or the first payment of an order that renewed or
// replaced another (renewedFrom) -- renewing at the desk and changing
// package each make a new order, and filing those as new sign-ups
// disagreed with the reports' overview, which counts them as renewals.
//
// The columns never overlap, so each day's parts add up to its total:
//
//   new_signups   first payments: the membership part only
//   renewals      renewal payments, and first payments of renewing or
//                 replacing orders: the membership part only
//   admission     admission fees taken with a first payment or renewal
//   trainer_fees  trainer fees taken with a first payment or renewal
//   dues          instalments -- later part-payments of dues -- whole
//   refunds       membership money given back that day (negative)
//   pos           till sales still paid (a refunded sale is not takings,
//                 as on the accounts screen)

const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Sale = require('../models/saleModel');
const L = require('../accounts/services/ledger');
const T = require('../attendance/services/timeUtils');

const COLUMNS = ['new_signups', 'renewals', 'admission', 'trainer_fees', 'dues', 'refunds', 'pos'];

// Membership payments (payment.method, or the payment's own method) and till
// sales (paymentMethod) share one list, so cash is cash wherever it was taken.
const METHOD_LABELS = {
  cash: 'Cash',
  card: 'Card (desk)',
  stripe: 'Card (online)',
  bank_transfer: 'Bank transfer',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  wallet: 'Other mobile wallet',
  online: 'Online',
  account: 'On account',
  other: 'Other'
};

function methodLabel(method) {
  if (METHOD_LABELS[method]) return METHOD_LABELS[method];
  const words = String(method || '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other';
}

function emptyDay(date) {
  const day = { date, label: T.dateLabelForKey(date), total: 0, payments: 0, sales: 0, methods: {} };
  for (const column of COLUMNS) day[column] = 0;
  return day;
}

function num(value) {
  return Number(value) || 0;
}

/**
 * The report from rows already grouped by day. Pure, so every rule above is
 * tested without a database.
 *
 * @param {object} input
 * @param {string} input.from  'YYYY-MM-DD'
 * @param {string} input.to    'YYYY-MM-DD'
 * @param {string} input.base  the gym's currency, upper case
 * @param {Array<{ day, kind, renewed?, method, currency, amount, admission?, trainerFee?, membership?, n }>} input.payments
 *   `renewed`: the payment's order renewed or replaced another (renewedFrom).
 * @param {Array<{ day, method, currency, amount, n }>} input.refunds
 * @param {Array<{ day, method, currency, total, n }>} input.sales
 */
function buildDailySales({ from, to, base, payments = [], refunds = [], sales = [] }) {
  const days = new Map();
  for (let key = from; key <= to; key = T.shiftDateKey(key, 1)) days.set(key, emptyDay(key));

  const others = new Map(); // currency -> rows left out
  const isBase = (currency) => {
    const code = String(currency || '').toUpperCase();
    return !code || code === base;
  };
  const leaveOut = (currency, n) => {
    const code = String(currency).toUpperCase();
    others.set(code, (others.get(code) || 0) + (n || 1));
  };
  const addMethod = (day, method, amount) => {
    const key = method || 'other';
    day.methods[key] = (day.methods[key] || 0) + amount;
  };

  for (const row of payments) {
    const day = days.get(row.day);
    if (!day) continue;
    if (!isBase(row.currency)) {
      leaveOut(row.currency, row.n);
      continue;
    }
    const amount = num(row.amount);
    day.payments += row.n || 1;
    addMethod(day, row.method, amount);

    if (row.kind === 'installment') {
      day.dues += amount;
      continue;
    }
    const admission = num(row.admission);
    const trainerFee = num(row.trainerFee);
    const membership = row.membership === undefined || row.membership === null ? amount - admission - trainerFee : num(row.membership);
    day.admission += admission;
    day.trainer_fees += trainerFee;
    if (row.kind === 'renewal' || row.renewed) day.renewals += membership;
    else day.new_signups += membership;
  }

  for (const row of refunds) {
    const day = days.get(row.day);
    if (!day) continue;
    if (!isBase(row.currency)) {
      leaveOut(row.currency, row.n);
      continue;
    }
    day.refunds -= num(row.amount);
    addMethod(day, row.method, -num(row.amount));
  }

  for (const row of sales) {
    const day = days.get(row.day);
    if (!day) continue;
    if (!isBase(row.currency)) {
      leaveOut(row.currency, row.n);
      continue;
    }
    day.pos += num(row.total);
    day.sales += row.n || 1;
    addMethod(day, row.method, num(row.total));
  }

  const totals = emptyDay(to);
  delete totals.date;
  totals.label = 'Total';
  const methodTotals = new Map();

  const list = [...days.values()].map((day) => {
    for (const column of COLUMNS) {
      day[column] = L.round(day[column]);
      totals[column] += day[column];
    }
    day.total = L.round(COLUMNS.reduce((sum, column) => sum + day[column], 0));
    totals.payments += day.payments;
    totals.sales += day.sales;
    for (const [method, amount] of Object.entries(day.methods)) {
      day.methods[method] = L.round(amount);
      const entry = methodTotals.get(method) || { method, label: methodLabel(method), amount: 0 };
      entry.amount += amount;
      methodTotals.set(method, entry);
    }
    return day;
  });

  for (const column of COLUMNS) totals[column] = L.round(totals[column]);
  totals.total = L.round(COLUMNS.reduce((sum, column) => sum + totals[column], 0));

  const byMethod = [...methodTotals.values()]
    .map((entry) => ({ ...entry, amount: L.round(entry.amount) }))
    .filter((entry) => entry.amount !== 0)
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
  totals.methods = Object.fromEntries(byMethod.map((entry) => [entry.method, entry.amount]));

  return {
    days: list,
    totals,
    by_method: byMethod,
    other_currency: {
      count: [...others.values()].reduce((sum, n) => sum + n, 0),
      currencies: [...others.keys()].filter(Boolean).sort()
    }
  };
}

/** The report for a range (ledger.readRange), in the gym's currency. */
async function dailySales(range) {
  const base = await L.baseCurrency();
  const tz = T.timezone();
  const dayOf = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: tz } });
  const zero = (field) => ({ $ifNull: [field, 0] });

  const [paymentRows, refundRows, saleRows] = await Promise.all([
    PackageOrder.aggregate([
      ...L.membershipPaymentStages(range),
      {
        $group: {
          _id: {
            day: dayOf('$at'),
            kind: '$kind',
            renewed: { $ne: [{ $ifNull: ['$renewedFrom', null] }, null] },
            method: '$method',
            currency: '$currency'
          },
          amount: { $sum: '$amount' },
          admission: { $sum: zero('$admission') },
          trainerFee: { $sum: zero('$trainerFee') },
          // The ledger's own membership share where it gives one; otherwise
          // whatever the fees leave of the payment.
          membership: {
            $sum: { $ifNull: ['$membership', { $subtract: ['$amount', { $add: [zero('$admission'), zero('$trainerFee')] }] }] }
          },
          n: { $sum: 1 }
        }
      }
    ]),
    PackageOrder.aggregate([
      ...L.membershipRefundStages(range),
      { $group: { _id: { day: dayOf('$at'), method: '$method', currency: '$currency' }, amount: { $sum: '$amount' }, n: { $sum: 1 } } }
    ]),
    Sale.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end } } },
      {
        $group: {
          _id: { day: dayOf('$paidAt'), method: '$paymentMethod', currency: { $toUpper: { $ifNull: ['$currency', ''] } } },
          total: { $sum: '$total' },
          n: { $sum: 1 }
        }
      }
    ])
  ]);

  const flat = (rows) => rows.map((row) => ({ ...row._id, ...row, _id: undefined }));
  const report = buildDailySales({
    from: range.from,
    to: range.to,
    base,
    payments: flat(paymentRows),
    refunds: flat(refundRows),
    sales: flat(saleRows)
  });

  return {
    range: { from: range.from, to: range.to, label: L.rangeLabel(range.from, range.to) },
    base_currency: base,
    ...report
  };
}

/**
 * The sheet's columns for the CSV and the workbook: the fixed headings, then
 * one per payment method that took money in the range.
 */
function exportColumns(report) {
  return [
    { key: 'date', label: 'Date', type: 'date', value: (row) => row.date || row.label },
    { key: 'new_signups', label: 'New sign-ups' },
    { key: 'renewals', label: 'Renewals' },
    { key: 'admission', label: 'Admission fees' },
    { key: 'trainer_fees', label: 'Trainer fees' },
    { key: 'dues', label: 'Dues collected' },
    { key: 'refunds', label: 'Membership refunds' },
    { key: 'pos', label: 'POS sales' },
    { key: 'total', label: `Total (${report.base_currency})` },
    ...report.by_method.map((entry) => ({ key: `method_${entry.method}`, label: entry.label, value: (row) => row.methods[entry.method] || 0 })),
    { key: 'payments', label: 'Membership payments' },
    { key: 'sales', label: 'Till sales' }
  ];
}

module.exports = { buildDailySales, dailySales, exportColumns, methodLabel, METHOD_LABELS, COLUMNS };
