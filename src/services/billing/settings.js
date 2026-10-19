// src/services/billing/settings.js
//
// The gym's renewal-billing rules (Settings → Payments → Billing reminders):
// when a member is told a renewal is due, by which channels, the last day
// to pay, and whether a saved card is charged on the due date.
//
// Stored on the settings document under `billing` -- the block the
// payment-gateway work declares on the Settings model, saved and checked by
// PUT /settings. billingSettings() is what every reader here uses: it fills
// in the defaults for a gym that has never saved the block and drops
// anything out of range, so the job never has to wonder what a missing
// field means. The defaults are the model's.

const MAX_DAYS = 30;
// As many "days before" as PUT /settings accepts.
const MAX_REMINDERS = 10;
const CHANNELS = ['email', 'sms', 'whatsapp', 'push'];

const DEFAULTS = Object.freeze({
  reminderDaysBefore: [3],
  dueDayReminder: true,
  lastDayAfterDue: 3,
  sendVia: { email: true, sms: false, whatsapp: false, push: true },
  autoCharge: { enabled: false }
});

function wholeDays(value) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_DAYS ? n : null;
}

// Largest first, no repeats: the order the messages go out in.
function dayList(values) {
  return [...new Set(values)].sort((a, b) => b - a).slice(0, MAX_REMINDERS);
}

/** The gym's billing rules with every default filled in. */
function billingSettings(settings) {
  const stored = (settings && settings.billing) || {};
  const days = Array.isArray(stored.reminderDaysBefore)
    ? dayList(stored.reminderDaysBefore.map(wholeDays).filter((n) => n !== null))
    : [...DEFAULTS.reminderDaysBefore];
  const lastDay = wholeDays(stored.lastDayAfterDue);
  const via = stored.sendVia || {};
  const sendVia = {};
  for (const channel of CHANNELS) sendVia[channel] = typeof via[channel] === 'boolean' ? via[channel] : DEFAULTS.sendVia[channel];
  return {
    reminderDaysBefore: days,
    dueDayReminder: typeof stored.dueDayReminder === 'boolean' ? stored.dueDayReminder : DEFAULTS.dueDayReminder,
    lastDayAfterDue: lastDay === null ? DEFAULTS.lastDayAfterDue : lastDay,
    sendVia,
    autoCharge: { enabled: !!(stored.autoCharge && stored.autoCharge.enabled === true) }
  };
}

/** How many days ahead of the due date the first message goes (and the renewal order is made). */
function leadDays(billing) {
  return billing.reminderDaysBefore.length ? Math.max(...billing.reminderDaysBefore) : 0;
}

module.exports = { DEFAULTS, MAX_DAYS, MAX_REMINDERS, CHANNELS, billingSettings, leadDays };
