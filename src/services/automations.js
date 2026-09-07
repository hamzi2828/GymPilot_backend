// src/services/automations.js
//
// The messages a gym sends without anyone pressing a button: "we miss you"
// to members who have stopped turning up, "come back" to members whose
// membership lapsed a while ago, and a birthday greeting. All three are off
// until the gym switches them on (Settings → Messaging → Automations), and
// each remembers who it has already written to so the daily cron can run as
// often as it likes.

const Settings = require('../models/settings');
const User = require('../models/user');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Attendance = require('../attendance/models/attendanceModel');
const notify = require('./gymNotifications');
const T = require('../attendance/services/timeUtils');

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;
// A lapsed member is written to at most this often.
const WIN_BACK_REPEAT_DAYS = 90;
const MEMBER_FIELDS = 'firstName lastName email phone isActive notificationPreferences automation';

async function automationSettings() {
  try {
    const settings = await Settings.getSettings();
    const a = (settings && settings.messaging && settings.messaging.automations) || {};
    return {
      absentDays: Math.max(0, parseInt(a.absentDays, 10) || 0),
      winBackDays: Math.max(0, parseInt(a.winBackDays, 10) || 0),
      birthday: !!a.birthday
    };
  } catch {
    return { absentDays: 0, winBackDays: 0, birthday: false };
  }
}

function reachable(member) {
  return !!(member && member.isActive !== false && (member.email || member.phone));
}

/** Members who hold a live membership but have not been in for N days. */
async function absentNudges({ dryRun = false } = {}) {
  const { absentDays } = await automationSettings();
  if (!absentDays) return { enabled: false, sent: [], skipped: [] };

  const now = new Date();
  const since = new Date(now.getTime() - absentDays * DAY_MS);

  const liveIds = (
    await PackageOrder.distinct('userId', {
      'payment.status': 'paid',
      status: { $in: ['active', 'past_due'] },
      'subscription.endDate': { $gte: now }
    })
  ).filter(Boolean);
  if (!liveIds.length) return { enabled: true, sent: [], skipped: [] };

  const lastVisits = await Attendance.aggregate([
    { $match: { personType: 'member', personId: { $in: liveIds } } },
    { $group: { _id: '$personId', last: { $max: '$checkInAt' } } }
  ]);
  const lastById = new Map(lastVisits.map((row) => [String(row._id), row.last]));

  const members = await User.find({
    _id: { $in: liveIds },
    isActive: { $ne: false },
    // Not nudged yet, or nudged long enough ago that another is fair.
    $or: [{ 'automation.absentNudgedAt': null }, { 'automation.absentNudgedAt': { $lt: since } }]
  })
    .select(MEMBER_FIELDS)
    .limit(BATCH)
    .lean();

  const sent = [];
  const skipped = [];
  for (const member of members) {
    const last = lastById.get(String(member._id));
    // Never visited: measured from when the account was made instead.
    const lastAt = last ? new Date(last) : null;
    if (lastAt && lastAt >= since) continue;
    if (!reachable(member)) {
      skipped.push({ member: String(member._id), reason: 'unreachable' });
      continue;
    }
    const daysAbsent = lastAt ? Math.floor((now - lastAt) / DAY_MS) : absentDays;
    if (dryRun) {
      sent.push({ member: String(member._id), to: member.email || member.phone, daysAbsent, dryRun: true });
      continue;
    }
    await notify.absentNudge(member, { daysAbsent });
    await User.updateOne({ _id: member._id }, { $set: { 'automation.absentNudgedAt': now } });
    sent.push({ member: String(member._id), to: member.email || member.phone, daysAbsent });
  }
  return { enabled: true, sent, skipped };
}

/** Members whose last membership ended N or more days ago and who hold no live one. */
async function winBacks({ dryRun = false } = {}) {
  const { winBackDays } = await automationSettings();
  if (!winBackDays) return { enabled: false, sent: [], skipped: [] };

  const now = new Date();
  const cutoff = new Date(now.getTime() - winBackDays * DAY_MS);
  const repeatBefore = new Date(now.getTime() - WIN_BACK_REPEAT_DAYS * DAY_MS);

  // The most recent paid membership per member, of those that ended before
  // the cutoff -- then drop anyone with anything live.
  const lapsed = await PackageOrder.aggregate([
    { $match: { 'payment.status': 'paid', userId: { $ne: null }, 'subscription.endDate': { $lt: cutoff } } },
    { $sort: { 'subscription.endDate': -1 } },
    { $group: { _id: '$userId', endDate: { $first: '$subscription.endDate' }, packageName: { $first: '$packageDetails.name' } } },
    { $limit: BATCH * 3 }
  ]);
  if (!lapsed.length) return { enabled: true, sent: [], skipped: [] };

  const ids = lapsed.map((row) => row._id);
  const live = new Set(
    (
      await PackageOrder.distinct('userId', {
        userId: { $in: ids },
        'payment.status': 'paid',
        status: { $in: ['active', 'frozen', 'past_due', 'pending'] },
        'subscription.endDate': { $gte: now }
      })
    ).map(String)
  );

  const members = await User.find({
    _id: { $in: ids.filter((id) => !live.has(String(id))) },
    isActive: { $ne: false },
    $or: [{ 'automation.winBackSentAt': null }, { 'automation.winBackSentAt': { $lt: repeatBefore } }]
  })
    .select(MEMBER_FIELDS)
    .limit(BATCH)
    .lean();

  const byId = new Map(lapsed.map((row) => [String(row._id), row]));
  const sent = [];
  const skipped = [];
  for (const member of members) {
    const row = byId.get(String(member._id));
    if (!reachable(member) || member.notificationPreferences?.marketing === false) {
      skipped.push({ member: String(member._id), reason: 'unreachable or opted out' });
      continue;
    }
    if (dryRun) {
      sent.push({ member: String(member._id), to: member.email || member.phone, dryRun: true });
      continue;
    }
    await notify.winBack(member, { packageName: row && row.packageName, endDate: row && row.endDate });
    await User.updateOne({ _id: member._id }, { $set: { 'automation.winBackSentAt': now } });
    sent.push({ member: String(member._id), to: member.email || member.phone });
  }
  return { enabled: true, sent, skipped };
}

/** Everyone whose birthday is today, once a year. */
async function birthdays({ dryRun = false } = {}) {
  const { birthday } = await automationSettings();
  if (!birthday) return { enabled: false, sent: [], skipped: [] };

  // Today in the gym's own calendar; dates of birth are stored as plain
  // calendar dates (UTC midnight), so they are read in UTC.
  const [year, month, day] = T.dateKey().split('-').map(Number);

  const members = await User.aggregate([
    { $match: { isActive: { $ne: false }, dateOfBirth: { $type: 'date' } } },
    { $addFields: { bMonth: { $month: '$dateOfBirth' }, bDay: { $dayOfMonth: '$dateOfBirth' } } },
    { $match: { bMonth: month, bDay: day, $or: [{ 'automation.birthdayYear': null }, { 'automation.birthdayYear': { $ne: year } }] } },
    { $project: { firstName: 1, lastName: 1, email: 1, phone: 1, isActive: 1, notificationPreferences: 1, automation: 1 } },
    { $limit: BATCH }
  ]);

  const sent = [];
  const skipped = [];
  for (const member of members) {
    if (!reachable(member)) {
      skipped.push({ member: String(member._id), reason: 'unreachable' });
      continue;
    }
    if (dryRun) {
      sent.push({ member: String(member._id), to: member.email || member.phone, dryRun: true });
      continue;
    }
    await notify.birthday(member);
    await User.updateOne({ _id: member._id }, { $set: { 'automation.birthdayYear': year } });
    sent.push({ member: String(member._id), to: member.email || member.phone });
  }
  return { enabled: true, sent, skipped };
}

/** All three, for the daily cron. */
async function runAutomations(options = {}) {
  const absent = await absentNudges(options);
  const winBack = await winBacks(options);
  const birthday = await birthdays(options);
  const count = (r) => ({ enabled: r.enabled, sent: r.sent.length, skipped: r.skipped.length });
  return { absent: count(absent), winBack: count(winBack), birthday: count(birthday), details: options.verbose ? { absent, winBack, birthday } : undefined };
}

module.exports = { automationSettings, absentNudges, winBacks, birthdays, runAutomations };
