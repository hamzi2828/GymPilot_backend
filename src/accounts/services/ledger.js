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
// The one set in Settings, whenever the gym has chosen one: the owner picked
// it, every price now follows it, and the whole admin must show it -- even on
// the day of the switch, before anything has been taken in it. Money recorded
// earlier in another currency is history: it is listed under its own code
// (addTo keeps currencies apart) and never added in. Only a gym that has never
// chosen a currency is reported in whatever its sales are in, with a banner
// (currencyNotice) asking it to choose.
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
    effective: settings && settings.currency ? configured : !configuredHasMoney && dominant ? dominant : configured,
    dominant,
    mismatch: !(settings && settings.currency) && !!dominant && !configuredHasMoney && dominant !== configured
  };

  currencyCaches.set(cacheKey, { at: Date.now(), value });
  return value;
}

// Drops this gym's cached answer, for when its Settings currency has just
// changed: a sale rung up a second later must be in the new one.
function forgetCurrency() {
  currencyCaches.delete(tenantKey());
}

async function baseCurrency() {
  return (await resolveCurrency()).effective;
}

// The currency a NEW sale, expense or asset is written in: the one set in
// Settings, the same as baseCurrency() whenever the gym has chosen one. The
// history-based answer is only the fallback for a gym that has never chosen.
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
      `Choose your currency under Settings → General → Money and every screen will use it.`
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

  // What a single tile prints: always the gym's own currency, the one chosen in
  // Settings -- every screen of the admin is in it, even on the day of a switch
  // when nothing has been taken in it yet. Money in any other currency (history
  // from before the switch) is listed in by_currency and flagged by `mixed`,
  // never shown as the headline and never added in.
  const baseAmount = round(totals[base] || 0);

  return {
    by_currency: entries.map(([currency, amount]) => ({ currency, amount: round(amount) })),
    base_currency: base,
    base_amount: baseAmount,
    headline_amount: baseAmount,
    headline_currency: base,
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
 * currency (upper case), renewedFrom }
 *
 * `renewedFrom` is the order this one renewed or replaced (null for none):
 * renewing at the desk and changing package each make a new order, whose own
 * first payment is 'initial' like any other -- only Stripe's renewals of one
 * order are 'renewal' -- so a reader telling new business from renewals
 * reads both.
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
 *
 * A membership imported already paid (order.imported) has no first payment
 * here: that money was taken in the gym's old system, and counting it would
 * put every imported member into the takings of the day of the import.
 * Anything paid on such an order afterwards -- a later part, a renewal -- is
 * a payment like any other.
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
        renewedFrom: 1,
        imported: 1,
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
    { $match: { 'entries.at': inRange, $nor: [{ imported: true, 'entries.kind': 'initial' }] } },
    {
      $project: {
        orderNumber: 1,
        userId: 1,
        renewedFrom: { $ifNull: ['$renewedFrom', null] },
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
 * currency (upper case) }, plus any `fields` the caller projects from the
 * order (the profit and loss reads the trainer's commission this way, so a
 * refund's commission is dated by exactly this rule).
 */
function membershipRefundStages(range, match = {}, { fields = {} } = {}) {
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
        currency: { $toUpper: { $ifNull: ['$payment.currency', ''] } },
        ...fields
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
  forgetCurrency,
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
