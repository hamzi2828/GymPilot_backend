// src/services/billing/settings.js
//
// The gym's renewal-billing rules (Settings → Payments → Billing reminders):
// when a member is told a renewal is due, by which channels, the last day
// to pay, and whether a saved card is charged on the due date.
//
// Stored on the settings document under `billing` (models/settings.js).
// billingSettings() is what every reader uses: it fills in the defaults for
// a gym that has never saved the block and drops anything out of range, so
// the job never has to wonder what a missing field means. readBilling() is
// the strict reader for a save -- a value it cannot use is a 400 naming the
// field, never quietly replaced.

const MAX_DAYS = 30;
const MAX_REMINDERS = 5;
const CHANNELS = ['email', 'sms', 'whatsapp', 'push'];

const DEFAULTS = Object.freeze({
  reminderDaysBefore: [3],
  dueDayReminder: true,
  lastDayAfterDue: 3,
  // WhatsApp goes only when the gym has its own WhatsApp provider set up.
  sendVia: { email: true, sms: false, whatsapp: true, push: true },
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

function asBoolean(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

/**
 * A `billing` block sent to PUT /settings, merged over what is stored.
 * Every field is optional; a field left out keeps its stored value.
 *
 * @returns {{ value?: object, problem?: string }}
 */
function readBilling(input, existing) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { problem: 'billing must be an object' };
  const value = billingSettings({ billing: existing || {} });

  if (input.reminderDaysBefore !== undefined) {
    if (!Array.isArray(input.reminderDaysBefore)) return { problem: 'billing.reminderDaysBefore must be a list of days, e.g. [3]' };
    const days = input.reminderDaysBefore.map(wholeDays);
    if (days.some((n) => n === null)) return { problem: `billing.reminderDaysBefore: each day must be a whole number from 0 to ${MAX_DAYS}` };
    if (new Set(days).size > MAX_REMINDERS) return { problem: `billing.reminderDaysBefore: at most ${MAX_REMINDERS} reminders before the due date` };
    value.reminderDaysBefore = dayList(days);
  }
  if (input.dueDayReminder !== undefined) {
    const flag = asBoolean(input.dueDayReminder);
    if (flag === null) return { problem: 'billing.dueDayReminder must be true or false' };
    value.dueDayReminder = flag;
  }
  if (input.lastDayAfterDue !== undefined) {
    const days = wholeDays(input.lastDayAfterDue);
    if (days === null) return { problem: `billing.lastDayAfterDue must be a whole number from 0 to ${MAX_DAYS}` };
    value.lastDayAfterDue = days;
  }
  if (input.sendVia !== undefined) {
    if (!input.sendVia || typeof input.sendVia !== 'object') return { problem: 'billing.sendVia must be an object of channel switches' };
    for (const channel of CHANNELS) {
      if (input.sendVia[channel] === undefined) continue;
      const flag = asBoolean(input.sendVia[channel]);
      if (flag === null) return { problem: `billing.sendVia.${channel} must be true or false` };
      value.sendVia[channel] = flag;
    }
  }
  if (input.autoCharge !== undefined) {
    const raw = input.autoCharge && typeof input.autoCharge === 'object' ? input.autoCharge.enabled : input.autoCharge;
    const flag = asBoolean(raw);
    if (flag === null) return { problem: 'billing.autoCharge.enabled must be true or false' };
    value.autoCharge = { enabled: flag };
  }
  return { value };
}

module.exports = { DEFAULTS, MAX_DAYS, MAX_REMINDERS, CHANNELS, billingSettings, leadDays, readBilling };
