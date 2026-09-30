// src/accounts/services/profitAndLoss.js
//
// The profit and loss behind the Accounts overview: what came in, line by
// line, what went out, line by line, and what is left.
//
//   Revenue   membership fees · admission fees · trainer fees · shop / POS
//             takings · less refunds given
//   Outflow   trainer commission · expenses paid · asset purchases ·
//             salaries (paid payslips)
//
// Every cost is counted once, which takes three rules, because the same money
// can be recorded in two places:
//
//   * A paid payslip files a salary expense. That expense is the payslip, so
//     it is left out of "expenses" and the payslip is counted under salaries.
//   * A payslip's PT commission was already counted under trainer commission
//     when the sessions were completed, so salaries count the payslip less
//     its PT commission. (Commission accrues when it is earned; the salary is
//     counted when it is paid.)
//   * An asset bought "with an expense" files an equipment expense linked to
//     the asset. The purchase is counted once, under asset purchases, on the
//     day the asset was bought -- and the linked expense is left out.
//
// Trainer commission on a membership (the order's trainerAssignment) accrues
// on the order's first payment: payment.paidAt, or the first instalment when
// it was paid in instalments.
//
// Money is kept per currency throughout (ledger.js); the lines' base-currency
// amounts are what the totals and the net add up.

const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const PtSession = require('../../gymfolio/models/ptSessionModel');
const Payslip = require('../../models/payslipModel');
const Asset = require('../models/assetModel');
const Expense = require('../models/expenseModel');
const Sale = require('../../models/saleModel');
const L = require('./ledger');

const REVENUE_LINES = [
  { key: 'membership', label: 'Membership fees' },
  { key: 'admission', label: 'Admission fees' },
  { key: 'trainer_fees', label: 'Trainer fees' },
  { key: 'shop', label: 'Shop / POS takings' },
  { key: 'refunds', label: 'Refunds', deducted: true }
];

const OUTFLOW_LINES = [
  { key: 'trainer_commission', label: 'Trainer commission' },
  { key: 'expenses', label: 'Expenses (paid)' },
  { key: 'asset_purchases', label: 'Asset purchases' },
  { key: 'salaries', label: 'Salaries (paid payslips)' }
];

const num = (value) => Number(value) || 0;
const currencyOf = (value, base) => String(value || base).toUpperCase() || base;

/**
 * One membership payment split into what it paid for. A payment from before
 * the split existed is all membership. (The fields come from
 * ledger.membershipPaymentStages.)
 */
function splitPayment(payment) {
  const admission = num(payment.admission ?? 0);
  const trainerFee = num(payment.trainerFee ?? 0);
  const membership = payment.membership ?? num(payment.amount) - admission - trainerFee;
  return { membership: num(membership), admission, trainerFee };
}

/**
 * Aggregation stages for the trainer commission on memberships that accrued
 * in a range, one document per order: { orderNumber, trainerId, trainerName,
 * at, amount, currency }.
 */
function membershipCommissionStages(range) {
  const inRange = { $gte: range.start, $lt: range.end };
  return [
    {
      $match: {
        $and: [
          { 'trainerAssignment.commissionAmount': { $gt: 0 } },
          // Money came in: paid (or since refunded), or an instalment taken.
          { $or: [{ 'payment.status': { $in: L.MONEY_STATUSES } }, { 'payment.installments.0': { $exists: true } }] },
          { $or: [{ 'payment.paidAt': inRange }, { createdAt: inRange }, { 'payment.installments.at': inRange }] }
        ]
      }
    },
    {
      $project: {
        orderNumber: 1,
        trainerId: '$trainerAssignment.trainerId',
        trainerName: '$trainerAssignment.trainerName',
        amount: '$trainerAssignment.commissionAmount',
        currency: { $toUpper: { $ifNull: ['$payment.currency', ''] } },
        // The first instalment, else the first payment (read the way the
        // payment pipeline reads it).
        at: { $ifNull: [{ $min: '$payment.installments.at' }, L.firstPaymentAtExpr()] }
      }
    },
    { $match: { at: inRange } }
  ];
}

/**
 * Everything the lines are made of beyond what the overview already reads.
 * `expenses` are the overview's non-cancelled expense rows for the range.
 */
async function gather(range, expenses = []) {
  const inRange = { $gte: range.start, $lt: range.end };
  const paidExpenses = expenses.filter((row) => row.status === 'paid');
  const assetIds = [...new Set(paidExpenses.filter((row) => row.assetId && row.category === 'equipment').map((row) => String(row.assetId)))];

  const [membershipCommissions, ptCommissions, payslips, filedByPayslips, assetsBought, linkedAssets] = await Promise.all([
    PackageOrder.aggregate(membershipCommissionStages(range)),
    PtSession.aggregate([
      { $match: { status: 'completed', date: { $gte: range.from, $lte: range.to }, 'commission.amount': { $gt: 0 } } },
      {
        $group: {
          _id: { date: '$date', currency: { $toUpper: { $ifNull: ['$currency', ''] } } },
          amount: { $sum: '$commission.amount' },
          sessions: { $sum: 1 }
        }
      }
    ]),
    Payslip.find({ status: 'paid', paidOn: inRange }).select('net ptCommission currency paidOn').lean(),
    paidExpenses.length
      ? Payslip.find({ expenseId: { $in: paidExpenses.map((row) => row._id) } }).select('expenseId').lean()
      : [],
    Asset.find({ purchasedOn: inRange }).select('name unitCost quantity currency purchasedOn').lean(),
    // A purchase expense stands aside only for an asset that is still in the
    // register with a purchase date -- otherwise nothing else counts it.
    assetIds.length ? Asset.find({ _id: { $in: assetIds }, purchasedOn: { $ne: null } }).select('_id').lean() : []
  ]);

  return {
    membershipCommissions,
    ptCommissions,
    payslips,
    payslipExpenseIds: new Set(filedByPayslips.map((row) => String(row.expenseId))),
    assetsBought,
    purchaseAssetIds: new Set(linkedAssets.map((row) => String(row._id)))
  };
}

/**
 * The lines, their totals and the net, from what the overview read plus
 * gather()'s answer. Pure. Also returns `items`: each base-currency amount
 * with when it happened -- an instant, or a PT session's 'YYYY-MM-DD' local
 * day -- so the trend can bucket exactly the money the lines add up.
 */
function build({ base, payments = [], refunds = [], sales = [], expenses = [], extra }) {
  const totals = Object.fromEntries([...REVENUE_LINES, ...OUTFLOW_LINES].map((line) => [line.key, {}]));
  const commission = { membership: {}, pt: {} };
  const items = { revenue: [], outflow: [] };
  const note = (side, at, currency, amount) => {
    if (currency === base && amount) items[side].push({ at, amount });
  };

  // ---- Revenue ----
  for (const payment of payments) {
    const currency = currencyOf(payment.currency, base);
    const split = splitPayment(payment);
    L.addTo(totals.membership, currency, split.membership);
    L.addTo(totals.admission, currency, split.admission);
    L.addTo(totals.trainer_fees, currency, split.trainerFee);
    note('revenue', payment.at, currency, num(payment.amount));
  }
  for (const sale of sales) {
    const currency = currencyOf(sale.currency, base);
    L.addTo(totals.shop, currency, num(sale.total));
    note('revenue', sale.paidAt, currency, num(sale.total));
  }
  for (const refund of refunds) {
    const currency = currencyOf(refund.currency, base);
    L.addTo(totals.refunds, currency, num(refund.amount));
    note('revenue', refund.at, currency, -num(refund.amount));
  }

  // ---- Outflow ----
  for (const row of extra.membershipCommissions || []) {
    const currency = currencyOf(row.currency, base);
    L.addTo(commission.membership, currency, num(row.amount));
    L.addTo(totals.trainer_commission, currency, num(row.amount));
    note('outflow', row.at, currency, num(row.amount));
  }
  for (const row of extra.ptCommissions || []) {
    const currency = currencyOf(row._id && row._id.currency, base);
    L.addTo(commission.pt, currency, num(row.amount));
    L.addTo(totals.trainer_commission, currency, num(row.amount));
    // Sessions are dated by the gym-local day already.
    note('outflow', row._id && row._id.date, currency, num(row.amount));
  }

  const setAside = { payslips: 0, assets: 0 };
  for (const expense of expenses) {
    if (expense.status !== 'paid') continue;
    const id = String(expense._id);
    if (extra.payslipExpenseIds && extra.payslipExpenseIds.has(id)) {
      setAside.payslips += 1;
      continue;
    }
    if (expense.assetId && expense.category === 'equipment' && extra.purchaseAssetIds && extra.purchaseAssetIds.has(String(expense.assetId))) {
      setAside.assets += 1;
      continue;
    }
    const currency = currencyOf(expense.currency, base);
    L.addTo(totals.expenses, currency, num(expense.amount));
    note('outflow', expense.incurredOn, currency, num(expense.amount));
  }

  for (const asset of extra.assetsBought || []) {
    const currency = currencyOf(asset.currency, base);
    const cost = num(asset.unitCost) * Math.max(1, num(asset.quantity) || 1);
    L.addTo(totals.asset_purchases, currency, cost);
    note('outflow', asset.purchasedOn, currency, cost);
  }

  for (const slip of extra.payslips || []) {
    const currency = currencyOf(slip.currency, base);
    // The PT commission on it is already under trainer commission.
    const salary = num(slip.net) - num(slip.ptCommission);
    L.addTo(totals.salaries, currency, salary);
    note('outflow', slip.paidOn, currency, salary);
  }

  const present = (lines) =>
    lines.map((line) => ({
      key: line.key,
      label: line.label,
      ...(line.deducted ? { deducted: true } : {}),
      ...L.presentTotals(totals[line.key], base)
    }));

  const revenue = present(REVENUE_LINES);
  const outflow = present(OUTFLOW_LINES);
  const commissionLine = outflow.find((line) => line.key === 'trainer_commission');
  commissionLine.memberships = L.presentTotals(commission.membership, base);
  commissionLine.personal_training = L.presentTotals(commission.pt, base);

  const totalRevenue = L.round(revenue.reduce((sum, line) => sum + (line.deducted ? -line.base_amount : line.base_amount), 0));
  const totalOutflow = L.round(outflow.reduce((sum, line) => sum + line.base_amount, 0));
  const net = L.round(totalRevenue - totalOutflow);

  return {
    currency: base,
    revenue,
    outflow,
    total_revenue: totalRevenue,
    total_outflow: totalOutflow,
    net_profit: net,
    margin: totalRevenue ? Math.round((net / totalRevenue) * 1000) / 10 : null,
    // Money in another currency is listed per line, never added in.
    mixed_currencies: [...revenue, ...outflow].some((line) => line.mixed),
    // Rows left out of "expenses" because another line counts them.
    set_aside: { payslip_expenses: setAside.payslips, asset_purchase_expenses: setAside.assets },
    items
  };
}

/**
 * The whole profit and loss for a range, read as the Accounts overview reads
 * it, for a screen that shows its net without the overview's other figures
 * (the Reports page) -- so the two nets cannot disagree.
 */
async function forRange(range) {
  const [base, payments, refunds, expenses, sales] = await Promise.all([
    L.baseCurrency(),
    PackageOrder.aggregate(L.membershipPaymentStages(range)),
    PackageOrder.aggregate(L.membershipRefundStages(range)),
    Expense.find({ incurredOn: { $gte: range.start, $lt: range.end }, status: { $ne: 'cancelled' } }).lean(),
    Sale.find({ status: 'paid', paidAt: { $gte: range.start, $lt: range.end } }).select('total currency paidAt').lean()
  ]);
  return build({ base, payments, refunds, sales, expenses, extra: await gather(range, expenses) });
}

module.exports = {
  REVENUE_LINES,
  OUTFLOW_LINES,
  splitPayment,
  membershipCommissionStages,
  gather,
  build,
  forRange
};
