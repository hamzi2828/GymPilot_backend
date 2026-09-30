// Expense and asset heads (accounts/services/categories.js): the built-in list
// plus a gym's own, which head a form may file a row under, and the keys a
// new head gets. No database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const categories = require('../../src/accounts/services/categories');

const builtIn = [
  { key: 'rent', label: 'Rent & premises', built_in: true, archived: false },
  { key: 'utilities', label: 'Utilities', built_in: true, archived: false },
  { key: 'other', label: 'Other', built_in: true, archived: false }
];

const own = [
  { _id: 'a1', key: 'c_tea', label: 'Tea', archived: false },
  { _id: 'a2', key: 'c_electricity_bill', label: 'Electricity bill', archived: false },
  { _id: 'a3', key: 'c_newspapers', label: 'Newspapers', archived: true }
];

test('built-in heads come first in their own order, then the gym\'s own by name', () => {
  const heads = categories.mergeHeads('expense', builtIn, own);
  assert.deepEqual(heads.all.map((head) => head.key), ['rent', 'utilities', 'other', 'c_electricity_bill', 'c_newspapers', 'c_tea']);
  assert.deepEqual(heads.active.map((head) => head.key), ['rent', 'utilities', 'other', 'c_electricity_bill', 'c_tea']);
  assert.deepEqual(heads.archived.map((head) => head.key), ['c_newspapers']);
  assert.equal(heads.all.find((head) => head.key === 'c_tea').id, 'a1');
});

test('every head has a label, an archived one included; an unknown key reads as itself', () => {
  const heads = categories.mergeHeads('expense', builtIn, own);
  assert.equal(heads.labelOf('c_tea'), 'Tea');
  assert.equal(heads.labelOf('c_newspapers'), 'Newspapers');
  assert.equal(heads.labelOf('rent'), 'Rent & premises');
  assert.equal(heads.labelOf('c_gone'), 'c_gone');
});

test('a gym\'s own asset head is written down over five years until told otherwise', () => {
  const heads = categories.mergeHeads('asset', [{ key: 'cardio', label: 'Cardio machines', built_in: true, archived: false, default_life: 7 }], [
    { _id: 'b1', key: 'c_boxing_kit', label: 'Boxing kit', archived: false }
  ]);
  assert.equal(heads.all.find((head) => head.key === 'c_boxing_kit').default_life, categories.CUSTOM_ASSET_LIFE_YEARS);
  assert.equal(categories.CUSTOM_ASSET_LIFE_YEARS, 5);
});

test('a new row takes a built-in or active head; nothing sent is "other"', () => {
  const heads = categories.mergeHeads('expense', builtIn, own);
  assert.equal(categories.pickCategory(heads, 'utilities', undefined), 'utilities');
  assert.equal(categories.pickCategory(heads, 'c_tea', undefined), 'c_tea');
  assert.equal(categories.pickCategory(heads, undefined, undefined), 'other');
  assert.equal(categories.pickCategory(heads, '', undefined), 'other');
});

test('an archived head is refused for a new row but kept on the rows already filed under it', () => {
  const heads = categories.mergeHeads('expense', builtIn, own);
  assert.throws(() => categories.pickCategory(heads, 'c_newspapers', undefined), (error) => {
    assert.ok(error instanceof categories.CategoryError);
    assert.equal(error.status, 400);
    assert.match(error.message, /"Newspapers" is archived/);
    return true;
  });
  assert.equal(categories.pickCategory(heads, 'c_newspapers', 'c_newspapers'), 'c_newspapers');
  // An edit that does not send the head keeps the one the row has.
  assert.equal(categories.pickCategory(heads, undefined, 'c_newspapers'), 'c_newspapers');
  // Moving it off the archived head is fine.
  assert.equal(categories.pickCategory(heads, 'c_tea', 'c_newspapers'), 'c_tea');
});

test('a head that does not exist is refused, not quietly filed under "other"', () => {
  const heads = categories.mergeHeads('expense', builtIn, own);
  assert.throws(() => categories.pickCategory(heads, 'c_nonsense', undefined), /no expense head called "c_nonsense"/);
});

test('a new head\'s key comes from its name, prefixed clear of the built-in keys', () => {
  assert.equal(categories.keyBase('Electricity bill'), 'c_electricity_bill');
  assert.equal(categories.keyBase('  Tea & snacks!! '), 'c_tea_snacks');
  assert.equal(categories.keyBase('Café'), 'c_cafe');
  assert.equal(categories.keyBase('بجلی'), 'c_head');
  assert.ok(categories.keyBase('x'.repeat(100)).length <= 42);
});
