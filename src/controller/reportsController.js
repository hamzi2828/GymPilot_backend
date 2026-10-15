// src/controller/reportsController.js
//
// The numbers behind the business over a chosen range, drawn from the same
// collections the operational screens use: revenue and new members over
// time, attendance and its busiest hours, classes by demand, memberships
// won and lost, leads, personal training -- and every list as a CSV or an
// Excel workbook.

const PackageOrder = require('../gymfolio/models/packageOrderModel');
const ClassBooking = require('../gymfolio/models/classBookingModel');
const PtSession = require('../gymfolio/models/ptSessionModel');
const Attendance = require('../attendance/models/attendanceModel');
const Expense = require('../accounts/models/expenseModel');
const Sale = require('../models/saleModel');
const Payslip = require('../models/payslipModel');
const Lead = require('../models/leadModel');
const User = require('../models/user');
const L = require('../accounts/services/ledger');
const pnl = require('../accounts/services/profitAndLoss');
const categories = require('../accounts/services/categories');
const T = require('../attendance/services/timeUtils');
const { sendCsv } = require('../services/csv');
const { sendXlsx } = require('../services/xlsx');
const { countLiveMembers } = require('../gymfolio/services/membershipExpiry');
const { dailySales, exportColumns: dailySalesColumns } = require('../services/dailySales');
const { saleLineStages } = require('../services/saleMoney');
const { methodLabel } = require('../services/paymentMethods');
const { round2, paidSoFar } = require('../gymfolio/services/orderMoney');

const EXPIRING_WINDOW_DAYS = 14;
const EXPORT_LIMIT = 20000;

function paidAtExpr() {
  return { $ifNull: ['$payment.paidAt', '$createdAt'] };
}

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

function fill(buckets, rows, keyOf, valueOf) {
  const map = new Map(buckets.map((b) => [b.key, 0]));
  for (const row of rows) {
    const key = keyOf(row);
    if (map.has(key)) map.set(key, map.get(key) + valueOf(row));
  }
  return buckets.map((b) => ({ key: b.key, label: b.label, value: Math.round(map.get(b.key) * 100) / 100 }));
}

// CSV unless the caller asks for Excel (?format=xlsx, or an export name
// ending .xlsx): the same columns and rows either way. In the workbook the
// columns marked `type: 'date'` are real dates and amounts are numbers.
function exportFormat(req) {
  const format = String((req.query && req.query.format) || '').toLowerCase();
  return format === 'xlsx' || /\.xlsx$/i.test(String((req.params && req.params.kind) || '')) ? 'xlsx' : 'csv';
}

function sendExport(req, res, name, sheet, columns, rows) {
  if (exportFormat(req) === 'xlsx') return sendXlsx(res, `${name}.xlsx`, columns, rows, { sheet });
  return sendCsv(res, `${name}.csv`, columns, rows);
}

// ---- The orders export ----
//
// One row per order that says plainly what was charged, what has come in and
// what is still owed: a part-paid order reads "Part paid" with its balance,
// an unpaid one has no "Paid on" (it used to show the day it was created, as
// if it had been paid), and an order paid in parts lists each payment with
// its day and method.

const PAYMENT_STATUS_LABELS = {
  pending: 'Not paid',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
  cancelled: 'Cancelled'
};

function words(value) {
  const text = String(value || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The money an order has received: its instalments, or -- paid at once --
// one payment on the day it was paid (an old paid order with no date: the
// day it was made).
function orderPayments(order) {
  const p = order.payment || {};
  if (Array.isArray(p.installments) && p.installments.length) {
    return p.installments.map((part) => ({ at: part.at, amount: round2(part.amount), method: part.method || p.method || '' }));
  }
  const paid = paidSoFar(p);
  if (!(paid > 0)) return [];
  return [{ at: p.paidAt || order.createdAt, amount: paid, method: p.method || '' }];
}

function orderMoneyRow(order, member) {
  const p = order.payment || {};
  const payments = orderPayments(order);
  const total = round2(p.amount);
  const paid = payments.length ? paidSoFar(p) : 0;
  let balance = 0;
  if (p.status === 'paid') balance = Math.max(0, round2(p.balanceDue || 0));
  else if (p.status === 'pending' || p.status === 'processing') balance = Math.max(0, round2(total - paid));
  const refundAmount = order.refund && order.refund.amount;
  const refunded = p.status === 'refunded' ? round2(refundAmount !== null && refundAmount !== undefined ? refundAmount : paid) : 0;

  const dates = payments.map((part) => part.at).filter(Boolean).map((at) => new Date(at)).sort((a, b) => a - b);
  // A renewal Stripe collected later is the latest payment.
  const last = dates.length ? new Date(Math.max(...dates, p.lastPaidAt ? new Date(p.lastPaidAt).getTime() : 0)) : null;
  const methods = [...new Set((payments.length ? payments.map((part) => part.method) : [p.method]).filter(Boolean))];

  let status = PAYMENT_STATUS_LABELS[p.status] || words(p.status);
  if (p.status === 'paid' && balance > 0) status = 'Part paid';

  const customer = order.customerInfo || {};
  return {
    ...order,
    memberCode: (member && member.memberCode) || '',
    name: customer.fullName || (member ? [member.firstName, member.lastName].filter(Boolean).join(' ') : ''),
    phone: customer.phone || (member && member.phone) || '',
    email: customer.email || (member && member.email) || '',
    package: (order.packageDetails && order.packageDetails.name) || '',
    currency: String(p.currency || '').toUpperCase(),
    total,
    paid,
    balance,
    refunded,
    paymentStatus: status,
    method: methods.map(methodLabel).join(' + '),
    paidOn: dates.length ? T.dateKey(dates[0]) : '',
    lastPaidOn: last ? T.dateKey(last) : '',
    // Each part, when there was more than one.
    payments: payments.length > 1
      ? payments.map((part) => `${part.at ? T.dateKey(part.at) : '?'} ${part.amount} ${methodLabel(part.method)}`.trim()).join('; ')
      : '',
    membershipStatus: words(order.status)
  };
}

const ORDER_EXPORT_COLUMNS = [
  { key: 'orderNumber', label: 'Order' },
  { key: 'memberCode', label: 'Member code' },
  { key: 'name', label: 'Member' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'package', label: 'Package' },
  { key: 'currency', label: 'Currency' },
  { key: 'total', label: 'Total' },
  { key: 'paid', label: 'Paid' },
  { key: 'balance', label: 'Balance due' },
  { key: 'refunded', label: 'Refunded' },
  { key: 'paymentStatus', label: 'Payment' },
  { key: 'method', label: 'Method' },
  // Blank until money has come in.
  { key: 'paidOn', label: 'Paid on', type: 'date' },
  { key: 'lastPaidOn', label: 'Last payment', type: 'date' },
  { key: 'payments', label: 'Payments' },
  { key: 'membershipStatus', label: 'Membership status' },
  { key: 'start', label: 'Starts', type: 'date', value: (r) => (r.subscription && r.subscription.startDate ? T.dateKey(r.subscription.startDate) : '') },
  { key: 'end', label: 'Ends', type: 'date', value: (r) => (r.subscription && r.subscription.endDate ? T.dateKey(r.subscription.endDate) : '') },
  { key: 'invoice', label: 'Invoice', value: (r) => (r.invoice && r.invoice.number) || '' },
  // Brought over already paid from the gym's old system: listed, but
  // not money taken on its "Paid on" day (see the order model).
  { key: 'imported', label: 'Imported', value: (r) => (r.imported ? 'Yes' : '') }
];

function dateBucketExpr(field, grain, timezone) {
  return { $dateToString: { format: grain === 'day' ? '%Y-%m-%d' : '%Y-%m', date: field, timezone } };
}

// Which expense and till rows are in the gym's own currency. The accounts
// screen reads a row with no currency as the base one (`currency || base`),
// so this report does too -- otherwise the two nets part company over a
// blank field.
function currencyPattern(base) {
  return new RegExp(`^${String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

function inBaseCurrency(base) {
  return { $or: [{ currency: currencyPattern(base) }, { currency: { $in: [null, ''] } }] };
}

function notInBaseCurrency(base) {
  return { currency: { $nin: [null, ''], $not: currencyPattern(base) } };
}

module.exports = {
  // GET /admin/reports/overview?from=&to=
  overview: async (req, res) => {
    try {
      const range = L.readRange(req.query);
      const base = await L.baseCurrency();
      const { grain, buckets } = L.buildBuckets(range.from, range.to);
      const tz = T.timezone();
      const now = new Date();
      const soon = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 86400000);

      // Rows in a currency other than the gym's cannot be added to the base
      // totals (there is no exchange rate here), but they must not vanish
      // either: they are counted so the report can say what it left out.
      const notBase = notInBaseCurrency(base);
      const isBaseCurrency = inBaseCurrency(base);

      // Membership money by the accounts rule (ledger.js): every payment in
      // the period, renewals included, and the refunds given in it -- each
      // grouped by currency, bucket and package, and split up below.
      const byCurrencyBucketPackage = (field) => ({
        $group: {
          _id: { currency: '$currency', bucket: dateBucketExpr(field, grain, tz), package: '$packageName' },
          total: { $sum: '$amount' },
          n: { $sum: 1 }
        }
      });

      const [paymentRows, refundRows, newMembers, attendanceRows, hourRows, classRows, ptRows, leadRows, memberships, renewals, lapsedInRange, expenseRows, shopRows, topProducts, otherExpenses, otherSales] = await Promise.all([
        PackageOrder.aggregate([...L.membershipPaymentStages(range), byCurrencyBucketPackage('$at')]),
        PackageOrder.aggregate([...L.membershipRefundStages(range), byCurrencyBucketPackage('$at')]),
        // Per local day whatever the chart's grain: the registrations table
        // lists days, and the chart adds them up into its months.
        User.aggregate([
          { $match: { role: 'user', createdAt: { $gte: range.start, $lt: range.end } } },
          { $group: { _id: dateBucketExpr('$createdAt', 'day', tz), n: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ]),
        Attendance.aggregate([
          { $match: { personType: 'member', shiftDate: { $gte: range.from, $lte: range.to } } },
          { $group: { _id: grain === 'day' ? '$shiftDate' : { $substr: ['$shiftDate', 0, 7] }, n: { $sum: 1 } } }
        ]),
        Attendance.aggregate([
          { $match: { personType: 'member', shiftDate: { $gte: range.from, $lte: range.to }, checkInAt: { $ne: null } } },
          { $group: { _id: { $hour: { date: '$checkInAt', timezone: tz } }, n: { $sum: 1 } } }
        ]),
        ClassBooking.aggregate([
          { $match: { sessionDate: { $gte: range.from, $lte: range.to }, status: { $in: ['booked', 'attended', 'no_show', 'waitlisted'] } } },
          { $group: { _id: '$className', booked: { $sum: { $cond: [{ $in: ['$status', ['booked', 'attended']] }, 1, 0] } }, attended: { $sum: { $cond: [{ $eq: ['$status', 'attended'] }, 1, 0] } }, no_show: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } }, waitlisted: { $sum: { $cond: [{ $eq: ['$status', 'waitlisted'] }, 1, 0] } } } },
          { $sort: { booked: -1 } },
          { $limit: 10 }
        ]),
        PtSession.aggregate([
          { $match: { date: { $gte: range.from, $lte: range.to } } },
          { $group: { _id: '$status', n: { $sum: 1 }, value: { $sum: '$price' }, commission: { $sum: '$commission.amount' } } }
        ]),
        Lead.aggregate([{ $match: { createdAt: { $gte: range.start, $lt: range.end } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
        // Distinct members with a live order, the same count the dashboard
        // shows (membershipExpiry.countLiveMembers).
        Promise.all([
          countLiveMembers(now),
          countLiveMembers(now, { 'subscription.endDate': { $gte: now, $lt: soon } }),
          User.countDocuments({ role: 'user', isActive: true })
        ]),
        PackageOrder.countDocuments({ 'payment.status': 'paid', renewedFrom: { $ne: null }, $expr: { $and: [{ $gte: [paidAtExpr(), range.start] }, { $lt: [paidAtExpr(), range.end] }] } }),
        PackageOrder.countDocuments({ 'payment.status': 'paid', status: 'expired', 'subscription.endDate': { $gte: range.start, $lt: range.end } }),
        // Expenses by the accounts rule, so the net here is the net there:
        // PAID expenses, filed under the day they belong to (incurredOn),
        // whenever the money actually left. Pending ones are totalled on
        // their own below and never taken off.
        Expense.aggregate([
          { $match: { incurredOn: { $gte: range.start, $lt: range.end }, status: { $ne: 'cancelled' }, ...isBaseCurrency } },
          { $group: { _id: { bucket: dateBucketExpr('$incurredOn', grain, tz), paid: { $eq: ['$status', 'paid'] } }, total: { $sum: '$amount' } } }
        ]),
        Sale.aggregate([
          { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end }, ...isBaseCurrency } },
          { $group: { _id: dateBucketExpr('$paidAt', grain, tz), total: { $sum: '$total' }, n: { $sum: 1 } } }
        ]),
        // Each product's margin is the till's profit on it (services/saleMoney.js):
        // its lines' takings less the tax in them and any discount, less cost.
        Sale.aggregate([
          { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end }, ...isBaseCurrency } },
          ...saleLineStages(),
          { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, total: { $sum: '$items.total' }, profit: { $sum: '$lineProfit' } } },
          { $sort: { total: -1 } },
          { $limit: 8 }
        ]),
        Expense.aggregate([
          { $match: { incurredOn: { $gte: range.start, $lt: range.end }, status: { $ne: 'cancelled' }, ...notBase } },
          { $group: { _id: { $toUpper: { $ifNull: ['$currency', ''] } }, n: { $sum: 1 } } }
        ]),
        Sale.aggregate([
          { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end }, ...notBase } },
          { $group: { _id: { $toUpper: { $ifNull: ['$currency', ''] } }, n: { $sum: 1 } } }
        ])
      ]);

      // Base-currency money by bucket and by package, net of refunds; other
      // currencies totalled on their own, never added in.
      const isBase = (row) => String(row._id.currency || base).toUpperCase() === base;
      const revenueByBucket = new Map();
      const packageTotals = new Map();
      const otherTotals = new Map();
      for (const [rows, sign] of [[paymentRows, 1], [refundRows, -1]]) {
        for (const row of rows) {
          const paid = sign > 0 ? row.n : 0;
          if (isBase(row)) {
            const bucket = revenueByBucket.get(row._id.bucket) || { _id: row._id.bucket, total: 0, n: 0 };
            bucket.total += sign * row.total;
            bucket.n += paid;
            revenueByBucket.set(row._id.bucket, bucket);

            const name = row._id.package || null;
            const entry = packageTotals.get(name) || { _id: name, total: 0, n: 0 };
            entry.total += sign * row.total;
            entry.n += paid;
            packageTotals.set(name, entry);
          } else {
            const code = String(row._id.currency || '').toUpperCase();
            const entry = otherTotals.get(code) || { _id: code, total: 0, n: 0 };
            entry.total += sign * row.total;
            entry.n += paid;
            otherTotals.set(code, entry);
          }
        }
      }
      const revenueRows = [...revenueByBucket.values()];
      const revenueByPackage = [...packageTotals.values()].sort((a, b) => b.total - a.total).slice(0, 8);
      const otherCurrencies = [...otherTotals.values()];

      const otherOrderCount = otherCurrencies.reduce((s, r) => s + r.n, 0);
      const otherExpenseCount = otherExpenses.reduce((s, r) => s + r.n, 0);
      const otherSaleCount = otherSales.reduce((s, r) => s + r.n, 0);
      const otherCodes = [...new Set([...otherCurrencies, ...otherExpenses, ...otherSales].map((r) => String(r._id || '').toUpperCase()).filter(Boolean))].sort();

      const revenue = fill(buckets, revenueRows, (r) => r._id, (r) => r.total);
      const orders = fill(buckets, revenueRows, (r) => r._id, (r) => r.n);
      const members = fill(buckets, newMembers, (r) => (grain === 'day' ? r._id : r._id.slice(0, 7)), (r) => r.n);
      const visits = fill(buckets, attendanceRows, (r) => r._id, (r) => r.n);
      const expenses = fill(buckets, expenseRows.filter((r) => r._id.paid), (r) => r._id.bucket, (r) => r.total);
      const pendingExpenses = expenseRows.filter((r) => !r._id.paid).reduce((s, r) => s + r.total, 0);
      const shop = fill(buckets, shopRows, (r) => r._id, (r) => r.total);
      const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2, '0')}:00`, value: 0 }));
      for (const row of hourRows) if (row._id >= 0 && row._id < 24) hours[row._id].value = row.n;

      const pt = { scheduled: 0, completed: 0, cancelled: 0, no_show: 0, value: 0, commission: 0 };
      for (const row of ptRows) {
        pt[row._id] = row.n;
        if (row._id === 'completed') {
          pt.value = Math.round(row.value * 100) / 100;
          pt.commission = Math.round(row.commission * 100) / 100;
        }
      }
      const leads = { new: 0, contacted: 0, trial: 0, won: 0, lost: 0 };
      for (const row of leadRows) leads[row._id] = row.n;
      const leadTotal = Object.values(leads).reduce((a, b) => a + b, 0);

      const [activeMemberships, expiring, memberCount] = memberships;
      // The net is the Accounts profit and loss for the range: revenue less
      // every outflow line (expenses, salaries, trainer commission, assets).
      const profit = await pnl.forRange(range);
      const shopTotal = shop.reduce((s, b) => s + b.value, 0);
      const revenueTotal = revenue.reduce((s, b) => s + b.value, 0) + shopTotal;
      const expenseTotal = expenses.reduce((s, b) => s + b.value, 0);
      const visitTotal = visits.reduce((s, b) => s + b.value, 0);

      return res.json({
        success: true,
        range: { from: range.from, to: range.to, label: L.rangeLabel(range.from, range.to), grain },
        base_currency: base,
        kpis: {
          revenue: Math.round(revenueTotal * 100) / 100,
          membership_revenue: Math.round((revenueTotal - shopTotal) * 100) / 100,
          shop_revenue: Math.round(shopTotal * 100) / 100,
          shop_sales: shopRows.reduce((s, r) => s + r.n, 0),
          // Paid expenses; the net is the accounts screen's for the range.
          expenses: Math.round(expenseTotal * 100) / 100,
          expenses_pending: Math.round(pendingExpenses * 100) / 100,
          outflow: profit.total_outflow,
          net: profit.net_profit,
          paid_orders: orders.reduce((s, b) => s + b.value, 0),
          new_members: members.reduce((s, b) => s + b.value, 0),
          visits: visitTotal,
          avg_visits_per_day: buckets.length && grain === 'day' ? Math.round((visitTotal / buckets.length) * 10) / 10 : null,
          members_total: memberCount,
          active_memberships: activeMemberships,
          expiring_soon: expiring,
          renewals,
          lapsed: lapsedInRange,
          retention_rate: renewals + lapsedInRange ? Math.round((renewals / (renewals + lapsedInRange)) * 100) : null,
          lead_conversion_rate: leadTotal ? Math.round((leads.won / leadTotal) * 100) : null
        },
        series: { revenue: revenue.map((b, i) => ({ ...b, value: Math.round((b.value + shop[i].value) * 100) / 100 })), membership_revenue: revenue, shop_revenue: shop, expenses, orders, new_members: members, visits, peak_hours: hours },
        top_products: topProducts.map((r) => ({ name: r._id || '—', quantity: r.quantity, total: Math.round(r.total * 100) / 100, margin: Math.round(r.profit * 100) / 100 })),
        revenue_by_package: revenueByPackage.map((r) => ({ name: r._id || '—', total: Math.round(r.total * 100) / 100, orders: r.n })),
        other_currencies: otherCurrencies.map((r) => ({ currency: String(r._id || '').toUpperCase(), total: Math.round(r.total * 100) / 100, orders: r.n })),
        // Everything the base-currency totals above had to leave out.
        other_currency: {
          count: otherOrderCount + otherExpenseCount + otherSaleCount,
          currencies: otherCodes,
          orders: otherOrderCount,
          expenses: otherExpenseCount,
          shop_sales: otherSaleCount
        },
        // New registrations per day, for the table beside the chart: the
        // days on which somebody joined, oldest first. The Members export
        // lists the same people.
        registrations: {
          total: newMembers.reduce((s, r) => s + r.n, 0),
          days: newMembers.map((r) => ({ date: r._id, label: T.dateLabelForKey(r._id), count: r.n }))
        },
        classes: classRows.map((r) => ({ name: r._id || '—', booked: r.booked, attended: r.attended, no_show: r.no_show, waitlisted: r.waitlisted, attendance_rate: r.booked ? Math.round((r.attended / r.booked) * 100) : null })),
        pt,
        leads: { ...leads, total: leadTotal }
      });
    } catch (error) {
      console.error('[reports] overview failed:', error);
      return fail(res, 500, 'Could not build the report');
    }
  },

  // GET /admin/reports/daily-sales?from=&to=
  //
  // Every day in the range: new sign-ups, renewals, admission and trainer
  // fees, dues collected, refunds and the till, and the totals by payment
  // method -- see services/dailySales.js for what goes in which column.
  dailySales: async (req, res) => {
    try {
      const report = await dailySales(L.readRange(req.query));
      return res.json({ success: true, ...report });
    } catch (error) {
      console.error('[reports] daily sales failed:', error);
      return fail(res, 500, 'Could not build the daily sales report');
    }
  },

  // GET /admin/reports/export/:kind?from=&to=[&format=xlsx]
  export: async (req, res) => {
    try {
      const range = L.readRange(req.query);
      const kind = String(req.params.kind || '').replace(/\.(csv|xlsx)$/i, '');
      const stamp = `${range.from}_${range.to}`;
      const inRange = { $gte: range.start, $lt: range.end };
      const keyRange = { $gte: range.from, $lte: range.to };

      if (kind === 'members') {
        // The members who joined in the range, like every other export and
        // the registrations table; ?all=1 for the whole list.
        const everyone = ['1', 'true', 'yes'].includes(String(req.query.all || '').toLowerCase());
        const filter = everyone ? { role: 'user' } : { role: 'user', createdAt: inRange };
        const rows = await User.find(filter).select('firstName lastName email phone memberCode gender dateOfBirth tags source createdAt lastLogin isActive').sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();
        return sendExport(req, res, everyone ? `members_${T.dateKey()}` : `members_joined_${stamp}`, 'Members', [
          { key: 'memberCode', label: 'Member code' },
          { key: 'firstName', label: 'First name' },
          { key: 'lastName', label: 'Last name' },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          { key: 'gender', label: 'Gender' },
          { key: 'dateOfBirth', label: 'Date of birth', type: 'date', value: (r) => (r.dateOfBirth ? T.dateKey(r.dateOfBirth) : '') },
          { key: 'tags', label: 'Tags', value: (r) => (r.tags || []).join(' ') },
          { key: 'source', label: 'Source' },
          { key: 'isActive', label: 'Active', value: (r) => (r.isActive === false ? 'no' : 'yes') },
          { key: 'createdAt', label: 'Joined', type: 'date', value: (r) => T.dateKey(r.createdAt) },
          { key: 'lastLogin', label: 'Last login', type: 'date', value: (r) => (r.lastLogin ? T.dateKey(r.lastLogin) : '') }
        ], rows);
      }

      if (kind === 'daily-sales') {
        const report = await dailySales(range);
        const columns = dailySalesColumns(report);
        const name = `daily_sales_${stamp}`;
        // The CSV is one table with the totals as its last row; the workbook
        // has the same table (totals in bold) and the payment methods on a
        // sheet of their own.
        if (exportFormat(req) === 'xlsx') {
          return sendXlsx(res, `${name}.xlsx`, columns, report.days, {
            sheets: [
              { name: 'Daily sales', columns, rows: report.days, footer: report.totals },
              {
                name: 'By payment method',
                columns: [
                  { key: 'label', label: 'Payment method' },
                  { key: 'amount', label: `Amount (${report.base_currency})` }
                ],
                rows: report.by_method,
                footer: { label: 'Total', amount: report.totals.total }
              }
            ]
          });
        }
        return sendCsv(res, `${name}.csv`, columns, [...report.days, report.totals]);
      }

      if (kind === 'orders') {
        const rows = await PackageOrder.find({ $expr: { $and: [{ $gte: [paidAtExpr(), range.start] }, { $lt: [paidAtExpr(), range.end] }] } }).sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();
        // The member's code (and their phone or email, when the order has none).
        const ids = [...new Set(rows.map((r) => r.userId && String(r.userId)).filter(Boolean))];
        const members = ids.length ? await User.find({ _id: { $in: ids } }).select('memberCode firstName lastName phone email').lean() : [];
        const byId = new Map(members.map((m) => [String(m._id), m]));
        const shaped = rows.map((r) => orderMoneyRow(r, r.userId ? byId.get(String(r.userId)) : null));
        return sendExport(req, res, `orders_${stamp}`, 'Orders', ORDER_EXPORT_COLUMNS, shaped);
      }

      if (kind === 'attendance') {
        const rows = await Attendance.find({ shiftDate: keyRange }).sort({ checkInAt: -1 }).limit(EXPORT_LIMIT).lean();
        return sendExport(req, res, `attendance_${stamp}`, 'Attendance', [
          { key: 'shiftDate', label: 'Date', type: 'date' },
          { key: 'personType', label: 'Type' },
          { key: 'personName', label: 'Name' },
          { key: 'personCode', label: 'Code' },
          { key: 'checkInAt', label: 'Check in', value: (r) => (r.checkInAt ? T.timeLabel(r.checkInAt) : '') },
          { key: 'checkOutAt', label: 'Check out', value: (r) => (r.checkOutAt ? T.timeLabel(r.checkOutAt) : '') },
          { key: 'workedMinutes', label: 'Minutes' },
          { key: 'method', label: 'Method', value: (r) => (r.checkIn && r.checkIn.method) || '' },
          { key: 'membership', label: 'Membership', value: (r) => (r.membership && r.membership.status) || '' },
          { key: 'statusLabel', label: 'Verdict' }
        ], rows);
      }

      if (kind === 'bookings') {
        const rows = await ClassBooking.find({ sessionDate: keyRange }).sort({ sessionDate: -1, sessionStart: 1 }).limit(EXPORT_LIMIT).lean();
        return sendExport(req, res, `bookings_${stamp}`, 'Bookings', [
          { key: 'sessionDate', label: 'Date', type: 'date' },
          { key: 'sessionStart', label: 'Start' },
          { key: 'className', label: 'Class' },
          { key: 'instructorName', label: 'Instructor' },
          { key: 'memberName', label: 'Member' },
          { key: 'memberCode', label: 'Code' },
          { key: 'status', label: 'Status' },
          { key: 'membershipStatus', label: 'Membership' },
          { key: 'bookedBy', label: 'Booked by' },
          { key: 'creditUsed', label: 'Credit used', value: (r) => (r.creditUsed ? 'yes' : 'no') },
          { key: 'createdAt', label: 'Booked on', type: 'date', value: (r) => T.dateKey(r.createdAt) }
        ], rows);
      }

      if (kind === 'leads') {
        const rows = await Lead.find({ createdAt: inRange }).sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();
        return sendExport(req, res, `leads_${stamp}`, 'Leads', [
          { key: 'firstName', label: 'First name' },
          { key: 'lastName', label: 'Last name' },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          { key: 'source', label: 'Source' },
          { key: 'status', label: 'Status' },
          { key: 'interest', label: 'Interest' },
          { key: 'nextFollowUpAt', label: 'Follow up', type: 'date', value: (r) => (r.nextFollowUpAt ? T.dateKey(r.nextFollowUpAt) : '') },
          { key: 'lostReason', label: 'Lost reason' },
          { key: 'createdAt', label: 'Created', type: 'date', value: (r) => T.dateKey(r.createdAt) }
        ], rows);
      }

      if (kind === 'pt-sessions') {
        const rows = await PtSession.find({ date: keyRange }).sort({ date: -1, startTime: 1 }).limit(EXPORT_LIMIT).lean();
        return sendExport(req, res, `pt_sessions_${stamp}`, 'PT sessions', [
          { key: 'date', label: 'Date', type: 'date' },
          { key: 'startTime', label: 'Start' },
          { key: 'trainerName', label: 'Trainer' },
          { key: 'memberName', label: 'Member' },
          { key: 'status', label: 'Status' },
          { key: 'creditUsed', label: 'From pack', value: (r) => (r.creditUsed ? 'yes' : 'no') },
          { key: 'price', label: 'Value' },
          { key: 'currency', label: 'Currency' },
          { key: 'commission', label: 'Commission', value: (r) => (r.commission && r.commission.amount) || 0 }
        ], rows);
      }

      if (kind === 'expenses') {
        const [rows, heads] = await Promise.all([
          Expense.find({ incurredOn: inRange }).sort({ incurredOn: -1 }).limit(EXPORT_LIMIT).lean(),
          // The gym's own heads ("Tea") by name, not their stored key.
          categories.headsFor('expense')
        ]);
        return sendExport(req, res, `expenses_${stamp}`, 'Expenses', [
          { key: 'reference', label: 'Reference' },
          { key: 'incurredOn', label: 'Date', type: 'date', value: (r) => T.dateKey(r.incurredOn) },
          { key: 'title', label: 'Title' },
          { key: 'category', label: 'Category', value: (r) => heads.labelOf(r.category) },
          { key: 'vendor', label: 'Vendor' },
          { key: 'amount', label: 'Amount' },
          { key: 'currency', label: 'Currency' },
          { key: 'status', label: 'Status' },
          { key: 'paymentMethod', label: 'Method' },
          { key: 'paidOn', label: 'Paid on', type: 'date', value: (r) => (r.paidOn ? T.dateKey(r.paidOn) : '') }
        ], rows);
      }

      if (kind === 'payslips') {
        const rows = await Payslip.find({ 'period.from': { $gte: range.from }, 'period.to': { $lte: range.to } }).sort({ 'period.from': -1 }).limit(EXPORT_LIMIT).lean();
        return sendExport(req, res, `payslips_${stamp}`, 'Payslips', [
          { key: 'number', label: 'Payslip' },
          { key: 'staffName', label: 'Staff' },
          { key: 'period', label: 'Period', value: (r) => `${r.period.from} to ${r.period.to}` },
          { key: 'basis', label: 'Basis' },
          { key: 'hours', label: 'Hours' },
          { key: 'base', label: 'Base' },
          { key: 'ptCommission', label: 'PT commission' },
          { key: 'gross', label: 'Gross' },
          { key: 'net', label: 'Net' },
          { key: 'currency', label: 'Currency' },
          { key: 'status', label: 'Status' },
          { key: 'paidOn', label: 'Paid on', type: 'date', value: (r) => (r.paidOn ? T.dateKey(r.paidOn) : '') }
        ], rows);
      }

      return fail(res, 404, 'Unknown export. Try members, orders, daily-sales, attendance, bookings, leads, pt-sessions, expenses or payslips.');
    } catch (error) {
      console.error('[reports] export failed:', error);
      return fail(res, 500, 'Could not build the export');
    }
  }
};
