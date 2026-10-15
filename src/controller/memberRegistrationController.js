// src/controller/memberRegistrationController.js
//
// The desk's one-screen "Add member": the member's account, the membership
// sold with it and the money taken, in one request -- the way a gym's front
// desk actually signs somebody up, instead of creating the account on Users
// and then finding them again on Package Orders.
//
// POST /api/admin/members/register
//
//   { firstName, lastName, email?, phone?, gender?, dateOfBirth?, address?,
//     staffNotes?, credentials?: 'email' | 'show' | 'set', password?,
//     requestId?,
//     membership?: { packageId, paymentMethod?, markPaid?, couponCode?,
//       durationMonths?, startDate? | startAfterDays?, discountAmount?,
//       discountNote?, amountOverride?, waiveJoiningFee? | joiningFeeOverride?,
//       amountPaid?, trainerId?, trainerFee?, trainerCommissionType?,
//       trainerCommissionValue?, notes? } }
//
// `joiningFeeOverride` is this desk's own: an admission fee other than the
// package's (a promotion, a family rate), charged as the admission fee --
// so the accounts count it as admission, which an override of the whole
// total (`amountOverride`) cannot do. Not with waiveJoiningFee. The order's
// package snapshot records the fee as charged.
//
//   → 201 { success, message, member, order (null without a membership),
//           credentials, emailed, emailError, password? }
//
// The same person twice: before anything is made, the phone number (in any
// of its forms -- 0301-1234567, 03011234567, +923011234567) and the email
// are looked up. A member already on that phone is a 409 POSSIBLE_DUPLICATE
// naming them (details.matches: id, name, member code), and the desk either
// opens that member or sends the request again with `confirmDuplicate: true`
// -- a family can share one phone. An email already on an account is a 409
// EMAIL_IN_USE naming its owner: two accounts cannot share one address, so
// that one cannot be confirmed past.
//
// `requestId` (or membership.requestId, which the website sends): the desk's
// own id for this attempt -- 8 to 100 letters, digits, hyphens or
// underscores, a UUID will do -- sent again unchanged when the answer never
// arrived. It is kept on the account the request makes. Sent again, nothing
// is created: the answer is that member and their order, `repeated: true`,
// and a message saying so. The password is not in it -- it was shown, or
// emailed, once, and only its hash is kept -- so the message says where to
// set one. Without it a member with no email, who cannot be told apart by
// their address, was added and charged twice. Left out, every request is
// new, as before.
//
// The account is made exactly as POST /admin/users makes it
// (userController.createMemberAccount: its rules, member ID, password
// hand-over), always as a plain member; the membership exactly as POST
// /package-orders/assign sells it (membershipService.readDeskTerms and
// createManualOrder). Gate: users · manage on the route; a membership also
// needs package-orders · manage, checked here rather than with a second
// requirePermission so the request is one entry in the audit log.
//
// The registration date is the day the account is created. It is never read
// from the request: a body naming one is refused, not quietly ignored (the
// CSV import is the only way to bring an earlier joining date across).
//
// All or nothing: when the membership cannot be sold the new account is
// deleted again, with everything it had made, and the answer is the
// order's own refusal -- never a member half registered with no membership.

const mongoose = require('mongoose');
const User = require('../models/user');
const Package = require('../gymfolio/models/packageModel');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Trainer = require('../gymfolio/models/trainerModel');
const membership = require('../gymfolio/services/membershipService');
const { createMemberAccount, releaseAccount } = require('./userController');
const { publicUserView } = require('../services/userView');
const { can } = require('../services/roleService');
const { readDeskMethod } = require('../services/paymentMethods');
const { parseAmount } = require('../helper/money');
const { samePhonePattern } = require('../services/phoneMatch');
const notify = require('../services/gymNotifications');
const { afterResponse } = require('../services/afterResponse');

const { MembershipError } = membership;

// What the member part of the form may send; anything else about the account
// (role, tags, health, documents) is edited on Users afterwards.
const MEMBER_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'gender', 'dateOfBirth', 'address', 'staffNotes', 'credentials', 'password'];

// A joining date the desk might try to send. Registration is today.
const DATE_FIELDS = ['createdAt', 'joinedAt', 'registeredAt', 'registrationDate', 'joiningDate'];

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function refuse(res, status, message, code) {
  return res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
}

/**
 * The membership block, read and checked before any account exists.
 *
 * Everything createManualOrder would refuse that does not need the account
 * is refused here first: an account made -- and emailed its password -- only
 * to be deleted again a moment later would leave the member holding a
 * password for nothing. createManualOrder still checks it all again (it is
 * the authority on a sale); what it refuses anyway is rolled back by
 * register() below.
 *
 * @returns {Promise<{ pkg, terms, markPaid, durationMonths, couponCode }>}
 * @throws {MembershipError}
 */
async function readSale(block, { email }) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new MembershipError('membership must be an object with the package and its terms', 400, 'INVALID_TERMS');
  }
  if (!present(block.packageId)) throw new MembershipError('Choose the package (membership.packageId)', 400, 'INVALID_TERMS');
  if (!mongoose.Types.ObjectId.isValid(String(block.packageId))) throw new MembershipError('Package not found', 404, 'PACKAGE_NOT_FOUND');

  const terms = membership.readDeskTerms(block);
  const markPaid = block.markPaid !== false && block.markPaid !== 'false';
  const couponCode = present(block.couponCode) ? String(block.couponCode) : undefined;

  let joiningFeeOverride;
  if (present(block.joiningFeeOverride)) {
    if (terms.chargeJoiningFee === false) {
      throw new MembershipError('Waive the admission fee or charge a different one, not both', 400, 'INVALID_TERMS');
    }
    const fee = typeof block.joiningFeeOverride === 'number' ? block.joiningFeeOverride : parseAmount(block.joiningFeeOverride);
    if (fee === null || !Number.isFinite(fee) || fee < 0) {
      throw new MembershipError('joiningFeeOverride must be an amount of 0 or more', 400, 'INVALID_TERMS');
    }
    joiningFeeOverride = round2(fee);
  }

  const found = await Package.findById(block.packageId);
  if (!found) throw new MembershipError('Package not found', 404, 'PACKAGE_NOT_FOUND');
  // The package as this sale charges it: createManualOrder takes the
  // admission fee from the package, so a different one is handed over there.
  const pkg = joiningFeeOverride === undefined ? found : Object.assign(found.toObject(), { joiningFee: joiningFeeOverride });

  const listPrice = parseAmount(pkg.price);
  if (listPrice === null) {
    throw new MembershipError(`Package "${pkg.name}" has an unreadable price (${JSON.stringify(pkg.price)}). Fix it on the Packages screen first.`, 422);
  }
  const { problem } = readDeskMethod(terms.paymentMethod);
  if (problem) throw new MembershipError(problem, 422, 'PAYMENT_METHOD_INVALID');

  let trainerFee = 0;
  if (terms.trainer) {
    const coach = await Trainer.findById(terms.trainer.trainerId).select('name isActive').lean();
    if (!coach) throw new MembershipError('That trainer was not found', 404, 'TRAINER_NOT_FOUND');
    if (coach.isActive === false) throw new MembershipError(`${coach.name} is not an active trainer`, 409, 'TRAINER_INACTIVE');
    trainerFee = round2(terms.trainer.fee);
  }

  // The total the order will charge, summed as createManualOrder sums it,
  // so money taken now can be checked against it. A brand-new account has
  // no orders of its own; only a guest order under the same email can mean
  // the member has joined before.
  if (terms.amountPaid !== undefined) {
    let discount = round2(terms.discountAmount || 0);
    if (couponCode) discount = round2(discount + (await membership.applyCoupon(couponCode, pkg, listPrice)).discount);
    const feeDue = terms.chargeJoiningFee === false ? false : await membership.joiningFeeDue({ email });
    const joiningFee = feeDue ? round2(pkg.joiningFee) : 0;
    const total = terms.amountOverride !== undefined
      ? terms.amountOverride
      : round2(listPrice - Math.min(discount, listPrice) + joiningFee + trainerFee);
    if (!markPaid && terms.amountPaid > 0) {
      throw new MembershipError('An order left pending has nothing paid yet: mark it paid to take part of the money now', 400, 'INVALID_TERMS');
    }
    if (terms.amountPaid > total) throw new MembershipError(`amountPaid cannot be more than the ${total} charged`, 400, 'INVALID_TERMS');
  } else if (couponCode) {
    await membership.applyCoupon(couponCode, pkg, listPrice);
  }

  return { pkg, terms, markPaid, durationMonths: block.durationMonths, couponCode };
}

// Said when the request is one already carried out. The password cannot be
// given again, so the message says what to do about that.
const ALREADY_ADDED = 'This member was already added a moment ago, so nothing was added again. If you did not see their password, open their profile to set one.';

/**
 * The answer to an "Add member" request whose id an account already
 * carries: that member and the order the first request sold them, with
 * nothing created. Null when no account has the id -- the request is new.
 */
async function repeatOf(requestId) {
  if (!requestId) return null;
  const member = await User.findOne({ registrationRequestId: requestId });
  if (!member) return null;
  const order = await PackageOrder.findOne({ userId: member._id, 'metadata.requestId': requestId });
  return {
    success: true,
    repeated: true,
    message: ALREADY_ADDED,
    member: publicUserView(member),
    order: order || null,
    credentials: null,
    emailed: false,
    emailError: null
  };
}

/**
 * Undoes an account this request made a moment ago: its orders (a sale that
 * failed part-way may have saved one), the account, and what saving it
 * published -- the username in the platform directory (releaseAccount). No
 * one else can have touched it yet.
 */
async function undoRegistration(user) {
  await PackageOrder.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });
  await releaseAccount(user);
}

function nameOf(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.username || 'A member';
}

function confirmed(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Who is already on file with this email or phone number, before a second
 * account is made for the same person. Resolves to null (nobody), or
 * { status, body } to answer with -- or { repeat: true } when the match is
 * the account this very request made a moment ago (two copies at once).
 */
async function duplicateCheck(body, requestId) {
  const email = String(body.email || '').toLowerCase().trim();
  const phoneRx = samePhonePattern(body.phone);
  if (!email && !phoneRx) return null;

  const fields = 'firstName lastName email phone memberCode username role isActive registrationRequestId';
  const [byEmail, byPhone] = await Promise.all([
    email ? User.findOne({ email }).select(fields).lean() : null,
    phoneRx ? User.find({ role: 'user', phone: phoneRx }).select(fields).sort({ createdAt: 1 }).limit(5).lean() : []
  ]);
  const ours = (user) => requestId && user.registrationRequestId === requestId;
  if ((byEmail && ours(byEmail)) || byPhone.some(ours)) return { repeat: true };

  const match = (user, matchedOn) => ({
    id: String(user._id),
    name: nameOf(user),
    memberCode: user.memberCode || null,
    phone: user.phone || '',
    email: user.email || '',
    isActive: user.isActive !== false,
    isMember: user.role === 'user',
    matchedOn
  });
  const named = (user) => `${nameOf(user)}${user.memberCode ? ` (${user.memberCode})` : ''}`;

  // An address belongs to one account: refused whatever the desk confirms.
  if (byEmail) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'EMAIL_IN_USE',
        message: `${email} is already used by ${named(byEmail)}. Open their record, or leave the email empty (or use another) to register someone new.`,
        details: { matches: [match(byEmail, ['email'])], canRegisterAnyway: false }
      }
    };
  }
  if (byPhone.length && !confirmed(body.confirmDuplicate)) {
    const first = byPhone[0];
    const who = byPhone.length > 1 ? `${named(first)} and ${byPhone.length - 1} more are` : `${named(first)} is`;
    return {
      status: 409,
      body: {
        success: false,
        code: 'POSSIBLE_DUPLICATE',
        message: `${who} already registered with the phone number ${first.phone}. Open their record if this is the same person, or register anyway if it is someone else (a family can share one phone).`,
        details: { matches: byPhone.map((user) => match(user, ['phone'])), canRegisterAnyway: true }
      }
    };
  }
  return null;
}

const memberRegistrationController = {
  async register(req, res) {
    const body = req.body || {};

    const dated = DATE_FIELDS.find((field) => present(body[field]));
    if (dated) {
      return refuse(res, 400, `The registration date is today and cannot be set here (${dated}). A membership can start later: membership.startDate or startAfterDays.`, 'REGISTRATION_DATE_LOCKED');
    }
    if (present(body.role) && String(body.role).toLowerCase().trim() !== 'user') {
      return refuse(res, 400, 'Add member registers members. Give staff their role on Users or Staff.', 'INVALID_ROLE');
    }

    const selling = present(body.membership);
    let sale = null;
    let requestId;
    try {
      if (selling) {
        // Selling is a package-orders write, as on Package Orders.
        const role = req.roleSlug || (req.user && req.user.role) || '';
        if (!(await can(role, 'package-orders', 'manage'))) {
          return refuse(res, 403, 'Your role does not have manage access to package-orders.');
        }
      }
      // This attempt's id, wherever the desk put it. Asked before the sale
      // is read: a repeat must not be refused over something the first
      // request itself used up (a coupon's last redemption, the plan's last
      // free place).
      const block = selling && typeof body.membership === 'object' ? body.membership : {};
      requestId = membership.readRequestId(present(body.requestId) ? body.requestId : block.requestId);
      const repeat = await repeatOf(requestId);
      if (repeat) return res.status(201).json(repeat);

      // The same person registered twice at the desk: asked before the sale
      // is read, so the desk hears about it first.
      const duplicate = await duplicateCheck(body, requestId);
      if (duplicate && duplicate.repeat) {
        const made = await repeatOf(requestId);
        if (made) return res.status(201).json(made);
      } else if (duplicate) {
        return res.status(duplicate.status).json(duplicate.body);
      }

      if (selling) sale = await readSale(body.membership, { email: String(body.email || '').toLowerCase().trim() });
    } catch (error) {
      if (error instanceof MembershipError) return refuse(res, error.status || 400, error.message, error.code);
      console.error('[register] could not read the membership:', error);
      return refuse(res, 500, error.message || 'Could not check the membership');
    }

    const memberBody = { role: 'user' };
    for (const field of MEMBER_FIELDS) if (body[field] !== undefined) memberBody[field] = body[field];

    const account = await createMemberAccount(req, memberBody, { registrationRequestId: requestId });
    if (!account.user) {
      // The same request arriving twice at once: the other copy made the
      // member between the lookup above and here (the index on the id
      // refused this one). Answered as the repeat it is.
      const repeat = await repeatOf(requestId).catch(() => null);
      if (repeat) return res.status(201).json(repeat);
      return res.status(account.status).json({ success: false, ...account.body });
    }
    const { user } = account;

    let order = null;
    if (sale) {
      try {
        order = await membership.createManualOrder({
          ...sale.terms,
          user,
          pkg: sale.pkg,
          markPaid: sale.markPaid,
          durationMonths: sale.durationMonths,
          couponCode: sale.couponCode,
          // On the order too, so a repeat finds the sale with the member.
          requestId,
          paidBy: req.user ? req.user._id || req.user.id : null,
          by: req.user && req.user.email
        });
      } catch (error) {
        try {
          await undoRegistration(user);
        } catch (undoError) {
          console.error('[register] could not remove', String(user._id), 'after the sale failed:', undoError);
          return refuse(res, 500, `The membership could not be sold (${error.message}), and the new member could not be removed again. Delete them on Users before trying again.`, 'REGISTRATION_INCOMPLETE');
        }
        if (error instanceof MembershipError) return refuse(res, error.status || 400, error.message, error.code);
        console.error('[register] the membership could not be sold:', error);
        return refuse(res, 500, error.message || 'Could not sell the membership');
      }
      if (order.payment.status === 'paid') afterResponse(notify.membershipConfirmed(order, user), 'membershipConfirmed');
    }

    if (account.noStore) res.setHeader('Cache-Control', 'no-store');
    const { message, emailed, emailError, credentials, password, data } = account.body;
    return res.status(201).json({
      success: true,
      message: order ? `${message}. ${sale.pkg.name} sold.` : message,
      member: data,
      order,
      credentials,
      emailed,
      emailError,
      ...(password ? { password } : {})
    });
  }
};

module.exports = memberRegistrationController;
