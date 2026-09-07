// src/accounts/controller/accountsController.js
//
// The two reads that answer "how is the gym doing": the overview (money in,
// money out, what is left) and the sales report behind the money-in half.
//
// Income here is membership sales, because that is the income this system
// records. A gym also takes day passes, PT sessions and drinks over the
// counter; until those are sold through this system they are not in these
// numbers, and the response says so rather than quietly under-reporting.

const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Expense = require('../models/expenseModel');
const Asset = require('../models/assetModel');
const User = require('../../models/user');
const Trainer = require('../../gymfolio/models/trainerModel');
const Attendance = require('../../attendance/models/attendanceModel');
const L = require('../services/ledger');
const T = require('../../attendance/services/timeUtils');

// A paid order is filed under the day the money arrived. paidAt is the truth;
// createdAt is the fallback for older rows written before it was recorded.
function paidAtExpr() {
  return { $ifNull: ['$payment.paidAt', '$createdAt'] };
}

function orderPaidDate(order) {
  return (order.payment && order.payment.paidAt) || order.createdAt;
}

// ---------------------------------------------------------------------------
// Payroll
//
// Wages are most gyms' largest cost, and they are already described on the
// staff records -- so the overview computes what the roster commits the gym to
// rather than waiting for someone to type it in as an expense. Salaried people
// cost their salary; hourly people cost the hours attendance actually recorded.
// ---------------------------------------------------------------------------

async function payrollFor(range) {
  const staff = await User.find({ 'employment.isStaff': true, isActive: true })
    .select('firstName lastName employment.payroll employment.jobTitle')
    .lean();

  // Trainers who are also employed here. Their punches are filed against the
  // TRAINER record, not the User -- resolvePerson() checks Trainer first -- so
  // without this join their hours were invisible to payroll and an hourly
  // trainer's wages came out as zero. Trainer.userId is what ties the two
  // records back to one person.
  const [linkedTrainers, unlinkedTrainerCount] = await Promise.all([
    Trainer.find({ isActive: true, userId: { $ne: null } })
      .select('userId')
      .lean(),
    // Counted so the screen can say the figure excludes them, rather than
    // quietly reporting a wage bill that leaves the coaching staff out.
    Trainer.countDocuments({ isActive: true, userId: null })
  ]);

  if (!staff.length) {
    return {
      totals: {},
      salaried: 0,
      hourly: 0,
      headcount: 0,
      hours: 0,
      people: [],
      unlinked_trainers: unlinkedTrainerCount
    };
  }

  const staffIds = new Set(staff.map((person) => String(person._id)));

  // trainer _id -> the staff User the hours belong to. Trainers linked to
  // somebody who is not staff (or is deactivated) are left out.
  const trainerToUser = new Map();
  for (const trainer of linkedTrainers) {
    const owner = String(trainer.userId);
    if (staffIds.has(owner)) trainerToUser.set(String(trainer._id), owner);
  }

  // Hours worked in the period, per person, for the hourly half. Matches both
  // identities a staff punch can carry.
  const punchIds = [
    ...staff.map((person) => person._id),
    ...linkedTrainers
      .filter((trainer) => trainerToUser.has(String(trainer._id)))
      .map((trainer) => trainer._id)
  ];

  const worked = await Attendance.aggregate([
    {
      $match: {
        personType: 'staff',
        personId: { $in: punchIds },
        checkInAt: { $gte: range.start, $lt: range.end },
        workedMinutes: { $ne: null }
      }
    },
    { $group: { _id: '$personId', minutes: { $sum: '$workedMinutes' } } }
  ]);

  // Folded onto the User id, so a person who punched some shifts as a trainer
  // and some as a staff account is paid for all of them once.
  const minutesById = new Map();
  for (const row of worked) {
    const key = String(row._id);
    const owner = trainerToUser.get(key) || key;
    minutesById.set(owner, (minutesById.get(owner) || 0) + row.minutes);
  }

  // Salaries are quoted per cycle, so a range that is not exactly one cycle has
  // to be pro-rated or the figure is meaningless.
  const days = Math.max(1, Math.round((range.end - range.start) / L.DAY_MS));
  const cycleDays = { weekly: 7, biweekly: 14, monthly: 30.44 };

  const totals = {};
  let salaried = 0;
  let hourly = 0;
  let totalMinutes = 0;
  const people = [];

  for (const person of staff) {
    const payroll = (person.employment && person.employment.payroll) || {};
    const currency = String(payroll.currency || 'PKR').toUpperCase();
    let cost = 0;
    let basis = payroll.basis || 'salaried';

    if (basis === 'hourly') {
      const minutes = minutesById.get(String(person._id)) || 0;
      totalMinutes += minutes;
      cost = ((minutes / 60) * (Number(payroll.hourlyRate) || 0));
      hourly += cost;
    } else {
      const perDay = (Number(payroll.salary) || 0) / (cycleDays[payroll.cycle] || 30.44);
      cost = perDay * days;
      salaried += cost;
    }

    if (!cost) continue;

    L.addTo(totals, currency, cost);
    people.push({
      id: String(person._id),
      name: [person.firstName, person.lastName].filter(Boolean).join(' ').trim(),
      job_title: (person.employment && person.employment.jobTitle) || '',
      basis,
      currency,
      hours: basis === 'hourly' ? Math.round(((minutesById.get(String(person._id)) || 0) / 60) * 10) / 10 : null,
      cost: L.round(cost)
    });
  }

  return {
    totals,
    salaried: L.round(salaried),
    hourly: L.round(hourly),
    headcount: staff.length,
    hours: Math.round((totalMinutes / 60) * 10) / 10,
    people: people.sort((a, b) => b.cost - a.cost),
    // Active trainers with no staff account behind them. They punch in and
    // out like everyone else, but nothing here knows what they are paid, so
    // they are not in the total above. Surfaced rather than swallowed.
    unlinked_trainers: unlinkedTrainerCount
  };
}

module.exports = {
  // -------------------------------------------------------------------------
  // GET /api/accounts/overview
  // -------------------------------------------------------------------------
  overview: async (req, res) => {
    try {
      const range = L.readRange(req.query);
      const base = await L.baseCurrency();
      const { grain, buckets } = L.buildBuckets(range.from, range.to);

      // Till sales (shop / POS) are money in beside memberships.
      const Sale = require('../../models/saleModel');
      const [orders, expenses, assets, payroll, sales] = await Promise.all([
        PackageOrder.find({
          'payment.status': { $in: ['paid', 'refunded'] },
          $expr: {
            $and: [
              { $gte: [paidAtExpr(), range.start] },
              { $lt: [paidAtExpr(), range.end] }
            ]
          }
        })
          .select('orderNumber userId customerInfo packageDetails payment subscription status createdAt')
          .lean(),

        Expense.find({
          incurredOn: { $gte: range.start, $lt: range.end },
          status: { $ne: 'cancelled' }
        }).lean(),

        Asset.find({ status: { $nin: ['sold', 'lost'] } }).lean(),

        payrollFor(range),

        Sale.find({ status: 'paid', paidAt: { $gte: range.start, $lt: range.end } })
          .select('total currency paidAt paymentMethod items')
          .lean()
          .catch(() => [])
      ]);

      // ---- Money in ----
      const revenue = {};
      // Shop takings, kept as their own line and also folded into revenue so
      // the net figure counts every sale the system recorded.
      const shop = {};
      for (const sale of sales) {
        const currency = String(sale.currency || base).toUpperCase();
        L.addTo(shop, currency, Number(sale.total) || 0);
        L.addTo(revenue, currency, Number(sale.total) || 0);
      }
      const refunds = {};
      const byPackage = new Map();
      const byMethod = new Map();

      for (const order of orders) {
        const currency = String(order.payment.currency || base).toUpperCase();
        const amount = Number(order.payment.amount) || 0;

        if (order.payment.status === 'refunded') {
          L.addTo(refunds, currency, amount);
          continue;
        }

        L.addTo(revenue, currency, amount);

        const packageName = (order.packageDetails && order.packageDetails.name) || 'Unknown';
        const packageEntry = byPackage.get(packageName) || { name: packageName, count: 0, totals: {} };
        packageEntry.count += 1;
        L.addTo(packageEntry.totals, currency, amount);
        byPackage.set(packageName, packageEntry);

        const method = (order.payment.method || 'other');
        const methodEntry = byMethod.get(method) || { method, count: 0, totals: {} };
        methodEntry.count += 1;
        L.addTo(methodEntry.totals, currency, amount);
        byMethod.set(method, methodEntry);
      }

      // ---- Money out ----
      const spendPaid = {};
      const spendPending = {};
      const byCategory = new Map();

      for (const expense of expenses) {
        const currency = String(expense.currency || base).toUpperCase();
        const amount = Number(expense.amount) || 0;

        if (expense.status === 'paid') L.addTo(spendPaid, currency, amount);
        else L.addTo(spendPending, currency, amount);

        const entry = byCategory.get(expense.category) || {
          category: expense.category,
          label: Expense.CATEGORY_LABELS[expense.category] || expense.category,
          count: 0,
          totals: {}
        };
        entry.count += 1;
        L.addTo(entry.totals, currency, amount);
        byCategory.set(expense.category, entry);
      }

      // ---- Trend ----
      const series = new Map(buckets.map((bucket) => [bucket.key, { ...bucket, revenue: 0, expense: 0 }]));

      for (const order of orders) {
        if (order.payment.status !== 'paid') continue;
        if (String(order.payment.currency || base).toUpperCase() !== base) continue;
        const point = series.get(L.bucketKeyFor(orderPaidDate(order), grain));
        if (point) point.revenue += Number(order.payment.amount) || 0;
      }
      for (const sale of sales) {
        if (String(sale.currency || base).toUpperCase() !== base) continue;
        const point = series.get(L.bucketKeyFor(sale.paidAt, grain));
        if (point) point.revenue += Number(sale.total) || 0;
      }

      for (const expense of expenses) {
        if (expense.status === 'cancelled') continue;
        if (String(expense.currency || base).toUpperCase() !== base) continue;
        const point = series.get(L.bucketKeyFor(expense.incurredOn, grain));
        if (point) point.expense += Number(expense.amount) || 0;
      }

      // ---- Assets ----
      const assetCost = {};
      const assetBook = {};
      let serviceDue = 0;
      const now = new Date();

      for (const asset of assets) {
        const currency = String(asset.currency || base).toUpperCase();
        const value = L.depreciate(asset, now);
        L.addTo(assetCost, currency, value.cost);
        L.addTo(assetBook, currency, value.book_value);
        if (asset.nextServiceDue && new Date(asset.nextServiceDue) <= now) serviceDue += 1;
      }

      // Net is base-currency only and says so. Netting a GBP sale against a PKR
      // bill would be a made-up number, and this system holds no exchange rate.
      const netBase = L.round((revenue[base] || 0) - (refunds[base] || 0) - (spendPaid[base] || 0));
      const grossBase = L.round((revenue[base] || 0) - (refunds[base] || 0));

      return res.json({
        success: true,
        base_currency: base,
        currency_notice: await L.currencyNotice(),
        range: { from: range.from, to: range.to, label: range.label, today: range.today },
        timezone: T.TIMEZONE,

        income: {
          ...L.presentTotals(revenue, base),
          refunds: L.presentTotals(refunds, base),
          orders: orders.filter((order) => order.payment.status === 'paid').length,
          // Named so nobody reads this as the gym's total takings.
          source: 'Membership and package sales recorded in this system'
        },

        spending: {
          paid: L.presentTotals(spendPaid, base),
          pending: L.presentTotals(spendPending, base),
          entries: expenses.length,
          by_category: [...byCategory.values()]
            .map((entry) => ({ ...entry, totals: L.presentTotals(entry.totals, base) }))
            .sort((a, b) => b.totals.base_amount - a.totals.base_amount)
        },

        payroll: {
          ...L.presentTotals(payroll.totals, base),
          salaried: payroll.salaried,
          hourly: payroll.hourly,
          headcount: payroll.headcount,
          hours: payroll.hours,
          people: payroll.people.slice(0, 10),
          // Active trainers with no staff account, and therefore no pay rate.
          // Their hours are recorded but cannot be costed, so the screen can
          // warn that this total does not cover them.
          unlinked_trainers: payroll.unlinked_trainers,
          // A commitment, not a payment: it is what the roster and the rates
          // add up to, and it is only an actual outflow once it is entered as
          // a salaries expense.
          note: 'Calculated from staff pay rates and hours worked, not from recorded payments'
        },

        result: {
          currency: base,
          gross_income: grossBase,
          expenses: L.round(spendPaid[base] || 0),
          net: netBase,
          margin: grossBase ? Math.round((netBase / grossBase) * 1000) / 10 : null,
          mixed_currencies: L.presentTotals(revenue, base).mixed || L.presentTotals(spendPaid, base).mixed
        },

        assets: {
          count: assets.length,
          cost: L.presentTotals(assetCost, base),
          book_value: L.presentTotals(assetBook, base),
          service_due: serviceDue
        },

        trend: {
          grain,
          currency: base,
          points: [...series.values()].map((point) => ({
            key: point.key,
            label: point.label,
            revenue: L.round(point.revenue),
            expense: L.round(point.expense),
            net: L.round(point.revenue - point.expense)
          }))
        }
      });
    } catch (error) {
      console.error('[accounts] overview failed:', error);
      return res.status(500).json({ message: 'Could not build the accounts overview', error: error.message });
    }
  },

  // -------------------------------------------------------------------------
  // GET /api/accounts/sales
  //
  // Every membership sale in the period, with the two splits a gym owner
  // actually asks for: which package sold, and how much of it was new business
  // rather than the same members renewing.
  // -------------------------------------------------------------------------
  sales: async (req, res) => {
    try {
      const range = L.readRange(req.query);
      const base = await L.baseCurrency();

      const filter = {
        $expr: {
          $and: [{ $gte: [paidAtExpr(), range.start] }, { $lt: [paidAtExpr(), range.end] }]
        }
      };

      const status = String(req.query.status || 'paid');
      filter['payment.status'] = status === 'all' ? { $in: ['paid', 'refunded', 'pending', 'failed'] } : status;

      if (req.query.method && req.query.method !== 'all') filter['payment.method'] = String(req.query.method);
      if (req.query.package && req.query.package !== 'all') {
        filter['packageDetails.name'] = String(req.query.package);
      }

      const term = String(req.query.q || '').trim();
      if (term) {
        const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ orderNumber: rx }, { 'customerInfo.fullName': rx }, { 'customerInfo.email': rx }];
      }

      const orders = await PackageOrder.find(filter)
        .select('orderNumber userId customerInfo packageDetails payment subscription status createdAt')
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();

      // New vs renewal: was there an earlier paid order from the same buyer?
      // Answered in one query over the whole history rather than per row.
      const buyers = [...new Set(orders.map((order) => String(order.userId || (order.customerInfo || {}).email || '')))]
        .filter(Boolean);

      const firstOrders = new Map();
      if (buyers.length) {
        const history = await PackageOrder.find({
          'payment.status': 'paid',
          $or: [
            { userId: { $in: orders.map((order) => order.userId).filter(Boolean) } },
            { 'customerInfo.email': { $in: orders.map((order) => (order.customerInfo || {}).email).filter(Boolean) } }
          ]
        })
          .select('userId customerInfo.email payment.paidAt createdAt')
          .lean();

        for (const row of history) {
          for (const key of [row.userId ? String(row.userId) : null, (row.customerInfo || {}).email || null]) {
            if (!key) continue;
            const at = new Date(orderPaidDate(row)).getTime();
            if (!firstOrders.has(key) || at < firstOrders.get(key)) firstOrders.set(key, at);
          }
        }
      }

      const totals = {};
      const refunds = {};
      const byPackage = new Map();
      const byMethod = new Map();
      let newBusiness = 0;
      let renewals = 0;

      const rows = orders.map((order) => {
        const currency = String(order.payment.currency || base).toUpperCase();
        const amount = Number(order.payment.amount) || 0;
        const paidAt = orderPaidDate(order);

        const keys = [order.userId ? String(order.userId) : null, (order.customerInfo || {}).email || null].filter(Boolean);
        const firstAt = keys.map((key) => firstOrders.get(key)).filter(Boolean).sort()[0];
        const isNew = !firstAt || Math.abs(new Date(paidAt).getTime() - firstAt) < 1000;

        if (order.payment.status === 'paid') {
          L.addTo(totals, currency, amount);
          if (isNew) newBusiness += 1;
          else renewals += 1;

          const packageName = (order.packageDetails && order.packageDetails.name) || 'Unknown';
          const packageEntry = byPackage.get(packageName) || { name: packageName, count: 0, totals: {} };
          packageEntry.count += 1;
          L.addTo(packageEntry.totals, currency, amount);
          byPackage.set(packageName, packageEntry);

          const method = order.payment.method || 'other';
          const methodEntry = byMethod.get(method) || { method, count: 0, totals: {} };
          methodEntry.count += 1;
          L.addTo(methodEntry.totals, currency, amount);
          byMethod.set(method, methodEntry);
        } else if (order.payment.status === 'refunded') {
          L.addTo(refunds, currency, amount);
        }

        return {
          id: String(order._id),
          order_number: order.orderNumber,
          customer: (order.customerInfo || {}).fullName || '',
          email: (order.customerInfo || {}).email || '',
          package: (order.packageDetails && order.packageDetails.name) || '',
          amount: L.round(amount),
          currency,
          method: order.payment.method || '',
          payment_status: order.payment.status,
          order_status: order.status,
          kind: isNew ? 'new' : 'renewal',
          paid_at: paidAt,
          paid_label: paidAt ? `${T.dateLabel(paidAt)} · ${T.timeLabel(paidAt)}` : null,
          starts_label: order.subscription && order.subscription.startDate ? T.dateLabel(order.subscription.startDate) : null,
          ends_label: order.subscription && order.subscription.endDate ? T.dateLabel(order.subscription.endDate) : null
        };
      });

      const paidRows = rows.filter((row) => row.payment_status === 'paid');
      const baseTotal = totals[base] || 0;

      return res.json({
        success: true,
        base_currency: base,
        currency_notice: await L.currencyNotice(),
        range: { from: range.from, to: range.to, label: range.label, today: range.today },
        summary: {
          ...L.presentTotals(totals, base),
          refunds: L.presentTotals(refunds, base),
          orders: paidRows.length,
          new_business: newBusiness,
          renewals,
          average_sale: paidRows.length ? L.round(baseTotal / paidRows.length) : 0,
          by_package: [...byPackage.values()]
            .map((entry) => ({ ...entry, totals: L.presentTotals(entry.totals, base) }))
            .sort((a, b) => b.totals.base_amount - a.totals.base_amount),
          by_method: [...byMethod.values()]
            .map((entry) => ({ ...entry, totals: L.presentTotals(entry.totals, base) }))
            .sort((a, b) => b.totals.base_amount - a.totals.base_amount)
        },
        packages: [...new Set(rows.map((row) => row.package).filter(Boolean))].sort(),
        sales: rows
      });
    } catch (error) {
      console.error('[accounts] sales failed:', error);
      return res.status(500).json({ message: 'Could not build the sales report', error: error.message });
    }
  }
};
