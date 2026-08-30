// src/helper/money.js
//
// One place that turns whatever a price was typed as into a number, and one
// place that decides what currency a package is sold in.
//
// Why this exists: Package.price is a String (a gym types "5,000" or
// "Rs 2,500" as readily as "5000"), and the two code paths that turned it
// into money disagreed. The Stripe path stripped the formatting; the
// admin-assignment path used Number(), which returns NaN for "5,000" and was
// then coerced to 0 -- silently recording a paid membership worth nothing.
// Both now call parseAmount.
//
// Currency had the same problem from the other end: three defaults for the
// same field (the model said PKR, admin assignment said GBP, the Stripe
// service said USD), so the currency an order was booked in depended on which
// screen created it. resolveCurrency is now the only answer.

// Currencies the settings screen offers. Anything outside this list is still
// accepted -- a gym may sell in something we have not listed -- but only a
// three-letter code is trusted enough to send to Stripe.
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

// Symbols and local shorthands that show up in a typed price, mapped to the
// code they mean. Kept deliberately short: this is for cleaning up admin
// input, not for parsing arbitrary text.
const CURRENCY_ALIASES = {
  '$': 'USD',
  'us$': 'USD',
  'usd': 'USD',
  '£': 'GBP',
  'gbp': 'GBP',
  '€': 'EUR',
  'eur': 'EUR',
  'rs': 'PKR',
  'rs.': 'PKR',
  '₨': 'PKR',
  'pkr': 'PKR',
  '₹': 'INR',
  'inr': 'INR',
  'aed': 'AED',
  'sar': 'SAR'
};

// The last resort, used only when neither the package nor the gym's settings
// say anything. Matches the Package model's own default so a package created
// with no currency reads the same everywhere.
const FALLBACK_CURRENCY = 'PKR';

/**
 * Turns a typed price into a number of major units (rupees, pounds, dollars).
 *
 * Handles the shapes an admin actually types: "5000", "5,000", "Rs 5,000",
 * "$1,299.99", 5000, "5000.50". Returns null -- never 0 -- when there is no
 * number in there at all, so a caller can tell "free" apart from "unreadable"
 * and refuse to write a bogus order.
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null} amount in major units, or null if unparseable
 */
function parseAmount(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  // A negative price is not a price. Caught before the strip below, which
  // would otherwise remove the sign and turn "-5" into 5.
  if (/-\s*\d/.test(raw)) return null;

  // Drop the currency symbol, the code, and any spaces, leaving only digits
  // and whichever separators were typed ("Rs 5,000" -> "5,000").
  let digits = raw.replace(/[^\d.,]/g, '');

  // A separator with no digit on one side of it belonged to the text we just
  // removed, not to the number: "Rs. 1,200/-" leaves ".1,200", whose leading
  // dot came from the abbreviation and would otherwise be read as a decimal
  // point. Trim them before deciding what the remaining separators mean.
  digits = digits.replace(/^[.,]+/, '').replace(/[.,]+$/, '');
  if (!digits) return null;

  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present, so the one that appears LAST is the decimal
    // point and the other is grouping. This is what tells "1,299.99" apart
    // from the European "1.500,50" without having to know the locale.
    if (lastComma > lastDot) {
      digits = digits.replace(/\./g, '').replace(',', '.');
    } else {
      digits = digits.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only commas. Ambiguous in principle -- "5,000" is five thousand but
    // "5,50" is five and a half in much of Europe. This system's gyms type
    // the first, so a comma is read as grouping.
    digits = digits.replace(/,/g, '');
  }

  // More than one dot left means they were all grouping, not a decimal point
  // ("1.500.000"). The giveaway is the final group: three digits is a
  // thousands group, anything else is the fractional part.
  const parts = digits.split('.');
  let cleaned = digits;
  if (parts.length > 2) {
    cleaned = parts[parts.length - 1].length === 3
      ? parts.join('')
      : parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  }

  const amount = parseFloat(cleaned);
  if (!Number.isFinite(amount) || amount < 0) return null;

  // Money is two decimal places. Rounding here keeps a stray third digit out
  // of the stored amount, where it would later disagree with what Stripe
  // charged in minor units.
  return Math.round(amount * 100) / 100;
}

/**
 * parseAmount for callers that must have a number and would rather record
 * zero than fail -- reporting totals, mostly, where one unreadable row should
 * not blank the whole report.
 *
 * Do NOT use this when writing an order. Use parseAmount and reject null.
 *
 * @param {string|number|null|undefined} value
 * @returns {number}
 */
function parseAmountOrZero(value) {
  const amount = parseAmount(value);
  return amount === null ? 0 : amount;
}

/**
 * Normalises whatever is in a currency field to an uppercase three-letter
 * code, resolving the symbols and shorthands people type.
 *
 * @param {string|null|undefined} value
 * @returns {string|null} e.g. 'PKR', or null if it cannot be read
 */
function normaliseCurrency(value) {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const alias = CURRENCY_ALIASES[raw.toLowerCase()];
  if (alias) return alias;

  if (CURRENCY_CODE.test(raw)) return raw.toUpperCase();

  return null;
}

/**
 * The currency an order should be booked in, in the order the answer should
 * be trusted: what the package says, then what the gym's settings say, then
 * the fallback.
 *
 * Callers pass the settings currency rather than this module reading Settings
 * itself, so this file stays synchronous and free of database access -- it is
 * called from inside loops that total up reports.
 *
 * @param {string|null|undefined} packageCurrency
 * @param {string|null|undefined} settingsCurrency
 * @returns {string} an uppercase three-letter code
 */
function resolveCurrency(packageCurrency, settingsCurrency) {
  return (
    normaliseCurrency(packageCurrency) ||
    normaliseCurrency(settingsCurrency) ||
    FALLBACK_CURRENCY
  );
}

/**
 * Stripe charges in minor units (paisa, pence, cents). Zero-decimal
 * currencies are the exception -- sending 100 for ¥100 would charge ¥10,000.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
]);

/**
 * @param {number} amount major units
 * @param {string} currency three-letter code
 * @returns {number} integer in the currency's smallest unit
 */
function toMinorUnits(amount, currency) {
  const code = normaliseCurrency(currency) || FALLBACK_CURRENCY;
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return Math.round(amount);
  return Math.round(amount * 100);
}

module.exports = {
  FALLBACK_CURRENCY,
  parseAmount,
  parseAmountOrZero,
  normaliseCurrency,
  resolveCurrency,
  toMinorUnits
};
