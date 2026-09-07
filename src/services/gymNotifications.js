// src/services/gymNotifications.js
//
// The one place that decides what a gym event should tell somebody.
//
// Three rules run through all of it.
//
// First, sending is never allowed to break the thing that triggered it. A
// member books a class; if SMTP is misconfigured the booking still stands and
// the failure goes to the log. Every function here swallows its own errors and
// callers fire them without awaiting.
//
// Second, nothing is hardcoded to a brand. The gym's name, its address and the
// links in the footer all come from the Settings document, so a template says
// "your membership at X" without this file knowing what X is.
//
// Third, email is one channel of several. Each event also goes out as a short
// text on whichever of SMS / WhatsApp / push the gym has switched on
// (Settings → Messaging) and the member has not switched off (their
// notification preferences). A gym's own wording, where it has set one,
// replaces the built-in text (services/templateService.js).

const Settings = require('../models/settings');
const User = require('../models/user');
const { sendEmail } = require('./emailService');
const t = require('../templates/gymEmails');
const templates = require('./templateService');
const messaging = require('./messaging');
const { tenantKey, frontendOrigin } = require('../platform/tenantContext');

// Settings are read on nearly every notification and change about once a year,
// so they are cached briefly rather than fetched per email. One entry per gym:
// the name and the links in the footer belong to the gym the email is about.
const SETTINGS_TTL_MS = 60 * 1000;
const brands = new Map(); // tenantKey -> { at, value }

async function brand() {
  const key = tenantKey();
  const hit = brands.get(key);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;

  let siteName = process.env.SITE_NAME || 'GymPilot';
  let notificationsOn = true;
  // Which text channels carry the transactional notices, beyond email.
  let channels = { sms: false, whatsapp: false, push: true };

  try {
    const settings = await Settings.getSettings();
    if (settings) {
      if (settings.siteName) siteName = settings.siteName;
      // The admin switch on the Settings screen. Off means transactional gym
      // email stops -- which is a decision a gym is allowed to make.
      notificationsOn = settings.emailNotifications !== false;
      const tx = settings.messaging && settings.messaging.transactional;
      if (tx) channels = { sms: !!tx.sms, whatsapp: !!tx.whatsapp, push: tx.push !== false };
    }
  } catch {
    // No database, or no settings row yet. Fall back rather than fail: an
    // email with a generic name is better than no email.
  }

  // The gym's own website, from its registered domain -- never from env,
  // which would send every gym's members to the first gym's site.
  const frontend = frontendOrigin();

  const value = {
    siteName,
    notificationsOn,
    channels,
    portalUrl: `${frontend}/user-detail?tab=bookings`,
    accountUrl: `${frontend}/user-detail`,
    timetableUrl: `${frontend}/timetable`,
    renewUrl: `${frontend}/packages`
  };
  brands.set(key, { at: Date.now(), value });
  return value;
}

/** Clears the settings cache — used by tests and after a settings save. */
function resetBrandCache() {
  brands.delete(tenantKey());
}

/**
 * The member with the fields the channels need. Callers hand over whatever
 * they have -- a full document, a lean projection with just an email -- and
 * this fills in the phone number and preferences when they are missing.
 */
async function enrich(member) {
  if (!member) return null;
  const base = typeof member.toObject === 'function' ? member.toObject() : member;
  const id = base._id || base.id;
  if (!id) return base;
  if (base.notificationPreferences !== undefined && base.phone !== undefined) return base;
  try {
    const full = await User.findById(id).select('firstName lastName email phone notificationPreferences').lean();
    return full ? { ...base, ...full } : base;
  } catch {
    return base;
  }
}

/**
 * The single exit point for email. Everything below funnels through here so
 * there is one place that checks whether email is switched on, one place
 * that logs, and one place that guarantees a failure cannot propagate.
 */
async function deliver(to, built, context, options = {}) {
  try {
    if (!to) return { success: false, skipped: 'no address' };

    const { notificationsOn } = await brand();
    if (!notificationsOn) return { success: false, skipped: 'email notifications are off' };

    const prefs = options.member && options.member.notificationPreferences;
    if (prefs && prefs.email === false) return { success: false, skipped: 'member has email off' };

    const result = await sendEmail(to, built.subject, built.html, options);
    if (!result.success) {
      console.error(`[notify] ${context} -> ${to} failed:`, result.error);
    }
    return result;
  } catch (error) {
    console.error(`[notify] ${context} -> ${to} threw:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * The same event as a short text, on the channels that are on. Fired and
 * forgotten by every event below; nothing waits on a carrier.
 */
async function fanOut(member, key, vars, context, url) {
  try {
    if (!member || !member._id) return;
    const b = await brand();
    const prefs = member.notificationPreferences || {};
    const text = await templates.renderText(key, vars);
    if (!text) return;

    const phone = member.phone;
    if (b.channels.sms && prefs.sms !== false && phone) {
      messaging.sendSms(phone, text, { context, userId: member._id }).catch(() => {});
    }
    if (b.channels.whatsapp && prefs.whatsapp !== false && phone) {
      messaging.sendWhatsApp(phone, text, { context, userId: member._id }).catch(() => {});
    }
    if (b.channels.push && prefs.push !== false) {
      messaging.sendPush(member._id, { title: b.siteName, body: text, url: url || b.accountUrl }, { context }).catch(() => {});
    }
  } catch (error) {
    console.error(`[notify] ${context} text channels threw:`, error.message);
  }
}

/** First name for a greeting, from whatever shape the caller has to hand. */
function firstNameOf(person) {
  if (!person) return '';
  if (person.firstName) return person.firstName;
  if (person.memberName) return String(person.memberName).split(' ')[0];
  if (person.fullName) return String(person.fullName).split(' ')[0];
  return '';
}

function emailOf(member, order) {
  return (member && member.email) || (order && order.customerInfo && order.customerInfo.email) || null;
}

/** The email for an event: the gym's own wording if enabled, else the built-in. */
async function emailFor(key, vars, builtIn) {
  return (await templates.renderEmail(key, vars)) || builtIn();
}

/* ------------------------------- bookings ------------------------------- */

async function bookingCreated(booking, member) {
  const m = await enrich(member);
  const b = await brand();
  const waitlisted = booking.status === 'waitlisted';
  const key = waitlisted ? 'booking_waitlisted' : 'booking_confirmed';
  const common = {
    firstName: firstNameOf(m) || firstNameOf(booking),
    className: booking.className,
    date: booking.sessionDate,
    startTime: booking.sessionStart,
    endTime: booking.sessionEnd,
    instructorName: booking.instructorName,
    siteName: b.siteName,
    portalUrl: b.portalUrl
  };
  const vars = { ...common, ...b, firstName: common.firstName, date: t.dateLabel(booking.sessionDate), position: booking.waitlistPosition };

  const built = await emailFor(key, vars, () =>
    waitlisted ? t.bookingWaitlisted({ ...common, position: booking.waitlistPosition }) : t.bookingConfirmed(common)
  );
  fanOut(m, key, vars, `booking ${booking.status}`, b.portalUrl);
  return deliver(m && m.email, built, `booking ${booking.status}`, { member: m });
}

async function bookingCancelled(booking, member, byStaff = false) {
  const m = await enrich(member);
  const b = await brand();
  const vars = {
    ...b,
    firstName: firstNameOf(m) || firstNameOf(booking),
    className: booking.className,
    date: t.dateLabel(booking.sessionDate),
    startTime: booking.sessionStart
  };
  const built = await emailFor('booking_cancelled', vars, () =>
    t.bookingCancelled({
      firstName: vars.firstName,
      className: booking.className,
      date: booking.sessionDate,
      startTime: booking.sessionStart,
      byStaff,
      siteName: b.siteName,
      portalUrl: b.timetableUrl
    })
  );
  fanOut(m, 'booking_cancelled', vars, 'booking cancelled', b.timetableUrl);
  return deliver(m && m.email, built, 'booking cancelled', { member: m });
}

/**
 * Sent when the waiting list moves. This is the one gym email members
 * genuinely need rather than merely tolerate: a place they cannot see has
 * become theirs, and without a message they will not know.
 */
async function bookingPromoted(booking, member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = {
    ...b,
    firstName: firstNameOf(m) || firstNameOf(booking),
    className: booking.className,
    date: t.dateLabel(booking.sessionDate),
    startTime: booking.sessionStart,
    endTime: booking.sessionEnd
  };
  const built = await emailFor('booking_promoted', vars, () =>
    t.bookingPromoted({
      firstName: vars.firstName,
      className: booking.className,
      date: booking.sessionDate,
      startTime: booking.sessionStart,
      endTime: booking.sessionEnd,
      siteName: b.siteName,
      portalUrl: b.portalUrl
    })
  );
  fanOut(m, 'booking_promoted', vars, 'waitlist promotion', b.portalUrl);
  return deliver(m && m.email, built, 'waitlist promotion', { member: m });
}

async function classReminder(booking, member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = {
    ...b,
    firstName: firstNameOf(m) || firstNameOf(booking),
    className: booking.className,
    date: t.dateLabel(booking.sessionDate),
    startTime: booking.sessionStart,
    endTime: booking.sessionEnd,
    instructorName: booking.instructorName
  };
  const built = await emailFor('class_reminder', vars, () =>
    t.classReminder({
      firstName: vars.firstName,
      className: booking.className,
      date: booking.sessionDate,
      startTime: booking.sessionStart,
      endTime: booking.sessionEnd,
      instructorName: booking.instructorName,
      siteName: b.siteName,
      portalUrl: b.portalUrl
    })
  );
  fanOut(m, 'class_reminder', vars, 'class reminder', b.portalUrl);
  return deliver(m && m.email, built, 'class reminder', { member: m });
}

/* ------------------------------ membership ------------------------------ */

function orderVars(order, m, b) {
  const pkg = order.packageDetails || {};
  const sub = order.subscription || {};
  const pay = order.payment || {};
  return {
    ...b,
    firstName: firstNameOf(m) || firstNameOf(order.customerInfo),
    packageName: pkg.name || '',
    startDate: t.dateLabel(sub.startDate),
    endDate: t.dateLabel(sub.endDate),
    amount: pay.amount !== undefined && pay.amount !== null ? String(pay.amount) : '',
    currency: String(pay.currency || '').toUpperCase(),
    orderNumber: order.orderNumber || ''
  };
}

async function membershipConfirmed(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = orderVars(order, m, b);
  const built = await emailFor('membership_confirmed', vars, () =>
    t.membershipConfirmed({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      startDate: order.subscription && order.subscription.startDate,
      endDate: order.subscription && order.subscription.endDate,
      amount: order.payment && order.payment.amount,
      currency: (order.payment && order.payment.currency || '').toUpperCase(),
      orderNumber: order.orderNumber,
      siteName: b.siteName,
      portalUrl: b.accountUrl
    })
  );

  const to = emailOf(m, order);

  // The invoice rides along as a PDF when the order has one. Failing to
  // render it must not stop the confirmation itself.
  let attachments;
  try {
    if (order.invoice && order.invoice.number) {
      const { renderInvoicePdf } = require('./invoiceService');
      attachments = [{ filename: `${order.invoice.number}.pdf`, content: await renderInvoicePdf(order), contentType: 'application/pdf' }];
    }
  } catch (error) {
    console.error('[notify] invoice attachment failed:', error.message);
  }
  fanOut(m, 'membership_confirmed', vars, 'membership confirmed', `${b.accountUrl}?tab=history`);
  return deliver(to, built, 'membership confirmed', { attachments, member: m });
}

async function membershipRenewed(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const last = order.subscription && order.subscription.renewals && order.subscription.renewals[order.subscription.renewals.length - 1];
  const amount = last ? last.amount : order.payment && order.payment.amount;
  const currency = ((last ? last.currency : order.payment && order.payment.currency) || '').toUpperCase();
  const vars = { ...orderVars(order, m, b), amount: amount !== undefined && amount !== null ? String(amount) : '', currency };
  const built = await emailFor('membership_renewed', vars, () =>
    t.membershipRenewed({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      endDate: order.subscription && order.subscription.endDate,
      amount,
      currency,
      siteName: b.siteName,
      portalUrl: b.accountUrl
    })
  );
  fanOut(m, 'membership_renewed', vars, 'membership renewed', `${b.accountUrl}?tab=history`);
  return deliver(emailOf(m, order), built, 'membership renewed', { member: m });
}

async function paymentFailed(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const reason = (order.payment && order.payment.lastPaymentError) || '';
  const vars = { ...orderVars(order, m, b), reason };
  const built = await emailFor('payment_failed', vars, () =>
    t.paymentFailed({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      endDate: order.subscription && order.subscription.endDate,
      reason,
      siteName: b.siteName,
      portalUrl: `${b.accountUrl}?tab=history`
    })
  );
  fanOut(m, 'payment_failed', vars, 'payment failed', `${b.accountUrl}?tab=history`);
  return deliver(emailOf(m, order), built, 'payment failed', { member: m });
}

async function transferReceived(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = orderVars(order, m, b);
  const built = await emailFor('transfer_received', vars, () =>
    t.transferReceived({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      amount: order.payment && order.payment.amount,
      currency: (order.payment && order.payment.currency || '').toUpperCase(),
      orderNumber: order.orderNumber,
      siteName: b.siteName,
      portalUrl: `${b.accountUrl}?tab=history`
    })
  );
  fanOut(m, 'transfer_received', vars, 'transfer received', `${b.accountUrl}?tab=history`);
  return deliver(emailOf(m, order), built, 'transfer received', { member: m });
}

async function transferRejected(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const reason = (order.payment && order.payment.proof && order.payment.proof.rejectionReason) || '';
  const vars = { ...orderVars(order, m, b), reason };
  const built = await emailFor('transfer_rejected', vars, () =>
    t.transferRejected({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      reason,
      orderNumber: order.orderNumber,
      siteName: b.siteName,
      renewUrl: b.renewUrl
    })
  );
  fanOut(m, 'transfer_rejected', vars, 'transfer rejected', b.renewUrl);
  return deliver(emailOf(m, order), built, 'transfer rejected', { member: m });
}

async function membershipFrozen(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = { ...orderVars(order, m, b), resumeAt: t.dateLabel(order.freeze && order.freeze.resumeAt) };
  const built = await emailFor('membership_frozen', vars, () =>
    t.membershipFrozen({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      resumeAt: order.freeze && order.freeze.resumeAt,
      endDate: order.subscription && order.subscription.endDate,
      siteName: b.siteName,
      portalUrl: `${b.accountUrl}?tab=history`
    })
  );
  fanOut(m, 'membership_frozen', vars, 'membership frozen', `${b.accountUrl}?tab=history`);
  return deliver(emailOf(m, order), built, 'membership frozen', { member: m });
}

async function membershipCancelled(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = orderVars(order, m, b);
  const built = await emailFor('membership_cancelled', vars, () =>
    t.membershipCancelled({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      endDate: order.subscription && order.subscription.endDate,
      immediate: order.status === 'cancelled',
      siteName: b.siteName,
      renewUrl: b.renewUrl
    })
  );
  fanOut(m, 'membership_cancelled', vars, 'membership cancelled', b.renewUrl);
  return deliver(emailOf(m, order), built, 'membership cancelled', { member: m });
}

async function membershipExpiring(order, member, daysLeft) {
  const m = await enrich(member);
  const b = await brand();
  const vars = { ...orderVars(order, m, b), daysLeft };
  const built = await emailFor('membership_expiring', vars, () =>
    t.membershipExpiring({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      endDate: order.subscription && order.subscription.endDate,
      daysLeft,
      siteName: b.siteName,
      renewUrl: b.renewUrl
    })
  );
  fanOut(m, 'membership_expiring', vars, `membership expiring in ${daysLeft}d`, b.renewUrl);
  return deliver(emailOf(m, order), built, `membership expiring in ${daysLeft}d`, { member: m });
}

async function membershipExpired(order, member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = orderVars(order, m, b);
  const built = await emailFor('membership_expired', vars, () =>
    t.membershipExpired({
      firstName: vars.firstName,
      packageName: order.packageDetails && order.packageDetails.name,
      endDate: order.subscription && order.subscription.endDate,
      siteName: b.siteName,
      renewUrl: b.renewUrl
    })
  );
  fanOut(m, 'membership_expired', vars, 'membership expired', b.renewUrl);
  return deliver(emailOf(m, order), built, 'membership expired', { member: m });
}

async function memberWelcome(member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = { ...b, firstName: firstNameOf(m) };
  const built = await emailFor('member_welcome', vars, () =>
    t.memberWelcome({
      firstName: vars.firstName,
      siteName: b.siteName,
      portalUrl: b.accountUrl,
      timetableUrl: b.timetableUrl
    })
  );
  fanOut(m, 'member_welcome', vars, 'member welcome', b.accountUrl);
  return deliver(m && m.email, built, 'member welcome', { member: m });
}

/* ------------------------------ automations ----------------------------- */
//
// These have no built-in HTML of their own: the registry in templateService
// carries a plain default, which the gym can rewrite like any other.

async function absentNudge(member, { daysAbsent }) {
  const m = await enrich(member);
  const b = await brand();
  const vars = { ...b, firstName: firstNameOf(m), daysAbsent };
  const built = await templates.renderEmail('absent_nudge', vars);
  fanOut(m, 'absent_nudge', vars, 'absent nudge', b.timetableUrl);
  return built ? deliver(m && m.email, built, 'absent nudge', { member: m }) : { success: false, skipped: 'no template' };
}

async function winBack(member, { packageName, endDate }) {
  const m = await enrich(member);
  const b = await brand();
  const vars = { ...b, firstName: firstNameOf(m), packageName: packageName || '', endDate: t.dateLabel(endDate) };
  const built = await templates.renderEmail('win_back', vars);
  fanOut(m, 'win_back', vars, 'win back', b.renewUrl);
  return built ? deliver(m && m.email, built, 'win back', { member: m }) : { success: false, skipped: 'no template' };
}

async function birthday(member) {
  const m = await enrich(member);
  const b = await brand();
  const vars = { ...b, firstName: firstNameOf(m) };
  const built = await templates.renderEmail('birthday', vars);
  fanOut(m, 'birthday', vars, 'birthday', b.accountUrl);
  return built ? deliver(m && m.email, built, 'birthday', { member: m }) : { success: false, skipped: 'no template' };
}

module.exports = {
  brand,
  resetBrandCache,
  enrich,
  deliver,
  bookingCreated,
  bookingCancelled,
  bookingPromoted,
  classReminder,
  membershipConfirmed,
  membershipExpiring,
  membershipExpired,
  memberWelcome,
  membershipRenewed,
  paymentFailed,
  transferReceived,
  transferRejected,
  membershipFrozen,
  membershipCancelled,
  absentNudge,
  winBack,
  birthday
};
