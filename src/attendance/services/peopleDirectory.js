// src/attendance/services/peopleDirectory.js
//
// The attendance app treats two very different records as the same kind of
// thing -- a person who can put a finger on the reader. Members are Users;
// staff are Trainers. This module is the only place that knows that, so
// everything downstream (punching, enrolment, lookup) works in one shape:
//
//   { personType, id, name, code, meta }
//
// It also owns the short front-desk codes ("GP-0184", "TR-004"). Those are
// assigned lazily rather than backfilled by a migration: an account only
// needs one the first time it shows up at the desk, and generating them on
// demand means this feature can be deployed without touching existing rows.

const User = require('../../models/user');
const Trainer = require('../../gymfolio/models/trainerModel');
const PackageOrder = require('../../gymfolio/models/packageOrderModel');

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
// person is first seen, so it is not on any hot path.
async function nextSequentialCode(Model, field, prefix) {
  const last = await Model.findOne({ [field]: new RegExp('^' + prefix) })
    .sort({ [field]: -1 })
    .select(field)
    .lean();

  let sequence = 1;
  if (last && last[field]) {
    const parsed = parseInt(String(last[field]).slice(prefix.length), 10);
    if (!Number.isNaN(parsed)) sequence = parsed + 1;
  }

  return prefix + String(sequence).padStart(4, '0');
}

// Both of these tolerate a lost race: two desks enrolling two people at the
// same instant can generate the same code, and the unique index rejects one
// of them. Re-reading is correct there -- the other writer's code is now the
// truth, and this person simply takes the next one.
async function ensureMemberCode(user) {
  if (user.memberCode) return user.memberCode;

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await nextSequentialCode(User, 'memberCode', MEMBER_PREFIX);
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

async function ensureStaffCode(trainer) {
  if (trainer.staffCode) return trainer.staffCode;

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await nextSequentialCode(Trainer, 'staffCode', STAFF_PREFIX);
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

// The membership behind a member, as it stands right now.
//
// Guest checkouts are matched by email as well as by userId: someone can buy
// a package before ever creating an account, then sign up with the same
// address, and the front desk should still see the package they paid for.
async function membershipFor(user) {
  const emailMatch = user.email ? String(user.email).toLowerCase().trim() : null;
  const ownerClauses = [{ userId: user._id }];
  if (emailMatch) ownerClauses.push({ 'customerInfo.email': emailMatch });

  const paidOrders = await PackageOrder.find({
    $or: ownerClauses,
    'payment.status': 'paid'
  })
    .sort({ 'subscription.endDate': -1, createdAt: -1 })
    .limit(5)
    .lean();

  if (!paidOrders.length) {
    return { status: 'none', orderId: null, packageName: '', endDate: null, daysLeft: null };
  }

  const now = new Date();
  const live = paidOrders.find(
    (order) =>
      order.status !== 'cancelled' &&
      order.subscription &&
      order.subscription.endDate &&
      new Date(order.subscription.endDate) >= now
  );

  const chosen = live || paidOrders[0];
  const endDate = chosen.subscription && chosen.subscription.endDate
    ? new Date(chosen.subscription.endDate)
    : null;

  // Whole days, rounded up: with 6 hours left a member should be told "1 day",
  // not "0".
  const daysLeft = endDate
    ? Math.ceil((endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  return {
    status: live ? 'active' : 'expired',
    orderId: chosen._id,
    packageName: (chosen.packageDetails && chosen.packageDetails.name) || 'Membership',
    endDate,
    daysLeft
  };
}

// Everyone who could put a finger on the reader, for the enrolment picker and
// the manual-lookup list. `q` filters server-side so a desk searching by
// phone number does not have to pull the whole directory first.
async function listPeople({ q = '', limit = MAX_DIRECTORY } = {}) {
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

  const [users, trainers] = await Promise.all([
    User.find(userFilter)
      .select('firstName lastName email phone memberCode')
      .sort({ firstName: 1, lastName: 1 })
      .limit(limit)
      .lean(),
    Trainer.find(trainerFilter)
      .select('name email phone staffCode role')
      .sort({ name: 1 })
      .limit(limit)
      .lean()
  ]);

  const members = users.map((user) => ({
    person_type: 'member',
    id: String(user._id),
    name: fullName(user),
    code: user.memberCode || '',
    meta: user.phone || user.email || ''
  }));

  const staff = trainers.map((trainer) => ({
    person_type: 'staff',
    id: String(trainer._id),
    name: trainer.name,
    code: trainer.staffCode || '',
    meta: trainer.role || trainer.phone || trainer.email || ''
  }));

  return { members, staff };
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
    if (!trainer || !trainer.isActive) return null;

    return {
      personType: 'staff',
      id: trainer._id,
      name: trainer.name,
      code: await ensureStaffCode(trainer),
      record: trainer
    };
  }

  return null;
}

module.exports = {
  fullName,
  ensureMemberCode,
  ensureStaffCode,
  membershipFor,
  listPeople,
  resolvePerson
};
