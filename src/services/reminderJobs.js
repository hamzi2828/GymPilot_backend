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

/**
 * Emails members whose membership ends in one of EXPIRY_NOTICE_DAYS days.
 *
 * The "already sent" guard is a field on the order rather than a separate
 * table: `remindersSent` accumulates the day-counts already used, so a member
 * gets the 14-day notice once, then the 7-day notice, then the 1-day notice,
 * and never the same one twice however often the cron runs.
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
      .select('orderNumber userId customerInfo packageDetails subscription remindersSent')
      .lean();

    for (const order of orders) {
      const already = Array.isArray(order.remindersSent) ? order.remindersSent : [];
      if (already.includes(days)) {
        skipped.push({ order: order.orderNumber, days, reason: 'already sent' });
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
  const memberships = await sendExpiryReminders(options);
  const classes = await sendClassReminders(options);
  // The automated nudges (absent, win-back, birthday); each is off until
  // the gym switches it on.
  const { runAutomations } = require('./automations');
  const automations = await runAutomations(options);

  return { expired, freezes, memberships, classes, automations };
}

module.exports = {
  EXPIRY_NOTICE_DAYS,
  sendExpiryReminders,
  sendClassReminders,
  runDaily
};
