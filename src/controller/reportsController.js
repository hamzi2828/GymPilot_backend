// src/controller/reportsController.js
//
// The numbers behind the business over a chosen range, drawn from the same
// collections the operational screens use: revenue and new members over
// time, attendance and its busiest hours, classes by demand, memberships
// won and lost, leads, personal training -- and every list as a CSV.

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
const T = require('../attendance/services/timeUtils');
const { sendCsv } = require('../services/csv');
const { countLiveMembers } = require('../gymfolio/services/membershipExpiry');

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

function dateBucketExpr(field, grain, timezone) {
  return { $dateToString: { format: grain === 'day' ? '%Y-%m-%d' : '%Y-%m', date: field, timezone } };
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
      const notBase = { $not: new RegExp(`^${base}$`, 'i') };

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
        User.aggregate([
          { $match: { role: 'user', createdAt: { $gte: range.start, $lt: range.end } } },
          { $group: { _id: dateBucketExpr('$createdAt', grain, tz), n: { $sum: 1 } } }
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
        Expense.aggregate([
          { $match: { incurredOn: { $gte: range.start, $lt: range.end }, status: { $ne: 'cancelled' }, currency: new RegExp(`^${base}$`, 'i') } },
          { $group: { _id: dateBucketExpr('$incurredOn', grain, tz), total: { $sum: '$amount' } } }
        ]),
        Sale.aggregate([
          { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end }, currency: new RegExp(`^${base}$`, 'i') } },
          { $group: { _id: dateBucketExpr('$paidAt', grain, tz), total: { $sum: '$total' }, n: { $sum: 1 } } }
        ]),
        Sale.aggregate([
          { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end }, currency: new RegExp(`^${base}$`, 'i') } },
          { $unwind: '$items' },
          { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, total: { $sum: '$items.total' }, cost: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitCost', 0] }] } } } },
          { $sort: { total: -1 } },
          { $limit: 8 }
        ]),
        Expense.aggregate([
          { $match: { incurredOn: { $gte: range.start, $lt: range.end }, status: { $ne: 'cancelled' }, currency: notBase } },
          { $group: { _id: { $toUpper: { $ifNull: ['$currency', ''] } }, n: { $sum: 1 } } }
        ]),
        Sale.aggregate([
          { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end }, currency: notBase } },
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
      const members = fill(buckets, newMembers, (r) => r._id, (r) => r.n);
      const visits = fill(buckets, attendanceRows, (r) => r._id, (r) => r.n);
      const expenses = fill(buckets, expenseRows, (r) => r._id, (r) => r.total);
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
          expenses: Math.round(expenseTotal * 100) / 100,
          net: Math.round((revenueTotal - expenseTotal) * 100) / 100,
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
        top_products: topProducts.map((r) => ({ name: r._id || '—', quantity: r.quantity, total: Math.round(r.total * 100) / 100, margin: Math.round((r.total - r.cost) * 100) / 100 })),
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
        classes: classRows.map((r) => ({ name: r._id || '—', booked: r.booked, attended: r.attended, no_show: r.no_show, waitlisted: r.waitlisted, attendance_rate: r.booked ? Math.round((r.attended / r.booked) * 100) : null })),
        pt,
        leads: { ...leads, total: leadTotal }
      });
    } catch (error) {
      console.error('[reports] overview failed:', error);
      return fail(res, 500, 'Could not build the report');
    }
  },

  // GET /admin/reports/export/:kind?from=&to=
  export: async (req, res) => {
    try {
      const range = L.readRange(req.query);
      const kind = String(req.params.kind || '').replace(/\.csv$/, '');
      const stamp = `${range.from}_${range.to}`;
      const inRange = { $gte: range.start, $lt: range.end };
      const keyRange = { $gte: range.from, $lte: range.to };

      if (kind === 'members') {
        const rows = await User.find({ role: 'user' }).select('firstName lastName email phone memberCode gender dateOfBirth tags source createdAt lastLogin isActive').sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();
        return sendCsv(res, `members_${T.dateKey()}.csv`, [
          { key: 'memberCode', label: 'Member code' },
          { key: 'firstName', label: 'First name' },
          { key: 'lastName', label: 'Last name' },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          { key: 'gender', label: 'Gender' },
          { key: 'dateOfBirth', label: 'Date of birth', value: (r) => (r.dateOfBirth ? T.dateKey(r.dateOfBirth) : '') },
          { key: 'tags', label: 'Tags', value: (r) => (r.tags || []).join(' ') },
          { key: 'source', label: 'Source' },
          { key: 'isActive', label: 'Active', value: (r) => (r.isActive === false ? 'no' : 'yes') },
          { key: 'createdAt', label: 'Joined', value: (r) => T.dateKey(r.createdAt) },
          { key: 'lastLogin', label: 'Last login', value: (r) => (r.lastLogin ? T.dateKey(r.lastLogin) : '') }
        ], rows);
      }

      if (kind === 'orders') {
        const rows = await PackageOrder.find({ $expr: { $and: [{ $gte: [paidAtExpr(), range.start] }, { $lt: [paidAtExpr(), range.end] }] } }).sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();
        return sendCsv(res, `orders_${stamp}.csv`, [
          { key: 'orderNumber', label: 'Order' },
          { key: 'name', label: 'Member', value: (r) => (r.customerInfo && r.customerInfo.fullName) || '' },
          { key: 'email', label: 'Email', value: (r) => (r.customerInfo && r.customerInfo.email) || '' },
          { key: 'package', label: 'Package', value: (r) => (r.packageDetails && r.packageDetails.name) || '' },
          { key: 'amount', label: 'Amount', value: (r) => r.payment && r.payment.amount },
          { key: 'currency', label: 'Currency', value: (r) => (r.payment && r.payment.currency) || '' },
          { key: 'method', label: 'Method', value: (r) => (r.payment && r.payment.method) || '' },
          { key: 'paymentStatus', label: 'Payment', value: (r) => (r.payment && r.payment.status) || '' },
          { key: 'status', label: 'Membership status' },
          { key: 'paidAt', label: 'Paid on', value: (r) => (r.payment && r.payment.paidAt ? T.dateKey(r.payment.paidAt) : T.dateKey(r.createdAt)) },
          { key: 'start', label: 'Starts', value: (r) => (r.subscription && r.subscription.startDate ? T.dateKey(r.subscription.startDate) : '') },
          { key: 'end', label: 'Ends', value: (r) => (r.subscription && r.subscription.endDate ? T.dateKey(r.subscription.endDate) : '') },
          { key: 'invoice', label: 'Invoice', value: (r) => (r.invoice && r.invoice.number) || '' }
        ], rows);
      }

      if (kind === 'attendance') {
        const rows = await Attendance.find({ shiftDate: keyRange }).sort({ checkInAt: -1 }).limit(EXPORT_LIMIT).lean();
        return sendCsv(res, `attendance_${stamp}.csv`, [
          { key: 'shiftDate', label: 'Date' },
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
        return sendCsv(res, `bookings_${stamp}.csv`, [
          { key: 'sessionDate', label: 'Date' },
          { key: 'sessionStart', label: 'Start' },
          { key: 'className', label: 'Class' },
          { key: 'instructorName', label: 'Instructor' },
          { key: 'memberName', label: 'Member' },
          { key: 'memberCode', label: 'Code' },
          { key: 'status', label: 'Status' },
          { key: 'membershipStatus', label: 'Membership' },
          { key: 'bookedBy', label: 'Booked by' },
          { key: 'creditUsed', label: 'Credit used', value: (r) => (r.creditUsed ? 'yes' : 'no') },
          { key: 'createdAt', label: 'Booked on', value: (r) => T.dateKey(r.createdAt) }
        ], rows);
      }

      if (kind === 'leads') {
        const rows = await Lead.find({ createdAt: inRange }).sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();
        return sendCsv(res, `leads_${stamp}.csv`, [
          { key: 'firstName', label: 'First name' },
          { key: 'lastName', label: 'Last name' },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          { key: 'source', label: 'Source' },
          { key: 'status', label: 'Status' },
          { key: 'interest', label: 'Interest' },
          { key: 'nextFollowUpAt', label: 'Follow up', value: (r) => (r.nextFollowUpAt ? T.dateKey(r.nextFollowUpAt) : '') },
          { key: 'lostReason', label: 'Lost reason' },
          { key: 'createdAt', label: 'Created', value: (r) => T.dateKey(r.createdAt) }
        ], rows);
      }

      if (kind === 'pt-sessions') {
        const rows = await PtSession.find({ date: keyRange }).sort({ date: -1, startTime: 1 }).limit(EXPORT_LIMIT).lean();
        return sendCsv(res, `pt_sessions_${stamp}.csv`, [
          { key: 'date', label: 'Date' },
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
        const rows = await Expense.find({ incurredOn: inRange }).sort({ incurredOn: -1 }).limit(EXPORT_LIMIT).lean();
        return sendCsv(res, `expenses_${stamp}.csv`, [
          { key: 'reference', label: 'Reference' },
          { key: 'incurredOn', label: 'Date', value: (r) => T.dateKey(r.incurredOn) },
          { key: 'title', label: 'Title' },
          { key: 'category', label: 'Category' },
          { key: 'vendor', label: 'Vendor' },
          { key: 'amount', label: 'Amount' },
          { key: 'currency', label: 'Currency' },
          { key: 'status', label: 'Status' },
          { key: 'paymentMethod', label: 'Method' },
          { key: 'paidOn', label: 'Paid on', value: (r) => (r.paidOn ? T.dateKey(r.paidOn) : '') }
        ], rows);
      }

      if (kind === 'payslips') {
        const rows = await Payslip.find({ 'period.from': { $gte: range.from }, 'period.to': { $lte: range.to } }).sort({ 'period.from': -1 }).limit(EXPORT_LIMIT).lean();
        return sendCsv(res, `payslips_${stamp}.csv`, [
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
          { key: 'paidOn', label: 'Paid on', value: (r) => (r.paidOn ? T.dateKey(r.paidOn) : '') }
        ], rows);
      }

      return fail(res, 404, 'Unknown export. Try members, orders, attendance, bookings, leads, pt-sessions, expenses or payslips.');
    } catch (error) {
      console.error('[reports] export failed:', error);
      return fail(res, 500, 'Could not build the export');
    }
  }
};
