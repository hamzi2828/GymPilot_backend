// src/attendance/services/peopleDirectory.js
//
// The attendance app treats two very different records as the same kind of
// thing -- a person who can put a finger on the reader. Members are Users;
// staff are Trainers or staff Users, and a trainer linked to a staff User is
// that one person. This module is the only place that knows that, so
// everything downstream (punching, enrolment, lookup) works in one shape:
//
//   { personType, id, name, code, meta }
//
// It also owns the short front-desk codes ("GP-0184", "TR-004"). A member
// gets theirs when the account is created (assignMemberCode, called by every
// place that creates one), so the ID is on their card and in the Users list
// from day one; accounts older than that get one the first time they show up
// at the desk, or from scripts/assignMemberCodes.js.

const User = require('../../models/user');
const Trainer = require('../../gymfolio/models/trainerModel');
const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const { defaultCurrency } = require('../../services/currency');

const MEMBER_PREFIX = 'GP-';
const STAFF_PREFIX = 'TR-';

// A picker at a front desk is scrolled and typed into, not paged. This is a
// sanity bound for an unexpectedly large database, not a page size.
const MAX_DIRECTORY = 2000;

function fullName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || 'Member';
}

// Codes are sequential rather than random so they stay short enough to read
// aloud across a desk. The scan is over an indexed field and only runs when a
// person is first given one, so it is not on any hot path.
//
// Only codes that are the prefix and digits count: a spreadsheet import can
// bring "GP-A12" across from an old system, and reading that as the highest
// code would restart the series at GP-0001 on every call. `offset` is how
// many codes past the highest to go -- a retry after losing a race.
async function nextSequentialCode(Model, field, prefix, offset = 0) {
  const last = await Model.findOne({ [field]: new RegExp('^' + prefix + '\\d+$') })
    .sort({ [field]: -1 })
    .select(field)
    .lean();

  let sequence = 1;
  if (last && last[field]) {
    const parsed = parseInt(String(last[field]).slice(prefix.length), 10);
    if (!Number.isNaN(parsed)) sequence = parsed + 1;
  }

  return prefix + String(sequence + offset).padStart(4, '0');
}

// Both of these tolerate a lost race: two desks enrolling two people at the
// same instant can generate the same code, and the unique index rejects one
// of them. Re-reading is correct there -- the other writer's code is now the
// truth, and this person simply takes the next one.
async function ensureMemberCode(user) {
  if (user.memberCode) return user.memberCode;

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await nextSequentialCode(User, 'memberCode', MEMBER_PREFIX, attempt);
    try {
      await User.updateOne({ _id: user._id, memberCode: null }, { $set: { memberCode: code } });
      const saved = await User.findById(user._id).select('memberCode').lean();
      if (saved && saved.memberCode) return saved.memberCode;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  return '';
}

/**
 * A member's ID at the moment their account is made: the admin form, the
 * sign-up form (checkout signs people up through it), Google, a converted
 * lead and the CSV import all call this. Staff are left alone -- they are
 * TR- people, given their code by the Staff screen.
 *
 * The code is also set on the document passed in, so the response the
 * caller is about to send carries it. Never throws: an account without an
 * ID yet is still an account, and the desk gives it one on first sight.
 */
async function assignMemberCode(user) {
  if (!user || user.memberCode) return (user && user.memberCode) || '';
  if (user.role === 'admin' || (user.employment && user.employment.isStaff)) return '';
  try {
    const code = await ensureMemberCode(user);
    if (code) {
      if (typeof user.set === 'function') {
        // Already saved by ensureMemberCode: mark it clean so a later save of
        // this document does not write it a second time.
        user.set('memberCode', code);
        user.unmarkModified('memberCode');
      } else {
        user.memberCode = code;
      }
    }
    return code;
  } catch (error) {
    console.error('[people] could not give', String(user._id), 'a member ID:', error.message);
    return '';
  }
}

// Trainers and staff accounts share ONE TR- series. Scanning only the trainer
// collection would hand a trainer a code a receptionist already has, and the
// front desk would have two people answering to "TR-0002".
async function highestStaffSequence() {
  const [fromTrainers, fromUsers] = await Promise.all([
    Trainer.findOne({ staffCode: new RegExp('^' + STAFF_PREFIX) }).sort({ staffCode: -1 }).select('staffCode').lean(),
    User.findOne({ staffCode: new RegExp('^' + STAFF_PREFIX) }).sort({ staffCode: -1 }).select('staffCode').lean()
  ]);

  return [fromTrainers, fromUsers].reduce((max, row) => {
    if (!row || !row.staffCode) return max;
    const value = parseInt(String(row.staffCode).slice(STAFF_PREFIX.length), 10);
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, 0);
}

async function ensureStaffCode(trainer) {
  if (trainer.staffCode) return trainer.staffCode;

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = STAFF_PREFIX + String((await highestStaffSequence()) + 1).padStart(4, '0');
    try {
      await Trainer.updateOne({ _id: trainer._id, staffCode: null }, { $set: { staffCode: code } });
      const saved = await Trainer.findById(trainer._id).select('staffCode').lean();
      if (saved && saved.staffCode) return saved.staffCode;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  return '';
}

// The staff-code twin of ensureMemberCode, for staff who are User accounts
// rather than Trainer records. Both draw from the same TR- series so two
// people can never be handed the same code to read out at the desk.
async function ensureUserStaffCode(user) {
  if (user.staffCode) return user.staffCode;

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = STAFF_PREFIX + String((await highestStaffSequence()) + 1).padStart(4, '0');
    try {
      await User.updateOne({ _id: user._id, staffCode: null }, { $set: { staffCode: code } });
      const saved = await User.findById(user._id).select('staffCode').lean();
      if (saved && saved.staffCode) return saved.staffCode;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Trainers who are also staff
//
// A trainer employed here is one human held in two records: the Trainer the
// website shows, and the staff User carrying their pay and roster, tied by
// Trainer.userId. At the desk they are ONE person -- the staff account. They
// are listed once, their punches are filed under the User id and judged
// against the roster (employment.schedule) rather than PT availability, and
// the Staff page and payroll count one set of hours. A trainer whose link
// points at nobody who could punch -- no account, a deactivated one, one no
// longer on the staff -- stays the trainer it always was.
// ---------------------------------------------------------------------------

// A staff account that can punch.
const STAFF_ACCOUNT = { isActive: true, 'employment.isStaff': true };

/**
 * Of these trainer profiles, the ones that belong to a staff account that can
 * punch: a Map of String(trainer _id) -> String(User _id). Any other id is
 * simply absent. Two queries however many ids.
 */
async function staffAccountsFor(trainerIds) {
  const owners = new Map();
  if (!trainerIds || !trainerIds.length) return owners;

  const linked = await Trainer.find({ _id: { $in: trainerIds }, userId: { $ne: null } }).select('userId').lean();
  if (!linked.length) return owners;

  const accounts = await User.find({ _id: { $in: linked.map((trainer) => trainer.userId) }, ...STAFF_ACCOUNT })
    .select('_id')
    .lean();
  const live = new Set(accounts.map((user) => String(user._id)));

  for (const trainer of linked) {
    if (live.has(String(trainer.userId))) owners.set(String(trainer._id), String(trainer.userId));
  }
  return owners;
}

/**
 * The trainer profiles linked to each of these accounts, whatever state the
 * profile is in: punches and fingers filed under one of them are still that
 * person's. A Map of String(User _id) -> [trainer _id].
 */
async function trainerProfilesOf(userIds) {
  const byUser = new Map();
  if (!userIds || !userIds.length) return byUser;

  const trainers = await Trainer.find({ userId: { $in: userIds } }).select('userId').lean();
  for (const trainer of trainers) {
    const owner = String(trainer.userId);
    if (!byUser.has(owner)) byUser.set(owner, []);
    byUser.get(owner).push(trainer._id);
  }
  return byUser;
}

// The membership behind a member, as it stands right now.
//
// Answers one of: active | frozen | past_due | pending | suspended |
// cancelled | expired | none. Everything downstream (the punch verdict, the
// attendance snapshot, class bookings, the member's own account page) reads
// this shape, so a new answer here must also be storable there -- see the
// status enums on attendanceModel and classBookingModel. 'pending' with a
// `startsOn` date is a paid membership that has not started yet.
//
// Guest checkouts are matched by email as well as by userId: someone can buy
// a package before ever creating an account, then sign up with the same
// address, and the front desk should still see the package they paid for.
const DAY_MS = 24 * 60 * 60 * 1000;

// Cancelled and suspended orders are decisions somebody made; neither counts
// as live however far off its end date is.
const NOT_LIVE = new Set(['cancelled', 'suspended']);

function isLiveOrder(order, now) {
  return (
    !NOT_LIVE.has(order.status) &&
    order.subscription &&
    order.subscription.endDate &&
    new Date(order.subscription.endDate) >= now &&
    // A pack with nothing left on it is not a live membership.
    !(order.sessions && order.sessions.total > 0 && order.sessions.used >= order.sessions.total)
  );
}

// Whether the term has begun. The desk can sell a membership that starts in
// a few days (subscription.startDate ahead); until then it is paid for but
// covers nothing. An order with no start date is from before the field and
// has always been running.
function hasStarted(order, now) {
  const start = order.subscription && order.subscription.startDate;
  return !start || new Date(start) <= now;
}

// How many of a person's paid orders are weighed, newest end date first.
// Shared by membershipFor and membershipsFor, so the desk's one-person answer
// and the office's whole-page answer are drawn from the same orders.
const RECENT_PAID_ORDERS = 5;

// Paid orders, and the one kind of unpaid order the desk is told about: a
// bank transfer that has been sent (or promised) but not yet confirmed by
// staff, or a desk sale recorded as unpaid. Card checkouts are left out: an
// abandoned Stripe session is not a payment anybody is waiting on.
const PAID_ORDER = { 'payment.status': 'paid' };
const AWAITING_PAYMENT = {
  'payment.status': { $in: ['pending', 'processing'] },
  'payment.method': { $ne: 'stripe' },
  status: 'pending'
};

// Money still owed on a PAID order (payment.balanceDue) -- a package sold
// part-paid: the membership runs, and the desk is told to collect the rest.
// Zero when nothing is owed, on an order not paid at all (its whole price is
// owed, which the desk already hears as "awaiting payment"), and on an order
// from before the field existed. Read-only: the attendance side never writes
// it.
function balanceOf(order) {
  const payment = order.payment || {};
  if (payment.status !== 'paid') return 0;
  const due = Number(payment.balanceDue ?? 0);
  return Number.isFinite(due) && due > 0 ? due : 0;
}

function currencyOf(order) {
  return order.payment && order.payment.currency ? String(order.payment.currency).toUpperCase() : '';
}

// What a member owes is everything still owed on ANY of their paid orders,
// as the Dues list counts it -- not only on the order the desk describes.
// A member who renews early and pays the renewal in full still owes the
// balance on the term before; the desk describes the renewal (it runs
// latest), and reading the balance off that one order said nothing was
// owed. Kept per currency: money is never added across them.
function owedTotals(orders) {
  const totals = new Map();
  for (const order of orders || []) {
    const due = balanceOf(order);
    if (!(due > 0)) continue;
    const code = currencyOf(order);
    totals.set(code, Math.round(((totals.get(code) || 0) + due) * 100) / 100);
  }
  return totals;
}

// The one figure the desk says: the total in the gym's own currency
// (`prefer`) when anything is owed in it -- an order naming no currency is
// in the gym's -- otherwise the largest sum. Two currencies only arise when
// a gym changed its currency with money still owed; the desk then names the
// money it can actually collect, never a sum across the two. null when
// nothing is owed.
function owedIn(totals, prefer) {
  const code = String(prefer || '').toUpperCase();
  const merged = new Map(totals);
  if (code && merged.has('')) {
    merged.set(code, Math.round(((merged.get(code) || 0) + merged.get('')) * 100) / 100);
    merged.delete('');
  }
  if (!merged.size) return null;
  if (code && merged.has(code)) return { balanceDue: merged.get(code), currency: code };
  const [currency, balanceDue] = [...merged.entries()].sort((a, b) => b[1] - a[1])[0];
  return { balanceDue, currency };
}

function describeOrder(order, status, now) {
  const endDate = order.subscription && order.subscription.endDate ? new Date(order.subscription.endDate) : null;

  // Whole days, rounded up: with 6 hours left a member should be told "1 day",
  // not "0".
  const daysLeft = endDate ? Math.ceil((endDate.getTime() - now.getTime()) / DAY_MS) : null;

  const sessionsLeft =
    order.sessions && order.sessions.total > 0 ? Math.max(0, order.sessions.total - (order.sessions.used || 0)) : null;

  return {
    status,
    orderId: order._id,
    packageName: (order.packageDetails && order.packageDetails.name) || 'Membership',
    endDate,
    daysLeft,
    sessionsLeft,
    balanceDue: balanceOf(order),
    currency: currencyOf(order)
  };
}

// The address guest checkouts are matched on -- compared exactly, as the
// query does, so an order the database would not return is never claimed.
function ownerEmail(user) {
  return user && user.email ? String(user.email).toLowerCase().trim() : null;
}

async function membershipFor(user) {
  const emailMatch = ownerEmail(user);
  const ownerClauses = [{ userId: user._id }];
  if (emailMatch) ownerClauses.push({ 'customerInfo.email': emailMatch });

  const [paidOrders, unpaid, owing] = await Promise.all([
    PackageOrder.find({ $or: ownerClauses, ...PAID_ORDER })
      .sort({ 'subscription.endDate': -1, createdAt: -1 })
      .limit(RECENT_PAID_ORDERS)
      .lean(),
    // The newest order still waiting for its money (see AWAITING_PAYMENT).
    PackageOrder.findOne({ $or: ownerClauses, ...AWAITING_PAYMENT })
      .sort({ createdAt: -1 })
      .lean(),
    // Every paid order with money still owed, however old (owedTotals).
    PackageOrder.find({ $or: ownerClauses, ...PAID_ORDER, 'payment.balanceDue': { $gt: 0 } })
      .select('payment.status payment.balanceDue payment.currency')
      .lean()
  ]);

  // The gym's currency is only needed to choose between two.
  const currency = owedTotals(owing).size > 1 ? await defaultCurrency() : null;
  return membershipFromOrders(paidOrders, unpaid, new Date(), { owing, currency });
}

// membershipFor's answer from orders already in hand: `paidOrders` newest end
// date first (then newest created), `unpaid` the newest order awaiting
// payment, or null. Pure, so the desk, the office's roster (membershipsFor)
// and the tests all reach the same verdict from the same orders.
//
// `owing`: the paid orders whose balances make up what the member owes --
// all of `paidOrders` unless given (membershipFor weighs only the latest few
// for the verdict and fetches those owing apart). `currency`: the gym's, to
// name when the money is owed in more than one (owedIn).
function membershipFromOrders(paidOrders, unpaid, now = new Date(), { owing = paidOrders, currency = null } = {}) {
  const answer = verdictFromOrders(paidOrders, unpaid, now);
  const owed = owedIn(owedTotals(owing), currency);
  return owed ? { ...answer, ...owed } : answer;
}

function verdictFromOrders(paidOrders, unpaid, now) {
  const recent = (paidOrders || []).slice(0, RECENT_PAID_ORDERS);

  // A paid membership that is in date wins over everything else: a renewal
  // sitting in the bank-transfer queue must not hide the term that is
  // running right now.
  //
  // Once any live term has begun, the newest-ending one is the answer even
  // if it has not begun itself: that is a renewal queued behind the running
  // term (it starts when that one ends), and the member is covered straight
  // through to its end -- "active, 32 days left", never "expires in 2 days"
  // to someone who has already renewed. (A term booked after a gap reads the
  // same until the gap comes: today, the member is covered either way.)
  const liveOrders = recent.filter((order) => isLiveOrder(order, now));
  if (liveOrders.some((order) => hasStarted(order, now))) {
    const live = liveOrders[0];
    const status = live.status === 'frozen' ? 'frozen' : live.status === 'past_due' ? 'past_due' : 'active';
    return describeOrder(live, status, now);
  }

  // Paid, but nothing has begun yet: a desk sale that starts in a few days.
  // Not covered today, so 'pending' -- the answer every reader already treats
  // as "not in force yet", never as lapsed -- with `startsOn` saying it is
  // the start date being waited on rather than the money. The one starting
  // soonest is the one the desk needs to name.
  if (liveOrders.length) {
    const next = liveOrders.reduce((soonest, order) =>
      new Date(order.subscription.startDate) < new Date(soonest.subscription.startDate) ? order : soonest
    );
    return { ...describeOrder(next, 'pending', now), startsOn: new Date(next.subscription.startDate) };
  }

  // Nothing live. If the most recent thing that happened is an order awaiting
  // payment confirmation, that is what the desk needs to hear.
  const latestPaid = recent[0] || null;
  if (unpaid && (!latestPaid || new Date(unpaid.createdAt) >= new Date(latestPaid.createdAt))) {
    return describeOrder(unpaid, 'pending', now);
  }

  if (!latestPaid) {
    return { status: 'none', orderId: null, packageName: '', endDate: null, daysLeft: null, sessionsLeft: null };
  }

  // Suspended is reported as such whatever the dates say: it is a decision,
  // not a lapse. A cancelled order that still has days on it is "cancelled,
  // N days left", never "expired N days ago".
  if (latestPaid.status === 'suspended') return describeOrder(latestPaid, 'suspended', now);
  const ended = !latestPaid.subscription || !latestPaid.subscription.endDate || new Date(latestPaid.subscription.endDate) < now;
  if (latestPaid.status === 'cancelled' && !ended) return describeOrder(latestPaid, 'cancelled', now);

  return describeOrder(latestPaid, 'expired', now);
}

// membershipFor's sorts, for orders fetched in bulk and sorted here instead:
// newest end date first (an order with none last), then newest created.
function timeOf(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

function newestEndFirst(a, b) {
  const byEnd =
    timeOf(b.subscription && b.subscription.endDate) - timeOf(a.subscription && a.subscription.endDate);
  return byEnd || timeOf(b.createdAt) - timeOf(a.createdAt) || 0;
}

function newestCreatedFirst(a, b) {
  return timeOf(b.createdAt) - timeOf(a.createdAt) || 0;
}

// Files `orders` under their owners, and answers "which of these are this
// user's" the way membershipFor's query does: by userId, or by an email that
// matches theirs exactly. Each order once, even when it matches on both -- a
// guest order later claimed by the account does.
function ordersByOwner(orders) {
  const byUser = new Map();
  const byEmail = new Map();
  const file = (map, key, order) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(order);
  };

  for (const order of orders || []) {
    if (order.userId) file(byUser, String(order.userId), order);
    if (order.customerInfo && order.customerInfo.email) file(byEmail, order.customerInfo.email, order);
  }

  return (user) => {
    const email = ownerEmail(user);
    const mine = new Map();
    for (const order of byUser.get(String(user._id)) || []) mine.set(String(order._id), order);
    for (const order of (email && byEmail.get(email)) || []) mine.set(String(order._id), order);
    return Array.from(mine.values());
  };
}

/**
 * membershipFor for many members at once, from orders already fetched for
 * all of them: each member is answered from exactly the orders membershipFor
 * would have fetched for them alone. Pure. Keyed by String(user._id).
 */
function membershipsFromOrders(users, paidOrders, unpaidOrders, now = new Date(), { currency = null } = {}) {
  const paidOf = ordersByOwner(paidOrders);
  const unpaidOf = ordersByOwner(unpaidOrders);

  const index = new Map();
  for (const user of users || []) {
    const paid = paidOf(user).sort(newestEndFirst);
    const unpaid = unpaidOf(user).sort(newestCreatedFirst)[0] || null;
    // Every paid order of theirs is here, so what they owe is read off all of them.
    index.set(String(user._id), membershipFromOrders(paid, unpaid, now, { currency }));
  }
  return index;
}

/**
 * membershipFor for a whole page of members -- two queries however many
 * there are, where asking one by one would be two each. The admin roster
 * uses this, so the office and the desk give the same answer for the same
 * member: a cancelled plan still running is "cancelled", never "expired",
 * and a suspended one is never "active".
 */
async function membershipsFor(users, now) {
  if (!users || !users.length) return new Map();

  const emails = users.map(ownerEmail).filter(Boolean);
  const owners = {
    $or: [{ userId: { $in: users.map((user) => user._id) } }, { 'customerInfo.email': { $in: emails } }]
  };

  // Only what membershipFromOrders reads, plus the two owner fields.
  const fields =
    'userId customerInfo.email packageDetails.name subscription sessions status createdAt ' +
    'payment.status payment.balanceDue payment.currency';
  const [paidOrders, unpaidOrders] = await Promise.all([
    PackageOrder.find({ ...owners, ...PAID_ORDER }).select(fields).lean(),
    PackageOrder.find({ ...owners, ...AWAITING_PAYMENT }).select(fields).lean()
  ]);

  // The gym's currency is only needed when money is owed in more than one.
  const currency = owedTotals(paidOrders).size > 1 ? await defaultCurrency() : null;
  return membershipsFromOrders(users, paidOrders, unpaidOrders, now || new Date(), { currency });
}

// The directory's entries as they go out to the desk. `codes` -- every code
// that answers to the person -- stays here, for findByCode.
function shown({ person_type, id, name, code, meta }) {
  return { person_type, id, name, code, meta };
}

// Everyone who could put a finger on the reader, for the enrolment picker and
// the manual-lookup list. `q` filters server-side so a desk searching by
// phone number does not have to pull the whole directory first.
async function listPeople(options) {
  const { members, staff } = await searchDirectory(options);
  return { members: members.map(shown), staff: staff.map(shown) };
}

// listPeople's answer with every entry's `codes` still on it.
async function searchDirectory({ q = '', limit = MAX_DIRECTORY } = {}) {
  const term = String(q || '').trim();
  const rx = term ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

  const userFilter = { isActive: true, role: { $ne: 'admin' } };
  const trainerFilter = { isActive: true };

  if (rx) {
    userFilter.$or = [
      { firstName: rx },
      { lastName: rx },
      { email: rx },
      { phone: rx },
      { memberCode: rx }
    ];
    trainerFilter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { staffCode: rx }];
  }

  // Staff accounts are Users holding a staff role, and they punch on the same
  // reader as the trainers do. Their filter is the member one minus the staff
  // flag, so nobody appears in both lists.
  const staffUserFilter = { isActive: true, 'employment.isStaff': true };
  if (rx) staffUserFilter.$or = [...userFilter.$or || [], { staffCode: rx }, { 'employment.jobTitle': rx }];
  userFilter['employment.isStaff'] = { $ne: true };

  const staffUserFields = 'firstName lastName email phone staffCode employment.jobTitle';

  const [users, trainers, staffUsers] = await Promise.all([
    User.find(userFilter)
      .select('firstName lastName email phone memberCode')
      .sort({ firstName: 1, lastName: 1 })
      .limit(limit)
      .lean(),
    Trainer.find(trainerFilter)
      .select('name email phone staffCode role userId')
      .sort({ name: 1 })
      .limit(limit)
      .lean(),
    User.find(staffUserFilter)
      .select(staffUserFields)
      .sort({ firstName: 1, lastName: 1 })
      .limit(limit)
      .lean()
  ]);

  // The staff accounts behind any trainer the search found, so a trainer who
  // is also on the staff can be listed as the account (see staffEntries).
  const linkedIds = trainers.filter((trainer) => trainer.userId).map((trainer) => trainer.userId);
  const accounts = linkedIds.length
    ? await User.find({ _id: { $in: linkedIds }, ...STAFF_ACCOUNT }).select(staffUserFields).lean()
    : [];

  const members = users.map((user) => ({
    person_type: 'member',
    id: String(user._id),
    name: fullName(user),
    code: user.memberCode || '',
    meta: user.phone || user.email || '',
    codes: [user.memberCode]
  }));

  return { members, staff: staffEntries(trainers, staffUsers, accounts) };
}

/**
 * The staff half of the directory, from what its queries found: `trainers`,
 * the staff accounts the search matched (`staffUsers`), and `accounts` -- the
 * staff accounts some of those trainers are linked to. A trainer linked to
 * one of `accounts` is listed once, as that account (see "Trainers who are
 * also staff"), even when it was only the trainer profile the search matched:
 * its TR- code, say, goes on answering to them. Pure.
 */
function staffEntries(trainers, staffUsers, accounts) {
  const accountIds = new Set(accounts.map((user) => String(user._id)));
  const staffById = new Map();
  for (const user of staffUsers.concat(accounts)) staffById.set(String(user._id), user);

  const ownTrainers = [];
  const trainerCodes = new Map(); // User id -> the codes of their trainer profiles
  for (const trainer of trainers) {
    const owner = trainer.userId ? String(trainer.userId) : null;
    if (!owner || !accountIds.has(owner)) {
      ownTrainers.push(trainer);
      continue;
    }
    if (!trainerCodes.has(owner)) trainerCodes.set(owner, []);
    if (trainer.staffCode) trainerCodes.get(owner).push(trainer.staffCode);
  }

  return ownTrainers
    .map((trainer) => ({
      person_type: 'staff',
      id: String(trainer._id),
      name: trainer.name,
      code: trainer.staffCode || '',
      meta: trainer.role || trainer.phone || trainer.email || '',
      codes: [trainer.staffCode]
    }))
    .concat(
      Array.from(staffById.values()).map((user) => {
        const aliases = trainerCodes.get(String(user._id)) || [];
        return {
          person_type: 'staff',
          id: String(user._id),
          name: fullName(user),
          // Their own code; the trainer profile's only until they have one.
          code: user.staffCode || aliases[0] || '',
          meta: (user.employment && user.employment.jobTitle) || user.phone || user.email || '',
          codes: [user.staffCode, ...aliases]
        };
      })
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Loads one person by (type, id) and normalises them, assigning a front-desk
// code if this is the first time they have needed one. Returns null when the
// row is gone or deactivated -- a fingerprint can outlive the person it
// belongs to, and a punch for a deleted member must fail cleanly.
async function resolvePerson(personType, personId) {
  if (personType === 'member') {
    const user = await User.findById(personId);
    if (!user || !user.isActive) return null;

    return {
      personType: 'member',
      id: user._id,
      name: fullName(user),
      code: await ensureMemberCode(user),
      record: user
    };
  }

  if (personType === 'staff') {
    const trainer = await Trainer.findById(personId);
    if (trainer) {
      // A trainer who is also on the staff punches as that account (see
      // "Trainers who are also staff") -- even with the website profile
      // switched off, since the person still works here.
      const account = trainer.userId ? await User.findOne({ _id: trainer.userId, ...STAFF_ACCOUNT }) : null;
      if (account) return staffAccountPerson(account);

      if (!trainer.isActive) return null;
      return {
        personType: 'staff',
        id: trainer._id,
        name: trainer.name,
        code: await ensureStaffCode(trainer),
        record: trainer
      };
    }

    // Not a trainer, so it is one of the other people who work here -- a
    // receptionist, a cleaner, a manager.
    const user = await User.findById(personId);
    if (!user || !user.isActive || !user.employment || !user.employment.isStaff) return null;
    return staffAccountPerson(user);
  }

  return null;
}

// A staff account as resolvePerson answers it. Their roster lives on
// employment.schedule; it is surfaced here as `availability` so the shift
// verdicts in punchService read one shape and never learn there are two
// kinds of staff. `aliasIds` are the trainer profiles linked to the account:
// punches and fingers from before the desk treated the two as one person can
// still be filed under those.
async function staffAccountPerson(user) {
  const record = user.toObject();
  record.availability = (user.employment.schedule || []).map((shift) => ({
    day: shift.day,
    startTime: shift.startTime,
    endTime: shift.endTime
  }));
  record.role = user.employment.jobTitle || user.role;

  const [code, profiles] = await Promise.all([ensureUserStaffCode(user), trainerProfilesOf([user._id])]);

  return {
    personType: 'staff',
    id: user._id,
    name: fullName(user),
    code,
    record,
    aliasIds: profiles.get(String(user._id)) || []
  };
}

/**
 * resolvePerson for a whole list at once, as far as "still on file, and as
 * whom": for each 'member:<id>' / 'staff:<id>' key, out of `pairs` ({
 * personType, personId }), that belongs to someone who could still punch, the
 * id the desk knows them by -- their own, except for a trainer who is also on
 * the staff, who is known by the staff account. A Map, so `.has(key)` is the
 * "still here" test. A handful of queries however long the list, where
 * resolving one by one would be one each.
 */
async function activePersonKeys(pairs) {
  const memberIds = [];
  const staffIds = [];
  for (const pair of pairs) {
    if (pair.personType === 'member') memberIds.push(pair.personId);
    else if (pair.personType === 'staff') staffIds.push(pair.personId);
  }

  const [members, trainers, staffUsers, accounts] = await Promise.all([
    memberIds.length ? User.find({ _id: { $in: memberIds }, isActive: true }).select('_id').lean() : [],
    staffIds.length ? Trainer.find({ _id: { $in: staffIds }, isActive: true }).select('_id').lean() : [],
    staffIds.length ? User.find({ _id: { $in: staffIds }, ...STAFF_ACCOUNT }).select('_id').lean() : [],
    staffAccountsFor(staffIds)
  ]);

  const keys = new Map();
  for (const row of members) keys.set('member:' + String(row._id), String(row._id));
  for (const row of trainers.concat(staffUsers)) keys.set('staff:' + String(row._id), String(row._id));
  // Last, so a linked trainer is answered as the account whatever else held.
  for (const [trainerId, userId] of accounts) keys.set('staff:' + trainerId, userId);
  return keys;
}

/**
 * The one person whose member or staff code matches exactly. Case does not
 * matter; a search that merely contains the code does not count. A trainer
 * who is also on the staff answers to both codes, as the staff account.
 */
async function findByCode(code) {
  const clean = String(code || '').trim();
  if (!clean) return null;
  const { members, staff } = await searchDirectory({ q: clean, limit: 25 });
  const wanted = clean.toLowerCase();
  const found = [...members, ...staff].find((person) =>
    person.codes.some((candidate) => String(candidate || '').toLowerCase() === wanted)
  );
  return found ? shown(found) : null;
}

module.exports = {
  activePersonKeys,
  findByCode,
  fullName,
  assignMemberCode,
  ensureMemberCode,
  ensureStaffCode,
  ensureUserStaffCode,
  membershipFor,
  membershipFromOrders,
  membershipsFor,
  membershipsFromOrders,
  listPeople,
  resolvePerson,
  staffAccountsFor,
  staffEntries,
  trainerProfilesOf
};
