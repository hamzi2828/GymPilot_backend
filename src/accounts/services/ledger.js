// src/accounts/services/ledger.js
//
// The arithmetic the accounts screens share: what period are we looking at,
// what currency is this gym's, and what is a five-year-old treadmill worth.
//
// One rule runs through all of it: money is NEVER added across currencies.
// There is no exchange rate in this system, so a report that summed GBP
// package sales into a PKR expense total would be inventing a number. Totals
// are therefore kept per currency and the caller decides how to present them.

const Settings = require('../../models/settings');
const PackageOrder = require('../../gymfolio/models/packageOrderModel');
// The gym's local day, borrowed rather than reimplemented: "today's revenue"
// and "today's attendance" must agree about when today started.
const T = require('../../attendance/services/timeUtils');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Local time
// ---------------------------------------------------------------------------

// The UTC instant at which a given wall-clock time began in the gym's timezone.
// Guesses by reading the local time as UTC, then corrects by however far the
// gym clock actually reads from that -- which is the zone's offset, DST and
// all, without hardcoding one.
function localInstant(dateKey, hour = 0, minute = 0, second = 0, ms = 0) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hour, minute, second, ms));

  const parts = T.localParts(guess);
  let drift = parts.hour * 60 + parts.minute - (hour * 60 + minute);
  if (drift > 720) drift -= 1440;
  if (drift < -720) drift += 1440;

  return new Date(guess.getTime() - drift * 60000);
}

function startOfLocalDay(dateKey) {
  return localInstant(dateKey, 0, 0, 0, 0);
}

// Exclusive: the instant the NEXT local day begins. Comparing with $lt against
// this is safer than $lte against 23:59:59.999, which silently drops anything
// stamped in the final millisecond.
function endOfLocalDay(dateKey) {
  return localInstant(T.shiftDateKey(dateKey, 1), 0, 0, 0, 0);
}

// Defaults to the current month, which is the period an owner means when they
// open an accounts screen without saying otherwise.
function readRange(query = {}) {
  const today = T.dateKey();
  let to = DATE_KEY.test(String(query.to || '')) ? String(query.to) : today;
  let from = DATE_KEY.test(String(query.from || '')) ? String(query.from) : `${to.slice(0, 7)}-01`;

  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }

  return {
    from,
    to,
    start: startOfLocalDay(from),
    end: endOfLocalDay(to),
    label: rangeLabel(from, to),
    today
  };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function rangeLabel(from, to) {
  if (from === to) return T.dateLabelForKey(from);

  // A whole calendar month reads better as "August 2026" than as its two ends.
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  if (fy === ty && fm === tm && fd === 1 && Number(to.slice(8)) === lastDay) {
    return `${MONTH_NAMES[fm - 1]} ${fy}`;
  }

  return `${T.dateLabelForKey(from)} — ${T.dateLabelForKey(to)}`;
}

// ---------------------------------------------------------------------------
// Buckets for the trend
//
// A three-week range wants days; a two-year range wants months. Choosing by
// span rather than by a query parameter means the chart is never a wall of
// 700 unreadable columns because somebody forgot to pass one.
// ---------------------------------------------------------------------------

function buildBuckets(from, to) {
  const spanDays = Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / DAY_MS) + 1;
  const grain = spanDays <= 62 ? 'day' : 'month';
  const buckets = [];

  if (grain === 'day') {
    let key = from;
    while (key <= to) {
      buckets.push({ key, label: T.dateLabelForKey(key).slice(0, 6) });
      key = T.shiftDateKey(key, 1);
    }
    return { grain, buckets };
  }

  let [year, month] = from.split('-').map(Number);
  const [endYear, endMonth] = to.split('-').map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    buckets.push({ key, label: `${MONTH_NAMES[month - 1]} ${String(year).slice(2)}` });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return { grain, buckets };
}

// Which bucket a moment falls in, decided in the gym's timezone rather than
// the server's, so a late-evening sale is not filed under tomorrow.
function bucketKeyFor(date, grain) {
  const key = T.dateKey(date);
  return grain === 'day' ? key : key.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const { tenantKey } = require('../../platform/tenantContext');

// Per gym: each reports in its own currency.
const currencyCaches = new Map(); // tenantKey -> { at, value }

// Which currency to report in.
//
// The setting is the intended answer -- but a setting is a claim, and the
// package prices are a fact. When they disagree AND nothing has ever been taken
// in the configured currency, reporting in it would put a confident zero
// against every figure while the money sits one row down under another code.
// So the money wins, and the disagreement is surfaced rather than buried:
// see currencyNotice(), which the screens render as a banner pointing at the
// setting that needs fixing.
async function resolveCurrency() {
  const cacheKey = tenantKey();
  const currencyCache = currencyCaches.get(cacheKey) || { at: 0, value: null };
  if (currencyCache.value && Date.now() - currencyCache.at < 60000) return currencyCache.value;

  const [settings, byCurrency] = await Promise.all([
    Settings.findOne().select('currency').lean(),
    PackageOrder.aggregate([
      { $match: { 'payment.status': 'paid' } },
      { $group: { _id: '$payment.currency', total: { $sum: '$payment.amount' } } },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ])
  ]);

  const configured = String(
    (settings && settings.currency) || process.env.ACCOUNTS_CURRENCY || 'PKR'
  ).toUpperCase();

  const takings = byCurrency
    .filter((row) => row._id && row.total > 0)
    .map((row) => ({ currency: String(row._id).toUpperCase(), total: row.total }));

  const configuredHasMoney = takings.some((row) => row.currency === configured);
  const dominant = takings.length ? takings[0].currency : null;

  const value = {
    configured,
    // Whether the gym has actually chosen one, as opposed to the fallback.
    chosen: !!(settings && settings.currency),
    effective: !configuredHasMoney && dominant ? dominant : configured,
    dominant,
    mismatch: !!dominant && !configuredHasMoney && dominant !== configured
  };

  currencyCaches.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function baseCurrency() {
  return (await resolveCurrency()).effective;
}

// The currency a NEW sale, expense or asset is written in: the one set in
// Settings. baseCurrency() may be reading history in another currency while
// the setting disagrees -- stamping new rows with that would keep the old
// currency alive after the owner fixed the setting. The history-based answer
// is only the fallback for a gym that has never chosen one.
async function recordCurrency() {
  const resolved = await resolveCurrency();
  return resolved.chosen ? resolved.configured : resolved.effective;
}

// Null when there is nothing to say, so a caller can spread it into a response
// without a branch and the UI can render a banner only when one exists.
async function currencyNotice() {
  const resolved = await resolveCurrency();
  if (!resolved.mismatch) return null;

  return {
    configured: resolved.configured,
    reporting_in: resolved.effective,
    message:
      `Reporting in ${resolved.effective} because that is what the gym's sales are recorded in. ` +
      `Settings says ${resolved.configured}, which has no transactions against it — update it under ` +
      `Settings so the two agree.`
  };
}

// Accumulates {CUR: amount} maps. Kept as an object rather than a single
// number precisely so a caller cannot accidentally add pounds to rupees.
function addTo(totals, currency, amount) {
  const key = String(currency || '').toUpperCase() || 'UNKNOWN';
  totals[key] = (totals[key] || 0) + (Number(amount) || 0);
  return totals;
}

function sumOf(totals) {
  return Object.values(totals).reduce((sum, value) => sum + value, 0);
}

// Presents a per-currency map as a list, base currency first, plus the single
// figure a headline tile can show honestly: the base currency's own total.
function presentTotals(totals, base) {
  const entries = Object.entries(totals)
    .filter(([, amount]) => amount !== 0)
    .sort((a, b) => (a[0] === base ? -1 : b[0] === base ? 1 : b[1] - a[1]));

  // What a single tile should print. Normally the base currency -- but a figure
  // whose money is ENTIRELY in another currency (staff paid in rupees while the
  // gym reports in pounds) would otherwise headline a confident zero over a real
  // number. Showing it in its own currency, labelled, beats showing nothing.
  const baseAmount = round(totals[base] || 0);
  const fallback = entries.find(([currency]) => currency !== base);

  return {
    by_currency: entries.map(([currency, amount]) => ({ currency, amount: round(amount) })),
    base_currency: base,
    base_amount: baseAmount,
    headline_amount: baseAmount || (fallback ? round(fallback[1]) : 0),
    headline_currency: baseAmount || !fallback ? base : fallback[0],
    // True when there is money in this figure the headline does not show.
    mixed: entries.some(([currency]) => currency !== base)
  };
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Membership money
//
// An order is not one payment. A recurring membership is paid at checkout and
// again at every renewal, and each payment belongs to the period the money
// arrived in: payment.paidAt is the first payment and never moves, and every
// renewal is its own entry in subscription.renewals with its amount and
// currency. A refund is money going back out on the day it was given --
// subtracted once, in that period -- while the payment it returned stays
// counted where it was received. Accounts, the dashboard and the reports all
// read membership money through the two pipelines below, so they cannot
// disagree about that rule.
// ---------------------------------------------------------------------------

// The payment statuses that mean money came in. A refunded order was paid
// first; its refund is counted separately.
const MONEY_STATUSES = ['paid', 'refunded'];

// Renewals used to overwrite payment.paidAt with the latest charge, so on
// those older orders paidAt is really a renewal -- one that is also in
// renewals[]. They are recognised by paidAt landing within a minute of one of
// their renewals (a real first payment never does: the shortest billing
// interval is a day) and their first payment is read from createdAt instead,
// the moment checkout opened and the closest record left of it.
const OVERWRITTEN_WITHIN_MS = 60000;

function firstPaymentAtExpr() {
  const paidAt = { $ifNull: ['$payment.paidAt', '$createdAt'] };
  return {
    $cond: [
      {
        $anyElementTrue: [
          {
            $map: {
              input: { $ifNull: ['$subscription.renewals', []] },
              as: 'renewal',
              in: {
                $and: [
                  { $gt: ['$$renewal.at', null] },
                  { $lt: [{ $abs: { $subtract: ['$$renewal.at', paidAt] } }, OVERWRITTEN_WITHIN_MS] }
                ]
              }
            }
          }
        ]
      },
      '$createdAt',
      paidAt
    ]
  };
}

function inRangeOf(range) {
  return { $gte: range.start, $lt: range.end };
}

// The order's own payment -- as opposed to its renewals -- as entries.
//
// Paid in parts (payment.installments, gymfolio/services/orderMoney.js),
// each part is a payment of its own on the day it arrived: the first is the
// 'initial' one, the rest 'installment'. Each carries its own admission and
// trainer-fee shares and, when it was paid another way than the order, its
// own method. Otherwise the order was paid at once: one 'initial' entry for
// what was taken -- payment.amountPaid when the order says (it may be less
// than the amount, even nothing yet), else all of it, as on every order
// from before part payments -- its shares allocated admission first.
function ownPaymentEntries() {
  const parts = { $ifNull: ['$payment.installments', []] };
  const joiningFee = { $ifNull: ['$payment.joiningFee', 0] };
  const trainerFee = { $ifNull: ['$payment.trainerFee', 0] };
  const taken = { $ifNull: ['$payment.amountPaid', '$payment.amount'] };
  const admission = { $min: [joiningFee, taken] };
  const methodOf = (value) => ({ $cond: [{ $gt: [{ $strLenCP: { $ifNull: [value, ''] } }, 0] }, value, '$payment.method'] });

  const whole = {
    kind: 'initial',
    at: firstPaymentAtExpr(),
    amount: taken,
    admission,
    trainerFee: { $min: [trainerFee, { $max: [0, { $subtract: [taken, admission] }] }] },
    method: '$payment.method',
    currency: '$payment.currency'
  };

  const inParts = {
    $map: {
      input: { $range: [0, { $size: parts }] },
      as: 'i',
      in: {
        $let: {
          vars: { part: { $arrayElemAt: [parts, '$$i'] } },
          in: {
            kind: { $cond: [{ $eq: ['$$i', 0] }, 'initial', 'installment'] },
            at: '$$part.at',
            amount: { $ifNull: ['$$part.amount', 0] },
            admission: { $ifNull: ['$$part.joiningFee', 0] },
            trainerFee: { $ifNull: ['$$part.trainerFee', 0] },
            method: methodOf('$$part.method'),
            currency: '$payment.currency'
          }
        }
      }
    }
  };

  return { $cond: [{ $gt: [{ $size: parts }, 0] }, inParts, [whole]] };
}

/**
 * Aggregation stages that turn orders into the payments received in a range,
 * one document per payment: the first one, each later part of an order paid
 * in parts, and each renewal.
 *
 * Output: { _id (order), orderNumber, userId, customer, email, packageName,
 * method, paymentStatus, orderStatus, startDate, endDate, kind ('initial' |
 * 'installment' | 'renewal'), at, amount, admission, trainerFee, membership,
 * currency (upper case) }
 *
 * `amount` is the whole payment; `admission` and `trainerFee` are the
 * joining fee and personal trainer's fee inside it, and `membership` the
 * rest (amount - admission - trainerFee). A renewal carries neither fee.
 * `method` is how THIS payment was made: a part paid another way than the
 * order says its own.
 *
 * `match` narrows the orders (method, package, search); `statuses` defaults
 * to the ones where money came in. Pending and failed orders only appear when
 * a caller asks for them -- the sales list does -- dated by when they were
 * created and never counted as money in.
 */
function membershipPaymentStages(range, match = {}, { statuses = MONEY_STATUSES } = {}) {
  const inRange = inRangeOf(range);
  const renewalCurrency = {
    $cond: [
      { $gt: [{ $strLenCP: { $ifNull: ['$$renewal.currency', ''] } }, 0] },
      '$$renewal.currency',
      '$payment.currency'
    ]
  };
  const amount = { $ifNull: ['$entries.amount', 0] };
  const admission = { $ifNull: ['$entries.admission', 0] };
  const trainerFee = { $ifNull: ['$entries.trainerFee', 0] };

  return [
    {
      $match: {
        $and: [
          { 'payment.status': { $in: statuses } },
          ...(Object.keys(match).length ? [match] : []),
          // Coarse, index-friendly: anything with a payment that might be in
          // range. The exact cut is made per payment after the unwind.
          {
            $or: [
              { 'payment.paidAt': inRange },
              { createdAt: inRange },
              { 'subscription.renewals.at': inRange },
              { 'payment.installments.at': inRange }
            ]
          }
        ]
      }
    },
    {
      $project: {
        orderNumber: 1,
        userId: 1,
        customer: '$customerInfo.fullName',
        email: '$customerInfo.email',
        packageName: '$packageDetails.name',
        method: '$payment.method',
        paymentStatus: '$payment.status',
        orderStatus: '$status',
        startDate: '$subscription.startDate',
        endDate: '$subscription.endDate',
        entries: {
          $concatArrays: [
            ownPaymentEntries(),
            {
              $map: {
                input: { $ifNull: ['$subscription.renewals', []] },
                as: 'renewal',
                in: {
                  kind: 'renewal',
                  at: '$$renewal.at',
                  amount: '$$renewal.amount',
                  admission: 0,
                  trainerFee: 0,
                  method: '$payment.method',
                  currency: renewalCurrency
                }
              }
            }
          ]
        }
      }
    },
    { $unwind: '$entries' },
    { $match: { 'entries.at': inRange } },
    {
      $project: {
        orderNumber: 1,
        userId: 1,
        customer: 1,
        email: 1,
        packageName: 1,
        method: { $ifNull: ['$entries.method', '$method'] },
        paymentStatus: 1,
        orderStatus: 1,
        startDate: 1,
        endDate: 1,
        kind: '$entries.kind',
        at: '$entries.at',
        amount,
        admission,
        trainerFee,
        membership: { $round: [{ $subtract: [amount, { $add: [admission, trainerFee] }] }, 2] },
        currency: { $toUpper: { $ifNull: ['$entries.currency', ''] } }
      }
    }
  ];
}

/**
 * Aggregation stages for the refunds given in a range, one document per
 * refunded order, dated when the money went back.
 *
 * Output: { _id (order), orderNumber, packageName, method, at, amount,
 * currency (upper case) }
 */
function membershipRefundStages(range, match = {}) {
  const inRange = inRangeOf(range);
  // A refund recorded before refund.at existed is filed on the day of the
  // payment it returned, which is where the old screens showed it.
  const refundAt = { $ifNull: ['$refund.at', { $ifNull: ['$payment.paidAt', '$createdAt'] }] };

  return [
    {
      $match: {
        $and: [
          { 'payment.status': 'refunded' },
          ...(Object.keys(match).length ? [match] : []),
          {
            $or: [
              { 'refund.at': inRange },
              { 'refund.at': null, 'payment.paidAt': inRange },
              { 'refund.at': null, 'payment.paidAt': null, createdAt: inRange }
            ]
          }
        ]
      }
    },
    {
      $project: {
        orderNumber: 1,
        packageName: '$packageDetails.name',
        method: '$payment.method',
        at: refundAt,
        // A partial refund returned only part of the payment.
        amount: { $ifNull: ['$refund.amount', { $ifNull: ['$payment.amount', 0] }] },
        currency: { $toUpper: { $ifNull: ['$payment.currency', ''] } }
      }
    },
    { $match: { at: inRange } }
  ];
}

/**
 * The bottom line in the base currency: money in, less refunds given, less
 * what was spent. Refunds come off exactly once -- the payment they returned
 * is still in `revenue`, so a fully refunded 100 nets to 0, not -100.
 */
function netResult({ revenue = {}, refunds = {}, spent = {} }, base) {
  const gross = round((revenue[base] || 0) - (refunds[base] || 0));
  const net = round(gross - (spent[base] || 0));
  return {
    gross_income: gross,
    expenses: round(spent[base] || 0),
    net,
    margin: gross ? Math.round((net / gross) * 1000) / 10 : null
  };
}

// ---------------------------------------------------------------------------
// Salaries
//
// A salary is quoted per pay cycle. A day is worth a seventh of a weekly
// salary, a fourteenth of a fortnightly one, and 1/28th to 1/31st of a
// monthly one depending on the month it falls in -- so a whole calendar month
// costs exactly the monthly salary, February included, and a part-month is
// the share of THAT month's days. (A flat 30.44-day month paid 92% of a
// February and 102% of a 31-day month.)
// ---------------------------------------------------------------------------

const CYCLE_DAYS = { weekly: 7, biweekly: 14 };

function daysInMonthOf(dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** What one day of a salary is worth on a given 'YYYY-MM-DD'. */
function salaryPerDay(salary, cycle, dateKey) {
  const amount = Number(salary) || 0;
  return amount / (CYCLE_DAYS[cycle] || daysInMonthOf(dateKey));
}

/** A salary over the inclusive local days from..to, unrounded. */
function salaryForDays(salary, cycle, from, to) {
  let total = 0;
  let cursor = from;
  while (cursor <= to) {
    total += salaryPerDay(salary, cycle, cursor);
    cursor = T.shiftDateKey(cursor, 1);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Depreciation
//
// Straight line, the method a small business actually uses: cost falls evenly
// to its salvage value over its useful life, and never below it.
// ---------------------------------------------------------------------------

function depreciate(asset, asOf = new Date()) {
  const quantity = Math.max(1, Number(asset.quantity) || 1);
  const cost = round((Number(asset.unitCost) || 0) * quantity);
  const salvage = round((Number(asset.salvageValue) || 0) * quantity);
  const life = Number(asset.usefulLifeYears) || 0;

  // Disposed assets are worth what they were sold for, not what the schedule
  // says they should have been worth.
  if (asset.status === 'sold' || asset.status === 'lost' || asset.status === 'retired') {
    return {
      cost,
      age_years: null,
      depreciation: round(cost - (Number(asset.disposalAmount) || 0)),
      book_value: round(asset.status === 'sold' ? Number(asset.disposalAmount) || 0 : 0),
      fully_depreciated: true
    };
  }

  if (!life || !asset.purchasedOn) {
    return { cost, age_years: null, depreciation: 0, book_value: cost, fully_depreciated: false };
  }

  const ageYears = Math.max(0, (asOf.getTime() - new Date(asset.purchasedOn).getTime()) / (365.25 * DAY_MS));
  const depreciable = Math.max(0, cost - salvage);
  const depreciation = Math.min(depreciable, (depreciable * ageYears) / life);

  return {
    cost,
    age_years: Math.round(ageYears * 10) / 10,
    depreciation: round(depreciation),
    book_value: round(cost - depreciation),
    fully_depreciated: ageYears >= life
  };
}

module.exports = {
  DAY_MS,
  localInstant,
  startOfLocalDay,
  endOfLocalDay,
  readRange,
  rangeLabel,
  buildBuckets,
  bucketKeyFor,
  baseCurrency,
  recordCurrency,
  currencyNotice,
  addTo,
  sumOf,
  presentTotals,
  round,
  MONEY_STATUSES,
  firstPaymentAtExpr,
  membershipPaymentStages,
  membershipRefundStages,
  netResult,
  salaryPerDay,
  salaryForDays,
  depreciate
};
