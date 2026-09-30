// src/accounts/services/assetReminders.js
//
// The two things about the equipment register worth somebody's attention
// before they become a problem: a service coming up (or already missed), and
// a warranty about to run out while there is still time to claim on it.
//
// The admin bell counts them (controller/adminNotificationsController.js) and
// its links open the register filtered to the same assets
// (assetController.list ?service=due / ?warranty=ending), so both read the
// rule from here -- as a query for the count, as a test on one asset for the
// list -- and cannot disagree about which machines are meant.
//
// There is no scheduled message behind these: the gym's admins are reached
// through the bell, which is worked out when it is opened, so a count is
// never a day stale.

const DAY_MS = 86400000;

// A service due inside the week is this week's work, like the bell's other
// items; one already missed stays counted until it is logged.
const SERVICE_DUE_WINDOW_DAYS = 7;
// Long enough to get an engineer out under warranty before it lapses.
const WARRANTY_WINDOW_DAYS = 30;

// Equipment nobody services or claims on any more.
const OUT_OF_USE = ['retired', 'sold', 'lost'];

function serviceDueBefore(now) {
  return new Date(now.getTime() + SERVICE_DUE_WINDOW_DAYS * DAY_MS);
}

function warrantyEndsBefore(now) {
  return new Date(now.getTime() + WARRANTY_WINDOW_DAYS * DAY_MS);
}

/** Assets in use whose next service is due inside the window, or overdue. */
function serviceDueQuery(now = new Date()) {
  return { status: { $nin: OUT_OF_USE }, nextServiceDue: { $ne: null, $lt: serviceDueBefore(now) } };
}

/** Assets in use whose warranty ends inside the window (and has not ended). */
function warrantyEndingQuery(now = new Date()) {
  return { status: { $nin: OUT_OF_USE }, warrantyUntil: { $gte: now, $lt: warrantyEndsBefore(now) } };
}

/** serviceDueQuery, for one stored asset. */
function isServiceDue(asset, now = new Date()) {
  if (!asset || OUT_OF_USE.includes(asset.status) || !asset.nextServiceDue) return false;
  return new Date(asset.nextServiceDue).getTime() < serviceDueBefore(now).getTime();
}

/** warrantyEndingQuery, for one stored asset. */
function isWarrantyEnding(asset, now = new Date()) {
  if (!asset || OUT_OF_USE.includes(asset.status) || !asset.warrantyUntil) return false;
  const ends = new Date(asset.warrantyUntil).getTime();
  return ends >= now.getTime() && ends < warrantyEndsBefore(now).getTime();
}

module.exports = {
  SERVICE_DUE_WINDOW_DAYS,
  WARRANTY_WINDOW_DAYS,
  OUT_OF_USE,
  serviceDueQuery,
  warrantyEndingQuery,
  isServiceDue,
  isWarrantyEnding
};
