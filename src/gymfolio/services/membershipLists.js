// src/gymfolio/services/membershipLists.js
//
// The lists the front desk works through, one row per MEMBER rather than
// per order: who still owes money, whose membership is about to end, whose
// has ended without a renewal -- and, for a screen that already has its
// members, what each one currently holds. Each row says who the member is
// -- name, phone, email, gender, member code, read from the member's own
// record where there is one (a guest order has only what checkout asked).
//
// "Membership" here is a package of kind membership (orders from before
// kinds existed are memberships): a session pack, day pass or trial is not
// what runs out and gets renewed.

const mongoose = require('mongoose');
const PackageOrder = require('../models/packageOrderModel');
const User = require('../../models/user');
const T = require('../../attendance/services/timeUtils');
const { round2, paidSoFar } = require('./orderMoney');
const { LIVE_STATUSES } = require('./membershipExpiry');
const { willAutoRenew } = require('../../services/reminderJobs');
const { MembershipError } = require('./membershipService');

const IS_MEMBERSHIP = { $or: [{ 'packageDetails.kind': 'membership' }, { 'packageDetails.kind': { $exists: false } }] };

// Who an order is for: the account, or -- a guest checkout -- the email.
const OWNER = { $ifNull: ['$userId', { $toLower: { $ifNull: ['$customerInfo.email', ''] } }] };

// Only what the rows are built from, so grouping a whole gym's orders stays light.
const ROW_FIELDS = {
  userId: 1,
  orderNumber: 1,
  customerInfo: 1,
  'packageDetails.name': 1,
  'payment.status': 1,
  'payment.method': 1,
  'payment.amount': 1,
  'payment.amountPaid': 1,
  'payment.balanceDue': 1,
  'payment.currency': 1,
  'payment.stripeSubscriptionId': 1,
  'subscription.startDate': 1,
  'subscription.endDate': 1,
  'subscription.autoRenew': 1,
  'subscription.cancelAtPeriodEnd': 1,
  'subscription.stripeStatus': 1,
  status: 1,
  createdAt: 1
};

const MAX_LIMIT = 200;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pageOf({ page, limit } = {}, fallback = 50) {
  const size = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || fallback));
  const number = Math.max(1, parseInt(page, 10) || 1);
  return { page: number, limit: size, skip: (number - 1) * size };
}

// The member fields every list row carries.
const MEMBER_FIELDS = 'firstName lastName phone email gender memberCode';

async function membersById(ids) {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return new Map();
  const users = await User.find({ _id: { $in: wanted } }).select(MEMBER_FIELDS).lean();
  return new Map(users.map((user) => [String(user._id), user]));
}

/**
 * Who a row is about: the member's record when the order has one, else what
 * the order itself says (a guest checkout, or an account since deleted).
 */
function memberCard(userId, user, customer = {}) {
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : '';
  return {
    memberId: userId ? String(userId) : null,
    name: name || customer.fullName || (user && user.email) || customer.email || '',
    phone: (user && user.phone) || customer.phone || '',
    email: (user && user.email) || customer.email || '',
    gender: (user && user.gender) || null,
    memberCode: (user && user.memberCode) || null
  };
}

/** A search over the order's own copy of who it is for. */
function searchClause(search) {
  const term = String(search || '').trim();
  if (!term) return null;
  const rx = new RegExp(escapeRegex(term), 'i');
  return { $or: [{ orderNumber: rx }, { 'customerInfo.fullName': rx }, { 'customerInfo.email': rx }, { 'customerInfo.phone': rx }] };
}

/**
 * Members with money still owed: every granted order with a balance due,
 * grouped per member and currency (money is never added across
 * currencies), the largest balance first.
 *
 * @returns {Promise<{ rows, totals, pagination }>}
 */
async function duesList({ search, page, limit } = {}) {
  const paging = pageOf({ page, limit });
  const match = { 'payment.status': 'paid', 'payment.balanceDue': { $gt: 0 } };
  const searching = searchClause(search);
  if (searching) Object.assign(match, searching);

  const [result] = await PackageOrder.aggregate([
    { $match: match },
    { $sort: { 'subscription.endDate': 1, createdAt: 1 } },
    {
      $group: {
        _id: {
          // Guest orders have no account: told apart by email, as the
          // member counts do.
          who: { $ifNull: ['$userId', { $toLower: { $ifNull: ['$customerInfo.email', ''] } }] },
          currency: { $toUpper: { $ifNull: ['$payment.currency', ''] } }
        },
        userId: { $first: '$userId' },
        customer: { $first: '$customerInfo' },
        balanceDue: { $sum: '$payment.balanceDue' },
        orders: {
          $push: {
            orderId: '$_id',
            orderNumber: '$orderNumber',
            packageName: '$packageDetails.name',
            status: '$status',
            amount: '$payment.amount',
            amountPaid: '$payment.amountPaid',
            balanceDue: '$payment.balanceDue',
            startDate: '$subscription.startDate',
            endDate: '$subscription.endDate',
            lastPaidAt: '$payment.lastPaidAt'
          }
        }
      }
    },
    { $sort: { balanceDue: -1, '_id.who': 1 } },
    {
      $facet: {
        rows: [{ $skip: paging.skip }, { $limit: paging.limit }],
        count: [{ $count: 'n' }],
        totals: [
          { $group: { _id: '$_id.currency', balanceDue: { $sum: '$balanceDue' }, members: { $sum: 1 }, orders: { $sum: { $size: '$orders' } } } },
          { $sort: { balanceDue: -1 } }
        ]
      }
    }
  ]);

  const users = await membersById(result.rows.map((row) => row.userId));
  const rows = result.rows.map((row) => ({
    ...memberCard(row.userId, row.userId ? users.get(String(row.userId)) : null, row.customer || {}),
    currency: row._id.currency,
    balanceDue: round2(row.balanceDue),
    orders: row.orders.map((order) => ({
      ...order,
      orderId: String(order.orderId),
      amount: round2(order.amount),
      amountPaid: order.amountPaid === null || order.amountPaid === undefined ? null : round2(order.amountPaid),
      balanceDue: round2(order.balanceDue)
    }))
  }));
  const total = result.count.length ? result.count[0].n : 0;
  return {
    rows,
    totals: result.totals.map((row) => ({ currency: row._id, balanceDue: round2(row.balanceDue), members: row.members, orders: row.orders })),
    pagination: { page: paging.page, limit: paging.limit, total, pages: Math.max(1, Math.ceil(total / paging.limit)) }
  };
}

/** Whole days from one instant's local day to another's, at the gym. */
function localDaysBetween(from, to) {
  const dayOf = (date) => {
    const [y, m, d] = T.dateKey(new Date(date)).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((dayOf(to) - dayOf(from)) / 86400000);
}

/** One list row: the member, and the membership the row is about. */
function membershipRow(order, user) {
  const p = order.payment || {};
  const s = order.subscription || {};
  return {
    ...memberCard(order.userId, user, order.customerInfo || {}),
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    packageName: (order.packageDetails && order.packageDetails.name) || '',
    status: order.status,
    paymentStatus: p.status,
    startDate: s.startDate || null,
    endDate: s.endDate || null,
    amount: round2(p.amount),
    balanceDue: round2(p.balanceDue || 0),
    currency: String(p.currency || '').toUpperCase()
  };
}

async function withMembers(orders) {
  const users = await membersById(orders.map((order) => order.userId));
  return orders.map((order) => ({ order, user: order.userId ? users.get(String(order.userId)) || null : null }));
}

function paged(rows, paging) {
  return {
    rows: rows.slice(paging.skip, paging.skip + paging.limit),
    pagination: { page: paging.page, limit: paging.limit, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / paging.limit)) }
  };
}

/**
 * Members whose membership ends within `days` days (1-365, default 7) and
 * who have not renewed: each member's live membership that runs LATEST must
 * end inside the window -- a renewal already paid for runs past it, so its
 * member is not on the list; one still unpaid is not a renewal yet.
 *
 * Card subscriptions Stripe will renew by itself are left out unless
 * `includeAutoRenew` (then marked `autoRenews: true`). Soonest first.
 */
async function expiringList({ days, includeAutoRenew = false, search, page, limit, now = new Date() } = {}) {
  const window = days === undefined || days === null || days === '' ? 7 : Number(days);
  if (!Number.isInteger(window) || window < 1 || window > 365) {
    throw new MembershipError('days must be a whole number from 1 to 365', 400, 'INVALID_QUERY');
  }
  const until = new Date(now.getTime() + window * 86400000);
  const match = { 'payment.status': 'paid', status: { $in: LIVE_STATUSES }, 'subscription.endDate': { $gte: now }, ...IS_MEMBERSHIP };

  const latest = await PackageOrder.aggregate([
    { $match: match },
    { $project: ROW_FIELDS },
    { $sort: { 'subscription.endDate': -1, createdAt: -1 } },
    { $group: { _id: OWNER, order: { $first: '$$ROOT' } } },
    { $match: { 'order.subscription.endDate': { $lte: until } } },
    { $sort: { 'order.subscription.endDate': 1, _id: 1 } }
  ]);

  let orders = latest.map((row) => row.order);
  if (!includeAutoRenew) orders = orders.filter((order) => !willAutoRenew(order));
  orders = filterBySearch(orders, search);

  const { rows, pagination } = paged(orders, pageOf({ page, limit }));
  const shaped = (await withMembers(rows)).map(({ order, user }) => ({
    ...membershipRow(order, user),
    daysLeft: localDaysBetween(now, order.subscription.endDate),
    autoRenews: willAutoRenew(order)
  }));
  return { rows: shaped, days: window, pagination };
}

/**
 * Members whose latest membership has ended and was not renewed.
 *
 * A member's latest membership is the one that ends last among those not
 * cancelled or refunded -- paid, paid in part, or never paid (a membership
 * assigned pending whose term ran out counts: "including unpaid ones"). It
 * must have ended, and no PAID membership of theirs may run past it: a
 * renewal still waiting to be paid does not count as renewing.
 * `withinDays` keeps only those that ended in the last so many days.
 * Most recently lapsed first.
 */
async function expiredList({ withinDays, search, page, limit, now = new Date() } = {}) {
  const match = {
    ...IS_MEMBERSHIP,
    'payment.status': { $in: ['paid', 'pending', 'processing'] },
    status: { $ne: 'cancelled' },
    'subscription.endDate': { $lt: now }
  };
  if (withinDays !== undefined && withinDays !== null && withinDays !== '') {
    const window = Number(withinDays);
    if (!Number.isInteger(window) || window < 1 || window > 3650) {
        throw new MembershipError('withinDays must be a whole number from 1 to 3650', 400, 'INVALID_QUERY');
    }
    match['subscription.endDate'].$gte = new Date(now.getTime() - window * 86400000);
  }

  const lapsed = await PackageOrder.aggregate([
    { $match: match },
    { $project: ROW_FIELDS },
    { $sort: { 'subscription.endDate': -1, createdAt: -1 } },
    { $group: { _id: OWNER, order: { $first: '$$ROOT' } } }
  ]);

  // Renewed: a paid membership of the same member running past the lapse.
  const userIds = lapsed.map((row) => row.order.userId).filter(Boolean);
  const emails = lapsed.filter((row) => !row.order.userId).map((row) => String(row._id));
  const paidEnds = new Map();
  if (userIds.length || emails.length) {
    const paid = await PackageOrder.aggregate([
      {
        $match: {
          ...IS_MEMBERSHIP,
          'payment.status': 'paid',
          status: { $ne: 'cancelled' },
          $and: [{ $or: [{ userId: { $in: userIds } }, { userId: null, 'customerInfo.email': { $in: emails } }] }]
        }
      },
      { $group: { _id: OWNER, end: { $max: '$subscription.endDate' } } }
    ]);
    for (const row of paid) paidEnds.set(String(row._id), row.end ? new Date(row.end).getTime() : 0);
  }

  let orders = lapsed
    .filter((row) => !(paidEnds.get(String(row._id)) > new Date(row.order.subscription.endDate).getTime()))
    .map((row) => row.order)
    .sort((a, b) => new Date(b.subscription.endDate) - new Date(a.subscription.endDate) || String(a._id).localeCompare(String(b._id)));
  orders = filterBySearch(orders, search);

  const { rows, pagination } = paged(orders, pageOf({ page, limit }));
  const shaped = (await withMembers(rows)).map(({ order, user }) => ({
    ...membershipRow(order, user),
    daysOverdue: localDaysBetween(order.subscription.endDate, now)
  }));
  return { rows: shaped, pagination };
}

// The same search the other lists run in the database, on rows already read.
function filterBySearch(orders, search) {
  const term = String(search || '').trim().toLowerCase();
  if (!term) return orders;
  return orders.filter((order) => {
    const c = order.customerInfo || {};
    return [order.orderNumber, c.fullName, c.email, c.phone].some((value) => String(value || '').toLowerCase().includes(term));
  });
}

const MAX_SUMMARY_USERS = 500;

/**
 * What each of up to 500 members holds: their current membership (paid,
 * live, and running today -- the one ending last if several), else their
 * latest one (the one ending last, whatever became of it), else null.
 *
 * @returns {Promise<Array<{ userId, membership }>>} in the order asked, once each
 */
async function summaryFor(userIds, { now = new Date() } = {}) {
  if (!Array.isArray(userIds) || !userIds.length) throw new MembershipError('Send userIds: a list of member ids', 400, 'INVALID_QUERY');
  const unique = [...new Set(userIds.map(String))];
  if (unique.length > MAX_SUMMARY_USERS) throw new MembershipError(`At most ${MAX_SUMMARY_USERS} members at a time`, 400, 'INVALID_QUERY');
  const bad = unique.filter((id) => !mongoose.Types.ObjectId.isValid(id));
  if (bad.length) throw new MembershipError(`Not member ids: ${bad.slice(0, 5).join(', ')}`, 400, 'INVALID_QUERY');

  const ids = unique.map((id) => new mongoose.Types.ObjectId(id));
  const rows = await PackageOrder.aggregate([
    { $match: { userId: { $in: ids }, ...IS_MEMBERSHIP } },
    {
      $project: {
        ...ROW_FIELDS,
        'payment.discountAmount': 1,
        'payment.joiningFee': 1,
        'payment.trainerFee': 1,
        'trainerAssignment.trainerName': 1,
        current: {
          $and: [
            { $eq: ['$payment.status', 'paid'] },
            { $in: ['$status', LIVE_STATUSES] },
            { $lte: [{ $ifNull: ['$subscription.startDate', now] }, now] },
            { $gte: [{ $ifNull: ['$subscription.endDate', new Date(0)] }, now] }
          ]
        }
      }
    },
    { $sort: { current: -1, 'subscription.endDate': -1, createdAt: -1 } },
    { $group: { _id: '$userId', order: { $first: '$$ROOT' } } }
  ]);

  const byUser = new Map(rows.map((row) => [String(row._id), row.order]));
  return unique.map((userId) => {
    const order = byUser.get(userId);
    if (!order) return { userId, membership: null };
    const p = order.payment || {};
    const s = order.subscription || {};
    return {
      userId,
      membership: {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        packageName: (order.packageDetails && order.packageDetails.name) || '',
        status: order.status,
        paymentStatus: p.status,
        method: p.method || '',
        current: !!order.current,
        startDate: s.startDate || null,
        endDate: s.endDate || null,
        daysLeft: s.endDate ? localDaysBetween(now, s.endDate) : null,
        amount: round2(p.amount),
        discountAmount: round2(p.discountAmount || 0),
        joiningFee: round2(p.joiningFee || 0),
        trainerFee: round2(p.trainerFee || 0),
        amountPaid: paidSoFar(p),
        balanceDue: round2(p.balanceDue || 0),
        currency: String(p.currency || '').toUpperCase(),
        trainerName: (order.trainerAssignment && order.trainerAssignment.trainerName) || ''
      }
    };
  });
}

module.exports = {
  duesList,
  expiringList,
  expiredList,
  summaryFor,
  MAX_SUMMARY_USERS,
  memberCard,
  membersById,
  pageOf,
  searchClause,
  localDaysBetween
};
