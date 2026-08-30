// src/services/gymNotifications.js
//
// The one place that decides what a gym event should put in somebody's inbox.
//
// Two rules run through all of it.
//
// First, sending is never allowed to break the thing that triggered it. A
// member books a class; if SMTP is misconfigured the booking still stands and
// the failure goes to the log. Every function here swallows its own errors and
// callers fire them without awaiting.
//
// Second, nothing is hardcoded to a brand. The gym's name, its address and the
// links in the footer all come from the Settings document, so a template says
// "your membership at X" without this file knowing what X is.

const Settings = require('../models/settings');
const { sendEmail } = require('./emailService');
const t = require('../templates/gymEmails');

// Settings are read on nearly every notification and change about once a year,
// so they are cached briefly rather than fetched per email.
const SETTINGS_TTL_MS = 60 * 1000;
let cached = null;
let cachedAt = 0;

async function brand() {
  if (cached && Date.now() - cachedAt < SETTINGS_TTL_MS) return cached;

  let siteName = process.env.SITE_NAME || 'GymPilot';
  let notificationsOn = true;

  try {
    const settings = await Settings.getSettings();
    if (settings) {
      if (settings.siteName) siteName = settings.siteName;
      // The admin switch on the Settings screen. Off means transactional gym
      // email stops -- which is a decision a gym is allowed to make.
      notificationsOn = settings.emailNotifications !== false;
    }
  } catch {
    // No database, or no settings row yet. Fall back rather than fail: an
    // email with a generic name is better than no email.
  }

  const frontend = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');

  cached = {
    siteName,
    notificationsOn,
    portalUrl: `${frontend}/user-detail?tab=bookings`,
    accountUrl: `${frontend}/user-detail`,
    timetableUrl: `${frontend}/timetable`,
    renewUrl: `${frontend}/packages`
  };
  cachedAt = Date.now();
  return cached;
}

/** Clears the settings cache — used by tests and after a settings save. */
function resetBrandCache() {
  cached = null;
  cachedAt = 0;
}

/**
 * The single exit point. Everything below funnels through here so there is one
 * place that checks whether email is switched on, one place that logs, and one
 * place that guarantees a failure cannot propagate.
 */
async function deliver(to, built, context) {
  try {
    if (!to) return { success: false, skipped: 'no address' };

    const { notificationsOn } = await brand();
    if (!notificationsOn) return { success: false, skipped: 'email notifications are off' };

    const result = await sendEmail(to, built.subject, built.html);
    if (!result.success) {
      console.error(`[notify] ${context} -> ${to} failed:`, result.error);
    }
    return result;
  } catch (error) {
    console.error(`[notify] ${context} -> ${to} threw:`, error.message);
    return { success: false, error: error.message };
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

/* ------------------------------- bookings ------------------------------- */

async function bookingCreated(booking, member) {
  const b = await brand();
  const common = {
    firstName: firstNameOf(member) || firstNameOf(booking),
    className: booking.className,
    date: booking.sessionDate,
    startTime: booking.sessionStart,
    endTime: booking.sessionEnd,
    instructorName: booking.instructorName,
    siteName: b.siteName,
    portalUrl: b.portalUrl
  };

  const built =
    booking.status === 'waitlisted'
      ? t.bookingWaitlisted({ ...common, position: booking.waitlistPosition })
      : t.bookingConfirmed(common);

  return deliver(member && member.email, built, `booking ${booking.status}`);
}

async function bookingCancelled(booking, member, byStaff = false) {
  const b = await brand();
  const built = t.bookingCancelled({
    firstName: firstNameOf(member) || firstNameOf(booking),
    className: booking.className,
    date: booking.sessionDate,
    startTime: booking.sessionStart,
    byStaff,
    siteName: b.siteName,
    portalUrl: b.timetableUrl
  });
  return deliver(member && member.email, built, 'booking cancelled');
}

/**
 * Sent when the waiting list moves. This is the one gym email members
 * genuinely need rather than merely tolerate: a place they cannot see has
 * become theirs, and without a message they will not know.
 */
async function bookingPromoted(booking, member) {
  const b = await brand();
  const built = t.bookingPromoted({
    firstName: firstNameOf(member) || firstNameOf(booking),
    className: booking.className,
    date: booking.sessionDate,
    startTime: booking.sessionStart,
    endTime: booking.sessionEnd,
    siteName: b.siteName,
    portalUrl: b.portalUrl
  });
  return deliver(member && member.email, built, 'waitlist promotion');
}

async function classReminder(booking, member) {
  const b = await brand();
  const built = t.classReminder({
    firstName: firstNameOf(member) || firstNameOf(booking),
    className: booking.className,
    date: booking.sessionDate,
    startTime: booking.sessionStart,
    endTime: booking.sessionEnd,
    instructorName: booking.instructorName,
    siteName: b.siteName,
    portalUrl: b.portalUrl
  });
  return deliver(member && member.email, built, 'class reminder');
}

/* ------------------------------ membership ------------------------------ */

async function membershipConfirmed(order, member) {
  const b = await brand();
  const built = t.membershipConfirmed({
    firstName: firstNameOf(member) || firstNameOf(order.customerInfo),
    packageName: order.packageDetails && order.packageDetails.name,
    startDate: order.subscription && order.subscription.startDate,
    endDate: order.subscription && order.subscription.endDate,
    amount: order.payment && order.payment.amount,
    currency: (order.payment && order.payment.currency || '').toUpperCase(),
    orderNumber: order.orderNumber,
    siteName: b.siteName,
    portalUrl: b.accountUrl
  });

  const to = (member && member.email) || (order.customerInfo && order.customerInfo.email);
  return deliver(to, built, 'membership confirmed');
}

async function membershipExpiring(order, member, daysLeft) {
  const b = await brand();
  const built = t.membershipExpiring({
    firstName: firstNameOf(member) || firstNameOf(order.customerInfo),
    packageName: order.packageDetails && order.packageDetails.name,
    endDate: order.subscription && order.subscription.endDate,
    daysLeft,
    siteName: b.siteName,
    renewUrl: b.renewUrl
  });

  const to = (member && member.email) || (order.customerInfo && order.customerInfo.email);
  return deliver(to, built, `membership expiring in ${daysLeft}d`);
}

async function membershipExpired(order, member) {
  const b = await brand();
  const built = t.membershipExpired({
    firstName: firstNameOf(member) || firstNameOf(order.customerInfo),
    packageName: order.packageDetails && order.packageDetails.name,
    endDate: order.subscription && order.subscription.endDate,
    siteName: b.siteName,
    renewUrl: b.renewUrl
  });

  const to = (member && member.email) || (order.customerInfo && order.customerInfo.email);
  return deliver(to, built, 'membership expired');
}

async function memberWelcome(member) {
  const b = await brand();
  const built = t.memberWelcome({
    firstName: firstNameOf(member),
    siteName: b.siteName,
    portalUrl: b.accountUrl,
    timetableUrl: b.timetableUrl
  });
  return deliver(member && member.email, built, 'member welcome');
}

module.exports = {
  brand,
  resetBrandCache,
  bookingCreated,
  bookingCancelled,
  bookingPromoted,
  classReminder,
  membershipConfirmed,
  membershipExpiring,
  membershipExpired,
  memberWelcome
};
