// src/gymfolio/services/feeDesk.js
//
// The fee desk: find a member by name, phone or member ID, and see in one
// read everything needed to take their money -- who they are, the
// membership a renewal follows, what the package costs today, and what they
// still owe. The money itself moves through the existing routes (renew,
// payments, assign); this only reads.
//
// Why not the member picker (/admin/members/options) and the summary list:
//   * a phone is typed however the member remembers it ("0300 1234567"),
//     so it is matched by its digits, and a bare number finds the member
//     whose ID it is ("184" is GP-0184) ahead of every partial match;
//   * the membership a renewal must follow is the one that runs LATEST --
//     a term paid for in advance included. The summary answers the one
//     running today, and renewing from that again would sell a second term
//     over the one already paid for;
//   * a renewal is priced from the package as it is now, not the order's
//     copy of it, so the desk needs the package's current price.

const mongoose = require('mongoose');
const PackageOrder = require('../models/packageOrderModel');
const Package = require('../models/packageModel');
const User = require('../../models/user');
const Settings = require('../../models/settings');
const { parseAmount, resolveCurrency } = require('../../helper/money');
const { round2, paidSoFar } = require('./orderMoney');
const { LIVE_STATUSES } = require('./membershipExpiry');
const { willAutoRenew } = require('../../services/reminderJobs');
const { MembershipError, stripeBilled, joiningFeeDue } = require('./membershipService');
const { summaryFor, IS_MEMBERSHIP, localDaysBetween } = require('./membershipLists');

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
// Beyond this many words the extra ones narrow nothing a person would type.
const MAX_WORDS = 4;

const SEARCH_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'memberCode'];
const MEMBER_FIELDS = 'firstName lastName phone email gender memberCode avatarUrl isActive';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A phone number matches by its digits with anything between them, as the
// accounts sales search does.
function phonePattern(term) {
  if (!/^[\d\s+().-]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, '');
  return digits.length >= 4 ? new RegExp(digits.split('').join('\\D*')) : null;
}

/**
 * The member IDs a term names outright: the code as typed ("gp-0184"), or
 * -- a bare number -- the code with that number ("184" is GP-0184, never
 * GP-1840).
 */
function exactCodePattern(term) {
  if (/^\d{1,9}$/.test(term)) return new RegExp(`^[A-Za-z]*-?0*${Number(term)}$`, 'i');
  return new RegExp(`^${escapeRegex(term)}$`, 'i');
}

function readLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function personOf(user) {
  return {
    id: String(user._id),
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.phone || '',
    memberCode: user.memberCode || null,
    phone: user.phone || '',
    email: user.email || '',
    gender: user.gender || null,
    avatarUrl: user.avatarUrl || null,
    // A disabled account is still found -- a member who left may come back
    // to pay -- but the desk is told, as attendance will turn them away.
    isActive: user.isActive !== false
  };
}

/**
 * Members matching what the desk typed, exact member IDs first, each with
 * the membership they hold (summaryFor: the one running today, else their
 * latest) so two people of the same name can be told apart.
 *
 * Every word must match a name, the email, the phone or the member ID; a
 * term that looks like a phone number also matches by its digits.
 *
 * @returns {Promise<{ rows, hasMore }>}
 */
async function searchMembers(q, { limit } = {}) {
  const term = String(q || '').trim().slice(0, 80);
  if (!term) return { rows: [], hasMore: false };
  const size = readLimit(limit);

  const words = term.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const or = [
    {
      $and: words.map((word) => {
        const rx = new RegExp(escapeRegex(word), 'i');
        return { $or: SEARCH_FIELDS.map((field) => ({ [field]: rx })) };
      })
    }
  ];
  const phoneRx = phonePattern(term);
  if (phoneRx) or.push({ phone: phoneRx });

  const exact = await User.find({ role: 'user', memberCode: exactCodePattern(term) })
    .select(MEMBER_FIELDS)
    .sort({ memberCode: 1 })
    .limit(size)
    .lean();
  const room = size - exact.length;
  // One more than there is room for, to say "keep typing" without a count.
  const rest = room > 0
    ? await User.find({ role: 'user', _id: { $nin: exact.map((user) => user._id) }, $or: or })
        .select(MEMBER_FIELDS)
        .sort({ firstName: 1, lastName: 1, _id: 1 })
        .limit(room + 1)
        .lean()
    : [];

  const users = [...exact, ...rest.slice(0, room)];
  const held = users.length ? await summaryFor(users.map((user) => String(user._id))) : [];
  const byId = new Map(held.map((row) => [row.userId, row.membership]));
  return {
    rows: users.map((user) => ({ ...personOf(user), membership: byId.get(String(user._id)) || null })),
    hasMore: rest.length > room
  };
}

// What the desk reads about a membership order.
function membershipOf(order, now) {
  const p = order.payment || {};
  const s = order.subscription || {};
  const end = s.endDate ? new Date(s.endDate) : null;
  const live = p.status === 'paid' && LIVE_STATUSES.includes(order.status) && !!end && end >= now;
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    packageId: order.packageId ? String(order.packageId) : null,
    packageName: (order.packageDetails && order.packageDetails.name) || '',
    status: order.status,
    paymentStatus: p.status,
    method: p.method || '',
    startDate: s.startDate || null,
    endDate: s.endDate || null,
    daysLeft: end ? localDaysBetween(now, end) : null,
    live,
    // Paid for in advance: the term has not begun yet.
    startsLater: live && !!s.startDate && new Date(s.startDate) > now,
    amount: round2(p.amount),
    discountAmount: round2(p.discountAmount || 0),
    discountNote: p.discountNote || '',
    joiningFee: round2(p.joiningFee || 0),
    trainerFee: round2(p.trainerFee || 0),
    amountPaid: paidSoFar(p),
    balanceDue: round2(p.balanceDue || 0),
    currency: String(p.currency || '').toUpperCase(),
    trainerName: (order.trainerAssignment && order.trainerAssignment.trainerName) || '',
    // Card subscriptions: Stripe renews them and takes their money; the
    // desk's renew and payments refuse them (AUTO_RENEWS / STRIPE_BILLED).
    autoRenews: willAutoRenew(order),
    stripeBilled: stripeBilled(order),
    cardPaymentFailed: order.status === 'past_due' && !!p.stripeSubscriptionId
  };
}

/**
 * Everything the fee desk shows for one member.
 *
 *   member      who they are (with the photo and whether the account is on)
 *   membership  the one a renewal follows: of their paid, live memberships
 *               the one that runs latest (a term paid in advance included),
 *               else the one that ended last whatever became of it; null
 *               when they have never had one
 *   running     the membership running today, when it is not `membership`
 *               (a later term is already paid for); else null
 *   package     that membership's package as it is sold now -- what a
 *               renewal costs -- or null when it has been deleted
 *   dues        every granted order still owing money, oldest term first
 *   joiningFeeDue  whether a new membership would carry the admission fee
 *   currency    the gym's currency
 *
 * @throws {MembershipError} 404 MEMBER_NOT_FOUND
 */
async function deskView(userId, { now = new Date() } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) throw new MembershipError('Member not found', 404, 'MEMBER_NOT_FOUND');
  const user = await User.findById(userId).select(`${MEMBER_FIELDS} role`).lean();
  if (!user) throw new MembershipError('Member not found', 404, 'MEMBER_NOT_FOUND');

  const mine = { userId: user._id, ...IS_MEMBERSHIP };
  const [latestLive, latestAny, [held], owing, feeDue, settings] = await Promise.all([
    PackageOrder.findOne({ ...mine, 'payment.status': 'paid', status: { $in: LIVE_STATUSES }, 'subscription.endDate': { $gte: now } })
      .sort({ 'subscription.endDate': -1, createdAt: -1 })
      .lean(),
    PackageOrder.findOne(mine).sort({ 'subscription.endDate': -1, createdAt: -1 }).lean(),
    summaryFor([String(user._id)], { now }),
    PackageOrder.find({ userId: user._id, 'payment.status': 'paid', 'payment.balanceDue': { $gt: 0 } })
      .sort({ 'subscription.endDate': 1, createdAt: 1 })
      .lean(),
    joiningFeeDue({ userId: user._id, email: user.email }),
    Settings.getSettings().catch(() => null)
  ]);

  const target = latestLive || latestAny;
  const membership = target ? membershipOf(target, now) : null;

  let running = null;
  const today = held && held.membership;
  if (membership && today && today.current && today.orderId !== membership.orderId) {
    const order = await PackageOrder.findById(today.orderId).lean();
    if (order) running = membershipOf(order, now);
  }

  let pkg = null;
  if (target && target.packageId) {
    const found = await Package.findById(target.packageId).select('name price currency period kind isActive joiningFee').lean();
    if (found) {
      pkg = {
        id: String(found._id),
        name: found.name,
        price: parseAmount(found.price),
        currency: resolveCurrency(found.currency, settings && settings.currency),
        period: found.period || '',
        kind: found.kind || 'membership',
        isActive: found.isActive !== false
      };
    }
  }

  return {
    member: personOf(user),
    membership,
    running,
    package: pkg,
    dues: owing.map((order) => {
      const p = order.payment || {};
      return {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        packageName: (order.packageDetails && order.packageDetails.name) || '',
        status: order.status,
        method: p.method || '',
        amount: round2(p.amount),
        amountPaid: paidSoFar(p),
        balanceDue: round2(p.balanceDue),
        currency: String(p.currency || '').toUpperCase(),
        startDate: (order.subscription && order.subscription.startDate) || null,
        endDate: (order.subscription && order.subscription.endDate) || null,
        stripeBilled: stripeBilled(order)
      };
    }),
    joiningFeeDue: feeDue,
    currency: resolveCurrency(null, settings && settings.currency)
  };
}

module.exports = {
  searchMembers,
  deskView,
  phonePattern,
  exactCodePattern,
  readLimit
};
