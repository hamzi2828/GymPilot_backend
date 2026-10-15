// src/services/currency.js
//
// The currency a gym charges in, from its settings. Anything created without
// an explicit currency (a package, a class price, a payroll record) uses
// this rather than a hardcoded default, so a gym in Dubai gets AED and a
// gym in Leeds gets GBP without anyone typing it twice.
//
// It is also the ONE currency the gym's catalogue is priced in: packages,
// classes, PT packs, coupons, shop products and lockers. catalogueCurrency()
// below makes those models read and write the settings currency whatever
// their own `currency` field says, and relabelCatalogue() rewrites that
// field when the owner changes the setting. History -- orders, sales,
// payments, refunds, expenses, payslips -- keeps the currency it was
// recorded in.

const Settings = require('../models/settings');

const FALLBACK = 'USD';
const CODE = /^[A-Z]{3}$/;

function normalize(code) {
  const upper = String(code || '').trim().toUpperCase();
  return CODE.test(upper) ? upper : '';
}

// The settings currency on one gym's connection, or '' when there is no
// settings row (or no gym to ask). A lean read of the one field: this runs
// on every catalogue read, so it must not open the sealed secrets the way
// Settings.getSettings() does.
async function settingsCurrency(connection) {
  try {
    const Model = (connection && connection.models && connection.models.Settings) || Settings;
    const row = await Model.findOne({ isActive: true }).select('currency').lean();
    return normalize(row && row.currency);
  } catch {
    return '';
  }
}

/** The gym's currency code (ISO 4217), or USD when none is set yet. */
async function defaultCurrency() {
  return (await settingsCurrency(null)) || FALLBACK;
}

/** `given` when it is a valid code, otherwise the gym's currency. */
async function currencyOr(given) {
  return normalize(given) || defaultCurrency();
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Schema plugin for a catalogue model. The gym's currency wins over the
 * document's own field:
 *
 *   - on save (create or edit) the field is set to it, so a client that sends
 *     another code -- an old app build, a form that still has a currency
 *     select -- cannot price one item in a currency the gym does not take;
 *   - on findOneAndUpdate/updateOne a `currency` in the update is replaced
 *     with it, for the same reason;
 *   - on every find the documents handed back carry it, so a row the relabel
 *     has not reached yet (or that predates it) never shows a foreign
 *     currency on the site, the portal, the app or a new order.
 *
 * When the gym's currency cannot be read (no settings row, no gym in
 * context) the document's own field is left as it is (a new one with none
 * gets the fallback).
 */
function catalogueCurrency(schema, { path = 'currency' } = {}) {
  schema.pre('validate', async function () {
    const code = await settingsCurrency(this.constructor && this.constructor.db);
    if (!code) {
      if (!this.get(path)) this.set(path, FALLBACK);
      return;
    }
    this.set(path, code);
    // Written even when the in-memory copy already showed it (the read hook
    // below), so the stored field catches up on the next save.
    this.markModified(path);
  });

  schema.pre(['findOneAndUpdate', 'updateOne'], async function () {
    const update = this.getUpdate();
    if (!update) return;
    const sets = [update, update.$set, update.$setOnInsert].filter((u) => u && Object.prototype.hasOwnProperty.call(u, path));
    if (!sets.length) return;
    const code = await settingsCurrency(this.model && this.model.db);
    if (!code) return;
    for (const u of sets) u[path] = code;
  });

  schema.post(['find', 'findOne', 'findOneAndUpdate'], async function (result) {
    const rows = Array.isArray(result) ? result : result ? [result] : [];
    if (!rows.length) return;
    const code = await settingsCurrency(this.model && this.model.db);
    if (!code) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.set === 'function' && row.$__) {
        if (!row.isSelected(path) || row.get(path) === code) continue;
        row.set(path, code);
        // Shown, not an edit: saving the document for another reason writes
        // it anyway (the validate hook above).
        row.unmarkModified(path);
      } else {
        row[path] = code;
      }
    }
  });
}

/**
 * Schema plugin for a record of money taken or paid (a sale, a payslip, an
 * expense): a new one written without a currency gets the gym's, read at
 * the moment it is created -- never a code hard-wired into the model. Once
 * written it is history and keeps its currency.
 */
function recordCurrencyDefault(schema, { path = 'currency' } = {}) {
  schema.pre('validate', async function () {
    if (!this.isNew || this.get(path)) return;
    this.set(path, (await settingsCurrency(this.constructor && this.constructor.db)) || FALLBACK);
  });
}

// The catalogue collections relabelled when the gym's currency changes, as
// model paths. Required lazily: the models load this file for the plugin.
const CATALOGUE = [
  ['packages', '../gymfolio/models/packageModel'], // memberships, drop-ins, PT packs
  ['classes', '../gymfolio/models/gymClassModel'],
  ['coupons', '../gymfolio/models/couponModel'],
  ['products', '../models/productModel'],
  ['lockers', '../models/lockerModel']
];

/**
 * Rewrites the currency label on every catalogue item, and on the staff pay
 * settings payslips are worked out from, to `code`. One bulk update per
 * collection; amounts are never touched -- there is no exchange rate here,
 * a price of 24 stays 24. Idempotent: rows already in `code` are not
 * matched, so a second run changes nothing.
 *
 * Orders, sales, payments, refunds, invoices, expenses and payslips are not
 * touched: they keep the currency the money was taken or paid in.
 *
 * @param {string} currency the gym's new currency
 * @returns {Promise<Record<string, number>>} rows changed, per collection
 */
async function relabelCatalogue(currency) {
  const code = normalize(currency);
  if (!code) throw new Error(`relabelCatalogue: "${currency}" is not a currency code`);

  const changed = {};
  for (const [label, file] of CATALOGUE) {
    const Model = require(file);
    const result = await Model.updateMany({ currency: { $ne: code } }, { $set: { currency: code } });
    changed[label] = result.modifiedCount || 0;
  }

  // Staff pay settings. Members carry an empty payroll block too, so only
  // staff are matched, and their updatedAt is left alone: a currency label
  // is not an edit to the person.
  const User = require('../models/user');
  const staff = await User.updateMany(
    { 'employment.isStaff': true, 'employment.payroll.currency': { $nin: [code, '', null] } },
    { $set: { 'employment.payroll.currency': code } },
    { timestamps: false }
  );
  changed.staffPay = staff.modifiedCount || 0;

  return changed;
}

module.exports = { defaultCurrency, currencyOr, normalize, catalogueCurrency, recordCurrencyDefault, relabelCatalogue, FALLBACK };
