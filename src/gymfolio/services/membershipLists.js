// src/gymfolio/services/membershipLists.js
//
// The lists the front desk works through, one row per MEMBER rather than
// per order: who still owes money. Each row says who the member is -- name,
// phone, email, gender, member code, read from the member's own record
// where there is one (a guest order has only what checkout asked) -- and
// the orders behind the figure.

const PackageOrder = require('../models/packageOrderModel');
const User = require('../../models/user');
const { round2 } = require('./orderMoney');

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

module.exports = { duesList, memberCard, membersById, pageOf, searchClause };
