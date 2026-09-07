// src/gymfolio/services/bookingRules.js
//
// The gym's booking policy, from Settings → General → Booking rules, with
// sensible defaults for a gym that has never touched them. Cached briefly
// per gym: it is read on every timetable request.

const Settings = require('../../models/settings');
const { tenantKey } = require('../../platform/tenantContext');

const TTL_MS = 60 * 1000;
const cache = new Map(); // tenantKey -> { at, value }

const DEFAULTS = {
  horizonDays: 30,
  cutoffMinutes: 15,
  cancelHours: 2,
  requireActiveMembership: false,
  useCredits: true,
  noShowStrikes: 0,
  noShowWindowDays: 30,
  noShowBanDays: 7,
  autoNoShow: false
};

const PT_DEFAULTS = {
  slotMinutes: 60,
  defaultCommissionPercent: 0,
  allowMemberBooking: true,
  requirePack: false,
  cancelHours: 12,
  horizonDays: 30
};

function num(value, fallback, min = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function normalizeBooking(raw = {}) {
  return {
    horizonDays: Math.min(365, num(raw.horizonDays, DEFAULTS.horizonDays, 1)),
    cutoffMinutes: num(raw.cutoffMinutes, DEFAULTS.cutoffMinutes, 0),
    cancelHours: num(raw.cancelHours, DEFAULTS.cancelHours, 0),
    requireActiveMembership: raw.requireActiveMembership === true,
    useCredits: raw.useCredits !== false,
    noShowStrikes: num(raw.noShowStrikes, DEFAULTS.noShowStrikes, 0),
    noShowWindowDays: num(raw.noShowWindowDays, DEFAULTS.noShowWindowDays, 1),
    noShowBanDays: num(raw.noShowBanDays, DEFAULTS.noShowBanDays, 1),
    autoNoShow: raw.autoNoShow === true
  };
}

function normalizePt(raw = {}) {
  return {
    slotMinutes: Math.min(240, num(raw.slotMinutes, PT_DEFAULTS.slotMinutes, 15)),
    defaultCommissionPercent: Math.min(100, num(raw.defaultCommissionPercent, PT_DEFAULTS.defaultCommissionPercent, 0)),
    allowMemberBooking: raw.allowMemberBooking !== false,
    requirePack: raw.requirePack === true,
    cancelHours: num(raw.cancelHours, PT_DEFAULTS.cancelHours, 0),
    horizonDays: Math.min(365, num(raw.horizonDays, PT_DEFAULTS.horizonDays, 1))
  };
}

async function load() {
  const key = tenantKey();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = { booking: normalizeBooking(), pt: normalizePt(), rooms: [] };
  try {
    const settings = await Settings.getSettings();
    if (settings) {
      value = {
        booking: normalizeBooking(settings.booking || {}),
        pt: normalizePt(settings.pt || {}),
        rooms: Array.isArray(settings.rooms) ? settings.rooms.filter(Boolean) : []
      };
    }
  } catch {
    /* no settings row yet: defaults */
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The class booking rules. */
async function bookingRules() {
  return (await load()).booking;
}

/** The personal training rules. */
async function ptRules() {
  return (await load()).pt;
}

async function rooms() {
  return (await load()).rooms;
}

function resetRulesCache() {
  cache.delete(tenantKey());
}

module.exports = { DEFAULTS, PT_DEFAULTS, normalizeBooking, normalizePt, bookingRules, ptRules, rooms, resetRulesCache };
