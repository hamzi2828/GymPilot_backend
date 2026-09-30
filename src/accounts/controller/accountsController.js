// src/accounts/controller/accountsController.js
//
// The two reads that answer "how is the gym doing": the overview (money in,
// money out, what is left -- the profit and loss, line by line, in
// services/profitAndLoss.js) and the sales report behind the money-in half.
//
// Income here is membership sales and shop (POS) takings, because that is
// the income this system records. A gym also takes day passes and PT paid at
// the desk; until those are sold through this system they are not in these
// numbers, and the response says so rather than quietly under-reporting.

const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Expense = require('../models/expenseModel');
const Asset = require('../models/assetModel');
const User = require('../../models/user');
const Trainer = require('../../gymfolio/models/trainerModel');
const Attendance = require('../../attendance/models/attendanceModel');
const L = require('../services/ledger');
const categories = require('../services/categories');
const pnl = require('../services/profitAndLoss');
const T = require('../../attendance/services/timeUtils');

// The sales list shows at most this many payments; the totals above it are
// always worked out over the whole period.
const SALES_ROW_LIMIT = 500;

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
  const [linkedTrainers, unlinkedTrainers, trainerCurrency] = await Promise.all([
    Trainer.find({ isActive: true, userId: { $ne: null } })
      .select('userId')
      .lean(),
    // Trainers with no staff account are costed at the salary on their
    // trainer record, in the gym's currency (the one new records are written
    // in). Those with none set are counted, so the screen can say the figure
    // leaves them out rather than quietly omitting the coaching staff.
    Trainer.find({ isActive: true, userId: null })
      .select('name role +salary +salaryCycle')
      .lean(),
    L.recordCurrency()
  ]);
  const salariedTrainers = unlinkedTrainers.filter((trainer) => trainer.salary !== null && trainer.salary !== undefined);
  const unlinkedTrainerCount = unlinkedTrainers.length - salariedTrainers.length;

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
      // Salaries are quoted per cycle, so a range that is not exactly one
      // cycle is pro-rated by its actual days (ledger.salaryForDays) -- the
      // same arithmetic a payslip uses.
      cost = L.salaryForDays(payroll.salary, payroll.cycle, range.from, range.to);
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

  // The same pro-rating for a trainer's own salary. 0 is commission only.
  for (const trainer of salariedTrainers) {
    const cost = L.salaryForDays(trainer.salary, trainer.salaryCycle, range.from, range.to);
    if (!cost) continue;
    salaried += cost;
    L.addTo(totals, trainerCurrency, cost);
    people.push({
      id: String(trainer._id),
      name: trainer.name,
      job_title: trainer.role || 'Trainer',
      basis: 'salaried',
      currency: trainerCurrency,
      hours: null,
      cost: L.round(cost),
      trainer: true
    });
  }

  return {
    totals,
    salaried: L.round(salaried),
    hourly: L.round(hourly),
    headcount: staff.length + salariedTrainers.length,
    hours: Math.round((totalMinutes / 60) * 10) / 10,
    people: people.sort((a, b) => b.cost - a.cost),
    // Active trainers with no staff account and no salary on their trainer
    // record. They punch in and out like everyone else, but nothing here
    // knows what they are paid, so they are not in the total above.
    // Surfaced rather than swallowed.
    unlinked_trainers: unlinkedTrainerCount
  };
}

// ---------------------------------------------------------------------------
// Sales search
//
// The desk looks a sale up by whatever the member has to hand: the order
// number, their name or email, their phone, or the member ID on their card
// ("GP-0184", User.memberCode). The phone and the member ID of an account
// live on the account, not the order, so those find the people first and
// then their orders.
// ---------------------------------------------------------------------------

// Most people this search will match on their account before it gives up on
// being a lookup and becomes a scan.
const SEARCH_PEOPLE_LIMIT = 500;

// A phone number is typed however the person remembers it -- "0300 1234567",
// "0300-1234567" -- so a term that looks like one matches its digits with
// anything between them.
function phonePattern(term) {
  if (!/^[\d\s+().-]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, '');
  return digits.length >= 4 ? new RegExp(digits.split('').join('\\D*')) : null;
}

/** The `$or` that narrows the orders to a search term. */
async function salesSearch(term) {
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const phoneRx = phonePattern(term);
  const or = [{ orderNumber: rx }, { 'customerInfo.fullName': rx }, { 'customerInfo.email': rx }, { 'customerInfo.phone': rx }];
  if (phoneRx) or.push({ 'customerInfo.phone': phoneRx });

  const people = await User.find({ $or: [{ memberCode: rx }, { phone: rx }, ...(phoneRx ? [{ phone: phoneRx }] : [])] })
    .select('_id')
    .limit(SEARCH_PEOPLE_LIMIT)
    .lean();
  if (people.length) or.push({ userId: { $in: people.map((person) => person._id) } });
  return or;
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
      const [payments, refundRows, expenses, assets, payroll, sales, expenseHeads] = await Promise.all([
        // Every membership payment received in the period -- first payments
        // and renewals -- including those on orders refunded since: the
        // refund is counted on its own, below.
        PackageOrder.aggregate(L.membershipPaymentStages(range)),
        PackageOrder.aggregate(L.membershipRefundStages(range)),

        Expense.find({
          incurredOn: { $gte: range.start, $lt: range.end },
          status: { $ne: 'cancelled' }
        }).lean(),

        Asset.find({ status: { $nin: ['sold', 'lost'] } }).lean(),

        payrollFor(range),

        Sale.find({ status: 'paid', paidAt: { $gte: range.start, $lt: range.end } })
          .select('total currency paidAt paymentMethod items')
          .lean()
          .catch(() => []),

        // The gym's own expense heads, to name them in the breakdown.
        categories.headsFor('expense')
      ]);

      // The profit and loss: every line, each cost counted once.
      const profit = pnl.build({
        base,
        payments,
        refunds: refundRows,
        sales,
        expenses,
        extra: await pnl.gather(range, expenses)
      });

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

      for (const payment of payments) {
        const currency = String(payment.currency || base).toUpperCase();
        const amount = Number(payment.amount) || 0;

        L.addTo(revenue, currency, amount);

        const packageName = payment.packageName || 'Unknown';
        const packageEntry = byPackage.get(packageName) || { name: packageName, count: 0, totals: {} };
        packageEntry.count += 1;
        L.addTo(packageEntry.totals, currency, amount);
        byPackage.set(packageName, packageEntry);

        const method = (payment.method || 'other');
        const methodEntry = byMethod.get(method) || { method, count: 0, totals: {} };
        methodEntry.count += 1;
        L.addTo(methodEntry.totals, currency, amount);
        byMethod.set(method, methodEntry);
      }

      // Money given back in the period, taken off once.
      for (const row of refundRows) {
        L.addTo(refunds, String(row.currency || base).toUpperCase(), Number(row.amount) || 0);
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
          label: expenseHeads.labelOf(expense.category),
          count: 0,
          totals: {}
        };
        entry.count += 1;
        L.addTo(entry.totals, currency, amount);
        byCategory.set(expense.category, entry);
      }

      // ---- Trend ----
      // The profit and loss's own amounts, by when each happened, so the
      // chart's money in and out add up to the lines above it.
      const series = new Map(buckets.map((bucket) => [bucket.key, { ...bucket, revenue: 0, expense: 0 }]));
      const bucketOf = (at) => (typeof at === 'string' ? (grain === 'day' ? at : at.slice(0, 7)) : L.bucketKeyFor(at, grain));

      for (const item of profit.items.revenue) {
        const point = series.get(bucketOf(item.at));
        if (point) point.revenue += item.amount;
      }
      for (const item of profit.items.outflow) {
        const point = series.get(bucketOf(item.at));
        if (point) point.expense += item.amount;
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

      return res.json({
        success: true,
        base_currency: base,
        currency_notice: await L.currencyNotice(),
        range: { from: range.from, to: range.to, label: range.label, today: range.today },
        timezone: T.TIMEZONE,

        income: {
          ...L.presentTotals(revenue, base),
          refunds: L.presentTotals(refunds, base),
          // The shop's part of the figure above.
          shop: L.presentTotals(shop, base),
          // Payments received: a renewal is a sale of its own.
          orders: payments.length,
          // Named so nobody reads this as the gym's total takings.
          source: 'Membership, package and shop sales recorded in this system'
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
          // add up to, and it is only an actual outflow once it is paid -- on
          // a payslip (the profit and loss's salaries line) or as an expense.
          note: 'Calculated from staff pay rates and hours worked, not from recorded payments'
        },

        // The profit and loss, line by line (services/profitAndLoss.js).
        profit_and_loss: {
          currency: profit.currency,
          revenue: profit.revenue,
          outflow: profit.outflow,
          total_revenue: profit.total_revenue,
          total_outflow: profit.total_outflow,
          net_profit: profit.net_profit,
          margin: profit.margin,
          mixed_currencies: profit.mixed_currencies,
          set_aside: profit.set_aside
        },

        // The bottom line: revenue less refunds, less every outflow line.
        // Base currency only, and says so -- netting a GBP sale against a PKR
        // bill would be a made-up number, and this system holds no exchange
        // rate.
        result: {
          currency: base,
          gross_income: profit.total_revenue,
          expenses: profit.total_outflow,
          net: profit.net_profit,
          margin: profit.margin,
          mixed_currencies: profit.mixed_currencies
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

      const status = String(req.query.status || 'paid');
      const statuses = status === 'all' ? ['paid', 'refunded', 'pending', 'failed'] : [status];

      const match = {};
      // The method is each payment's own -- a part paid another way than
      // the order says its own, as by_method totals it -- so it is matched
      // on the payment rows below, not on the order. A refund goes back the
      // way the order was paid.
      const method = req.query.method && req.query.method !== 'all' ? String(req.query.method) : null;
      if (req.query.package && req.query.package !== 'all') {
        match['packageDetails.name'] = String(req.query.package);
      }

      const term = String(req.query.q || '').trim();
      if (term) match.$or = await salesSearch(term);

      // One row per payment -- a renewal is a sale in the period it was paid
      // -- and every total worked out over the whole period in the database,
      // not from the rows the list happens to show.
      const money = { paymentStatus: { $in: L.MONEY_STATUSES } };
      const sumUp = { total: { $sum: '$amount' }, n: { $sum: 1 } };

      const [[facets], refundRows] = await Promise.all([
        PackageOrder.aggregate([
          ...L.membershipPaymentStages(range, match, { statuses }),
          ...(method ? [{ $match: { method } }] : []),
          {
            $facet: {
              rows: [{ $sort: { at: -1, _id: -1 } }, { $limit: SALES_ROW_LIMIT }],
              byCurrency: [{ $match: money }, { $group: { _id: '$currency', ...sumUp } }],
              byPackage: [{ $match: money }, { $group: { _id: { name: '$packageName', currency: '$currency' }, ...sumUp } }],
              byMethod: [{ $match: money }, { $group: { _id: { method: '$method', currency: '$currency' }, ...sumUp } }],
              renewalPayments: [{ $match: { ...money, kind: 'renewal' } }, { $count: 'n' }],
              // First payments per buyer: at most one of them can be the
              // buyer's first purchase ever.
              buyers: [
                { $match: { ...money, kind: 'initial' } },
                { $group: { _id: { userId: '$userId', email: '$email' }, first: { $min: '$at' }, n: { $sum: 1 } } }
              ],
              packages: [{ $group: { _id: '$packageName' } }]
            }
          }
        ]),
        // Refunds given in the period, when the filter lets refunded orders in.
        statuses.includes('refunded')
          ? PackageOrder.aggregate([
              ...L.membershipRefundStages(range, method ? { ...match, 'payment.method': method } : match),
              { $group: { _id: '$currency', total: { $sum: '$amount' } } }
            ])
          : []
      ]);

      // New vs renewal: a renewal payment is a renewal; a first payment is new
      // business only when there was no earlier purchase from the same buyer.
      // Answered in one query over the whole history rather than per row.
      const userIds = new Map();
      const emails = new Set();
      for (const who of [...facets.buyers.map((buyer) => buyer._id), ...facets.rows]) {
        if (who.userId) userIds.set(String(who.userId), who.userId);
        if (who.email) emails.add(who.email);
      }

      const firstOrders = new Map();
      if (userIds.size || emails.size) {
        const history = await PackageOrder.aggregate([
          {
            $match: {
              'payment.status': { $in: L.MONEY_STATUSES },
              $or: [{ userId: { $in: [...userIds.values()] } }, { 'customerInfo.email': { $in: [...emails] } }]
            }
          },
          { $group: { _id: { userId: '$userId', email: '$customerInfo.email' }, at: { $min: L.firstPaymentAtExpr() } } }
        ]);

        for (const row of history) {
          const at = new Date(row.at).getTime();
          for (const key of [row._id.userId ? String(row._id.userId) : null, row._id.email || null]) {
            if (!key) continue;
            if (!firstOrders.has(key) || at < firstOrders.get(key)) firstOrders.set(key, at);
          }
        }
      }

      const isFirstPurchase = (userId, email, at) => {
        const firstAt = [userId ? String(userId) : null, email || null]
          .filter(Boolean)
          .map((key) => firstOrders.get(key))
          .filter(Boolean)
          .sort((a, b) => a - b)[0];
        return !firstAt || Math.abs(new Date(at).getTime() - firstAt) < 1000;
      };

      let newBusiness = 0;
      let renewals = (facets.renewalPayments[0] && facets.renewalPayments[0].n) || 0;
      for (const buyer of facets.buyers) {
        const isNew = isFirstPurchase(buyer._id.userId, buyer._id.email, buyer.first);
        if (isNew) newBusiness += 1;
        renewals += buyer.n - (isNew ? 1 : 0);
      }

      const totals = {};
      let payments = 0;
      let basePayments = 0;
      for (const row of facets.byCurrency) {
        const currency = String(row._id || base).toUpperCase();
        L.addTo(totals, currency, row.total);
        payments += row.n;
        if (currency === base) basePayments += row.n;
      }

      const refunds = {};
      for (const row of refundRows) L.addTo(refunds, String(row._id || base).toUpperCase(), row.total);

      const byPackage = new Map();
      for (const row of facets.byPackage) {
        const packageName = row._id.name || 'Unknown';
        const packageEntry = byPackage.get(packageName) || { name: packageName, count: 0, totals: {} };
        packageEntry.count += row.n;
        L.addTo(packageEntry.totals, String(row._id.currency || base).toUpperCase(), row.total);
        byPackage.set(packageName, packageEntry);
      }

      const byMethod = new Map();
      for (const row of facets.byMethod) {
        const method = row._id.method || 'other';
        const methodEntry = byMethod.get(method) || { method, count: 0, totals: {} };
        methodEntry.count += row.n;
        L.addTo(methodEntry.totals, String(row._id.currency || base).toUpperCase(), row.total);
        byMethod.set(method, methodEntry);
      }

      const rows = facets.rows.map((payment) => {
        const paidAt = payment.at;
        const isNew = payment.kind === 'initial' && isFirstPurchase(payment.userId, payment.email, paidAt);

        return {
          // A renewal shares its order with the first payment, so it needs
          // an id of its own to be a row of its own.
          id: payment.kind === 'renewal' ? `${payment._id}-${new Date(paidAt).getTime()}` : String(payment._id),
          order_number: payment.orderNumber,
          customer: payment.customer || '',
          email: payment.email || '',
          package: payment.packageName || '',
          amount: L.round(payment.amount),
          currency: String(payment.currency || base).toUpperCase(),
          method: payment.method || '',
          payment_status: payment.paymentStatus,
          order_status: payment.orderStatus,
          kind: isNew ? 'new' : 'renewal',
          paid_at: paidAt,
          paid_label: paidAt ? `${T.dateLabel(paidAt)} · ${T.timeLabel(paidAt)}` : null,
          starts_label: payment.startDate ? T.dateLabel(payment.startDate) : null,
          ends_label: payment.endDate ? T.dateLabel(payment.endDate) : null
        };
      });

      return res.json({
        success: true,
        base_currency: base,
        currency_notice: await L.currencyNotice(),
        range: { from: range.from, to: range.to, label: range.label, today: range.today },
        summary: {
          ...L.presentTotals(totals, base),
          refunds: L.presentTotals(refunds, base),
          orders: payments,
          new_business: newBusiness,
          renewals,
          average_sale: basePayments ? L.round((totals[base] || 0) / basePayments) : 0,
          by_package: [...byPackage.values()]
            .map((entry) => ({ ...entry, totals: L.presentTotals(entry.totals, base) }))
            .sort((a, b) => b.totals.base_amount - a.totals.base_amount),
          by_method: [...byMethod.values()]
            .map((entry) => ({ ...entry, totals: L.presentTotals(entry.totals, base) }))
            .sort((a, b) => b.totals.base_amount - a.totals.base_amount)
        },
        packages: facets.packages.map((row) => row._id).filter(Boolean).sort(),
        sales: rows
      });
    } catch (error) {
      console.error('[accounts] sales failed:', error);
      return res.status(500).json({ message: 'Could not build the sales report', error: error.message });
    }
  }
};
