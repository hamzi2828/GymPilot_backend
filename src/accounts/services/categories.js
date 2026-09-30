// src/accounts/services/categories.js
//
// The heads an expense or an asset can be filed under: the built-in lists on
// the two models, which every gym has and cannot remove, plus the gym's own
// (models/categoryModel.js). Every screen that names a head -- the lists,
// their filters and summaries, the overview, the CSVs -- reads its label from
// here, so a head renamed once reads the same everywhere, and a row filed
// under a head that has since been archived still has a name.

const Category = require('../models/categoryModel');
const Expense = require('../models/expenseModel');
const Asset = require('../models/assetModel');

// What a gym's own asset head is written down over, until the operator types
// a useful life for the item: the built-in "Other" head's default.
const CUSTOM_ASSET_LIFE_YEARS = 5;

const KEY_PREFIX = 'c_';

class CategoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const KIND_NOUN = { expense: 'expense head', asset: 'asset head' };

function builtInHeads(kind) {
  if (kind === 'asset') {
    return Asset.CATEGORIES.map((key) => ({
      key,
      label: Asset.CATEGORY_LABELS[key],
      built_in: true,
      archived: false,
      default_life: Asset.DEFAULT_LIFE_YEARS[key]
    }));
  }
  return Expense.CATEGORIES.map((key) => ({ key, label: Expense.CATEGORY_LABELS[key], built_in: true, archived: false }));
}

/**
 * The built-in heads, in their own order, then the gym's own by name.
 * Pure: `custom` is the gym's category documents of this kind.
 */
function mergeHeads(kind, builtIn, custom = []) {
  const own = custom
    .map((doc) => ({
      id: String(doc._id),
      key: doc.key,
      label: doc.label,
      built_in: false,
      archived: !!doc.archived,
      ...(kind === 'asset' ? { default_life: CUSTOM_ASSET_LIFE_YEARS } : {})
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const all = [...builtIn, ...own];
  const labels = new Map(all.map((head) => [head.key, head.label]));

  return {
    kind,
    all,
    // What a new row may be filed under.
    active: all.filter((head) => !head.archived),
    archived: all.filter((head) => head.archived),
    labels,
    labelOf: (key) => labels.get(key) || key,
    accepts: (key) => all.some((head) => head.key === key && !head.archived)
  };
}

/** Every head of one kind for the current gym, archived ones included. */
async function headsFor(kind) {
  const custom = await Category.find({ kind }).lean();
  return mergeHeads(kind, builtInHeads(kind), custom);
}

/**
 * The head a row is filed under, from what the form sent.
 *
 * Nothing sent keeps what the row has (or `fallback` on a new row). A head
 * the row already has is kept even when it has since been archived: the old
 * rows keep their head, which is the point of archiving rather than deleting.
 * Anything else must be a head that is offered for new rows.
 */
function pickCategory(heads, requested, current, fallback = 'other') {
  if (requested === undefined || requested === null || String(requested).trim() === '') return current || fallback;
  const key = String(requested).trim();
  if (current && key === current) return key;
  if (heads.accepts(key)) return key;

  const known = heads.all.find((head) => head.key === key);
  if (known) throw new CategoryError(`"${known.label}" is archived. Restore it under Manage heads, or choose another.`);
  throw new CategoryError(`There is no ${KIND_NOUN[heads.kind] || 'head'} called "${key}".`);
}

function cleanLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// 'Electricity bill' -> 'c_electricity_bill'. Only a starting point: a label
// in a script with no latin letters gives 'c_head', and a key that is taken
// (by an archived head too) gets a number on the end.
function keyBase(label) {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return KEY_PREFIX + (slug || 'head');
}

// A label may not repeat another head of the same kind, whatever its case:
// two heads both called "Tea" would split one cost across two lines.
function assertLabelFree(heads, label, exceptKey = null) {
  const wanted = label.toLowerCase();
  const clash = heads.all.find((head) => head.key !== exceptKey && head.label.toLowerCase() === wanted);
  if (!clash) return;
  if (clash.archived) throw new CategoryError(`"${clash.label}" already exists but is archived. Restore it instead.`, 409);
  throw new CategoryError(`There is already a head called "${clash.label}".`, 409);
}

async function createHead(kind, label, { createdBy = null, createdByName = '' } = {}) {
  if (!Category.KINDS.includes(kind)) throw new CategoryError('kind must be expense or asset');
  const name = cleanLabel(label);
  if (!name) throw new CategoryError('Give the head a name');
  if (name.length > 60) throw new CategoryError('Keep the name to 60 characters');

  const heads = await headsFor(kind);
  assertLabelFree(heads, name);

  const base = keyBase(name);
  const taken = new Set(heads.all.map((head) => head.key));
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;

  try {
    return await Category.create({ kind, key, label: name, createdBy, createdByName });
  } catch (error) {
    // Two people adding the same head at once: the unique index let one in.
    if (error && error.code === 11000) throw new CategoryError(`There is already a head called "${name}".`, 409);
    throw error;
  }
}

/** Renames and/or archives (or restores) one of the gym's own heads. */
async function updateHead(id, { label, archived } = {}) {
  const doc = await Category.findById(id);
  if (!doc) throw new CategoryError('Head not found', 404);

  if (label !== undefined) {
    const name = cleanLabel(label);
    if (!name) throw new CategoryError('Give the head a name');
    if (name.length > 60) throw new CategoryError('Keep the name to 60 characters');
    assertLabelFree(await headsFor(doc.kind), name, doc.key);
    doc.label = name;
  }
  if (archived !== undefined) doc.archived = archived === true || archived === 'true';

  await doc.save();
  return doc;
}

module.exports = {
  CUSTOM_ASSET_LIFE_YEARS,
  CategoryError,
  builtInHeads,
  mergeHeads,
  headsFor,
  pickCategory,
  keyBase,
  createHead,
  updateHead
};
