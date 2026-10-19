// src/services/reminderJobs.js
//
// The scheduled work: telling members their membership is about to run out,
// and reminding them about tomorrow's class.
//
// Nothing in this system ran on a schedule before, so these are written to be
// driven from outside rather than from a timer inside the process. That is
// deliberate -- the backend is serverless on Vercel, where there is no
// long-lived process to hold a `setInterval`, and a cron that fires an HTTP
// endpoint is the only thing that works there. See scripts/sendReminders.js
// and the /api/jobs/reminders route.
//
// Both jobs are idempotent within a day: each records what it has already sent
// so running the cron twice does not email anybody twice. That matters more
// than it sounds, because a cron that retries on a timeout is normal.

const PackageOrder = require('../gymfolio/models/packageOrderModel');
const ClassBooking = require('../gymfolio/models/classBookingModel');
const User = require('../models/user');
const notify = require('./gymNotifications');
const T = require('../attendance/services/timeUtils');

// How many days before expiry to write. Three points rather than one: a month
// out is a nudge, a week out is a reminder, the day before is the last call.
const EXPIRY_NOTICE_DAYS = (process.env.MEMBERSHIP_REMINDER_DAYS || '14,7,1')
  .split(',')
  .map((n) => parseInt(String(n).trim(), 10))
  .filter((n) => Number.isFinite(n) && n >= 0)
  .sort((a, b) => b - a);

/** Local midnight-to-midnight bounds for a 'YYYY-MM-DD' key, as UTC instants. */
function localDayBounds(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const parts = T.localParts(guess);

  let drift = parts.hour * 60 + parts.minute;
  if (drift > 720) drift -= 1440;

  const start = new Date(guess.getTime() - drift * 60000);
  return { start, end: new Date(start.getTime() + 86400000) };
}

// What Stripe calls a subscription that will not take another payment on its
// own: ended, never got going, or given up on.
const NOT_RENEWING_STRIPE_STATUSES = ['canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'];

/**
 * Whether the order renews itself at its end date: a card subscription at
 * Stripe that nobody has told to stop. Such a member is charged and carries
 * on, so "your membership ends -- renew" would be wrong, and a renewal bought
 * because of it would be paid for twice.
 *
 * autoRenew is set only for Stripe subscriptions and cleared on every way
 * one stops (cancel at period end, deleted at Stripe, refund), so it is
 * required as well as the subscription id.
 */
function willAutoRenew(order) {
  if (!order) return false;
  const sub = order.subscription || {};
  if (!(order.payment && order.payment.stripeSubscriptionId)) return false;
  if (sub.autoRenew !== true || sub.cancelAtPeriodEnd === true) return false;
  return !NOT_RENEWING_STRIPE_STATUSES.includes(String(sub.stripeStatus || '').toLowerCase());
}

/**
 * Whether the member already holds a paid membership running past this
 * order's end -- a renewal bought early starts when the current term ends
 * (membershipService.startDateFor), so for them nothing is about to run out.
 */
async function hasFollowingTerm(order) {
  const end = order.subscription && order.subscription.endDate;
  if (!end) return false;
  const owner = [];
  if (order.userId) owner.push({ userId: order.userId });
  const email = order.customerInfo && order.customerInfo.email;
  if (email) owner.push({ 'customerInfo.email': String(email).toLowerCase().trim() });
  if (!owner.length) return false;

  const next = await PackageOrder.exists({
    _id: { $ne: order._id },
    $or: owner,
    'payment.status': 'paid',
    status: { $in: ['active', 'frozen'] },
    $and: [{ $or: [{ 'packageDetails.kind': 'membership' }, { 'packageDetails.kind': { $exists: false } }] }],
    'subscription.endDate': { $gt: new Date(end) }
  });
  return !!next;
}

/**
 * Emails members whose membership ends in one of EXPIRY_NOTICE_DAYS days.
 *
 * The "already sent" guard is a field on the order rather than a separate
 * table: `remindersSent` accumulates the day-counts already used, so a member
 * gets the 14-day notice once, then the 7-day notice, then the 1-day notice,
 * and never the same one twice however often the cron runs.
 *
 * Nobody is told to renew what is not ending: a subscription that renews
 * itself, or a membership already renewed, is skipped -- and not marked as
 * sent, so a member who switches renewal off next week still gets the notices
 * that are left.
 */
async function sendExpiryReminders({ dryRun = false } = {}) {
  const now = new Date();
  const sent = [];
  const skipped = [];

  for (const days of EXPIRY_NOTICE_DAYS) {
    const targetKey = T.shiftDateKey(T.dateKey(), days);
    const { start, end } = localDayBounds(targetKey);

    const orders = await PackageOrder.find({
      'payment.status': 'paid',
      status: 'active',
      'subscription.endDate': { $gte: start, $lt: end }
    })
      .select('orderNumber userId customerInfo packageDetails subscription remindersSent status payment.stripeSubscriptionId')
      .lean();

    for (const order of orders) {
      const already = Array.isArray(order.remindersSent) ? order.remindersSent : [];
      if (already.includes(days)) {
        skipped.push({ order: order.orderNumber, days, reason: 'already sent' });
        continue;
      }

      if (willAutoRenew(order)) {
        skipped.push({ order: order.orderNumber, days, reason: 'renews automatically' });
        continue;
      }

      if (await hasFollowingTerm(order)) {
        skipped.push({ order: order.orderNumber, days, reason: 'already renewed' });
        continue;
      }

      const member = order.userId
        ? await User.findById(order.userId).select('firstName lastName email isActive').lean()
        : null;

      // A deactivated account should not be chased for a renewal.
      if (member && member.isActive === false) {
        skipped.push({ order: order.orderNumber, days, reason: 'account disabled' });
        continue;
      }

      const to = (member && member.email) || (order.customerInfo && order.customerInfo.email);
      if (!to) {
        skipped.push({ order: order.orderNumber, days, reason: 'no email address' });
        continue;
      }

      if (dryRun) {
        sent.push({ order: order.orderNumber, days, to, dryRun: true });
        continue;
      }

      const result = await notify.membershipExpiring(order, member, days);

      if (result && result.success) {
        // Marked only on success, so a mail outage means the notice is retried
        // on the next run rather than silently lost.
        await PackageOrder.updateOne(
          { _id: order._id },
          { $addToSet: { remindersSent: days } }
        );
        sent.push({ order: order.orderNumber, days, to });
      } else {
        skipped.push({
          order: order.orderNumber,
          days,
          reason: (result && (result.skipped || result.error)) || 'send failed'
        });
      }
    }
  }

  return { at: now.toISOString(), sent, skipped, counts: { sent: sent.length, skipped: skipped.length } };
}

/**
 * Reminds members about the classes they are booked into tomorrow.
 *
 * Tomorrow rather than today: a reminder on the morning of the class is too
 * late to be useful to somebody deciding whether to keep the place, and the
 * point of the message is partly to prompt a cancellation that frees it up.
 */
async function sendClassReminders({ dryRun = false } = {}) {
  const tomorrow = T.shiftDateKey(T.dateKey(), 1);

  const bookings = await ClassBooking.find({
    sessionDate: tomorrow,
    status: 'booked',
    reminderSentAt: null
  })
    .select('classId className userId memberName sessionDate sessionStart sessionEnd instructorName')
    .lean();

  const sent = [];
  const skipped = [];

  for (const booking of bookings) {
    const member = await User.findById(booking.userId)
      .select('firstName lastName email isActive')
      .lean();

    if (!member || member.isActive === false || !member.email) {
      skipped.push({ booking: String(booking._id), reason: 'no reachable member' });
      continue;
    }

    if (dryRun) {
      sent.push({ booking: String(booking._id), to: member.email, class: booking.className, dryRun: true });
      continue;
    }

    const result = await notify.classReminder(booking, member);

    if (result && result.success) {
      await ClassBooking.updateOne({ _id: booking._id }, { $set: { reminderSentAt: new Date() } });
      sent.push({ booking: String(booking._id), to: member.email, class: booking.className });
    } else {
      skipped.push({
        booking: String(booking._id),
        reason: (result && (result.skipped || result.error)) || 'send failed'
      });
    }
  }

  return { date: tomorrow, sent, skipped, counts: { sent: sent.length, skipped: skipped.length } };
}

/**
 * Reminds members about tomorrow's personal training session, once.
 */
async function sendPtReminders({ dryRun = false } = {}) {
  const PtSession = require('../gymfolio/models/ptSessionModel');
  const tomorrow = T.shiftDateKey(T.dateKey(), 1);
  const sessions = await PtSession.find({ date: tomorrow, status: 'scheduled', reminderSentAt: null }).lean();
  const sent = [];
  const skipped = [];
  for (const session of sessions) {
    const member = await User.findById(session.memberId).select('firstName lastName email phone isActive notificationPreferences').lean();
    if (!member || member.isActive === false || !(member.email || member.phone)) {
      skipped.push({ session: String(session._id), reason: 'no reachable member' });
      continue;
    }
    if (dryRun) {
      sent.push({ session: String(session._id), to: member.email || member.phone, dryRun: true });
      continue;
    }
    await notify.ptReminder(session, member);
    await PtSession.updateOne({ _id: session._id }, { $set: { reminderSentAt: new Date() } });
    sent.push({ session: String(session._id), to: member.email || member.phone });
  }
  return { date: tomorrow, sent, skipped, counts: { sent: sent.length, skipped: skipped.length } };
}

// How long before a class a check-in still counts as being there for it: the
// member who arrives early to warm up, or trains first and joins the class
// after, was there.
const ARRIVED_EARLY_MINUTES = 120;
// A booking made before sessions carried an end time.
const DEFAULT_CLASS_MINUTES = 60;

function clockOf(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** When a booked session ran, as instants, from its local date and times. */
function sessionWindow(booking) {
  const from = clockOf(booking.sessionStart) || { hour: 0, minute: 0 };
  const start = T.localInstant(booking.sessionDate, from.hour, from.minute);
  const to = clockOf(booking.sessionEnd);
  let end = to ? T.localInstant(booking.sessionDate, to.hour, to.minute) : null;
  if (!end || end <= start) end = new Date(start.getTime() + DEFAULT_CLASS_MINUTES * 60000);
  return { start, end };
}

/**
 * Whether a visit puts the member in the building for the class. A visit
 * that was checked out must have lasted until the class began; one never
 * checked out (forgotten, or closed by the daily job) has only its check-in
 * to go on, which must fall shortly before the class or during it.
 */
function visitCoversSession(visit, window) {
  if (!visit || !visit.checkInAt) return false;
  const inAt = new Date(visit.checkInAt).getTime();
  if (inAt > window.end.getTime()) return false;
  if (visit.checkOutAt) return new Date(visit.checkOutAt).getTime() >= window.start.getTime();
  return inAt >= window.start.getTime() - ARRIVED_EARLY_MINUTES * 60000;
}

/**
 * Splits past bookings into the ones the member turned up for (by their
 * check-ins) and the ones they missed. Checked a session date at a time: a
 * member visit is filed on the local day it began, so the day of the class
 * and the one before (a visit running over midnight) are all it can be on.
 */
async function sortByAttendance(bookings) {
  const Attendance = require('../attendance/models/attendanceModel');
  const byDate = new Map();
  for (const booking of bookings) {
    if (!byDate.has(booking.sessionDate)) byDate.set(booking.sessionDate, []);
    byDate.get(booking.sessionDate).push(booking);
  }

  const attended = [];
  const missed = [];
  for (const [date, rows] of byDate) {
    const memberIds = [...new Set(rows.map((b) => String(b.userId)))];
    const visits = await Attendance.find({
      personType: 'member',
      personId: { $in: memberIds },
      shiftDate: { $in: [T.shiftDateKey(date, -1), date] }
    })
      .select('personId checkInAt checkOutAt')
      .lean();

    for (const booking of rows) {
      const window = sessionWindow(booking);
      const visit = visits.find((v) => String(v.personId) === String(booking.userId) && visitCoversSession(v, window));
      if (visit) attended.push({ booking, at: visit.checkInAt });
      else missed.push(booking);
    }
  }
  return { attended, missed };
}

/**
 * Settles yesterday's (and any older) bookings still sitting at "booked",
 * when the gym has switched that on (Settings → booking rules → autoNoShow):
 * a member who checked in for the class is marked attended, everyone else a
 * no-show. Checking in at the desk does not touch bookings, so without the
 * first half every class a member turned up to would count against them.
 */
async function markMissedBookings({ dryRun = false } = {}) {
  const { bookingRules } = require('../gymfolio/services/bookingRules');
  const rules = await bookingRules();
  if (!rules.autoNoShow) return { enabled: false, marked: 0, attended: 0 };
  const yesterday = T.shiftDateKey(T.dateKey(), -1);
  const bookings = await ClassBooking.find({ status: 'booked', sessionDate: { $lte: yesterday } })
    .select('userId sessionDate sessionStart sessionEnd')
    .lean();
  const { attended, missed } = await sortByAttendance(bookings);
  if (dryRun) return { enabled: true, marked: missed.length, attended: attended.length, dryRun: true };

  // Each write is conditional on the booking still being "booked": the desk
  // may have marked it by hand since it was read.
  let attendedCount = 0;
  if (attended.length) {
    const result = await ClassBooking.bulkWrite(
      attended.map(({ booking, at }) => ({
        updateOne: {
          filter: { _id: booking._id, status: 'booked' },
          update: { $set: { status: 'attended', attendedAt: at } }
        }
      }))
    );
    attendedCount = result.modifiedCount || 0;
  }
  let marked = 0;
  if (missed.length) {
    const result = await ClassBooking.updateMany(
      { _id: { $in: missed.map((b) => b._id) }, status: 'booked' },
      { $set: { status: 'no_show' } }
    );
    marked = result.modifiedCount || 0;
  }
  return { enabled: true, marked, attended: attendedCount };
}

/** Everything the daily cron should do, in one call. */
async function runDaily(options = {}) {
  const { expireLapsedOrders } = require('../gymfolio/services/membershipExpiry');

  // Order matters: expire first, so a membership that lapsed overnight is not
  // then sent a "renew in 1 day" notice about a date that has already passed.
  const expired = options.dryRun ? { expired: 0 } : await expireLapsedOrders();
  // Freezes whose planned end has passed come back on before the reminders
  // run, so a member resuming today is not told their membership is lapsed.
  const { resumeDueFreezes } = require('../gymfolio/services/membershipService');
  const freezes = options.dryRun ? { resumed: 0 } : await resumeDueFreezes();
  // Renewal orders, payment links and due-date charges (services/billing/),
  // before the expiry notices so those can tell which terms it now covers.
  // On its own: a gateway that is down must not cost the gym its reminders.
  let billing;
  try {
    billing = await require('./billing/billingJob').runBillingJob(options);
  } catch (error) {
    console.error('[jobs] billing reminders failed:', error);
    billing = { error: error.message };
  }
  const memberships = await sendExpiryReminders(options);
  const classes = await sendClassReminders(options);
  const ptSessions = await sendPtReminders(options);
  const missed = await markMissedBookings(options);
  // The automated nudges (absent, win-back, birthday); each is off until
  // the gym switches it on.
  const { runAutomations } = require('./automations');
  const automations = await runAutomations(options);

  return { expired, freezes, billing, memberships, classes, ptSessions, missed, automations };
}

module.exports = {
  EXPIRY_NOTICE_DAYS,
  willAutoRenew,
  hasFollowingTerm,
  sessionWindow,
  visitCoversSession,
  sendExpiryReminders,
  sendClassReminders,
  sendPtReminders,
  markMissedBookings,
  runDaily
};
