// src/services/currency.js
//
// The currency a gym charges in, from its settings. Anything created without
// an explicit currency (a package, a class price, a payroll record) uses
// this rather than a hardcoded default, so a gym in Dubai gets AED and a
// gym in Leeds gets GBP without anyone typing it twice.

const Settings = require('../models/settings');

const FALLBACK = 'USD';
const CODE = /^[A-Z]{3}$/;

function normalize(code) {
  const upper = String(code || '').trim().toUpperCase();
  return CODE.test(upper) ? upper : '';
}

/** The gym's currency code (ISO 4217), or USD when none is set yet. */
async function defaultCurrency() {
  try {
    const settings = await Settings.getSettings();
    return normalize(settings && settings.currency) || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/** `given` when it is a valid code, otherwise the gym's currency. */
async function currencyOr(given) {
  return normalize(given) || defaultCurrency();
}

module.exports = { defaultCurrency, currencyOr, normalize, FALLBACK };
