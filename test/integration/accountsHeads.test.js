// A gym's own expense and asset heads against a real MongoDB: adding,
// renaming and archiving one through the controller, and that the expense
// and asset lists, their filters and summaries, and the accounts overview all
// name rows by the head's current label.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let Category;
let Expense;
let Asset;
let heads;
let expenses;
let assets;
let accounts;

const test = h.suite(async () => {
  Category = h.src('accounts/models/categoryModel');
  Expense = h.src('accounts/models/expenseModel');
  Asset = h.src('accounts/models/assetModel');
  heads = h.src('accounts/controller/categoryController');
  expenses = h.src('accounts/controller/expenseController');
  assets = h.src('accounts/controller/assetController');
  accounts = h.src('accounts/controller/accountsController');
  gym = await h.createGym('heads-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, () => h.ensureIndexes(Category, Expense, Asset));
});

const user = { id: null, firstName: 'Ada', lastName: 'Admin' };
const september = { from: '2026-09-01', to: '2026-09-30' };

let tea;

test('a gym adds its own expense head; the built-in heads stay', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(heads.create, { user, body: { kind: 'expense', label: 'Tea' } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    tea = res.body.head;
    assert.equal(tea.key, 'c_tea');
    assert.equal(tea.label, 'Tea');
    assert.equal(tea.built_in, false);

    const list = await h.call(heads.list, {});
    const keys = list.body.expense.map((head) => head.key);
    assert.ok(keys.includes('rent') && keys.includes('other') && keys.includes('c_tea'));
    assert.equal(list.body.expense.find((head) => head.key === 'rent').built_in, true);
  });
});

test('a name another head already has is refused, whatever its case', async () => {
  await h.inGym(gym, async () => {
    const again = await h.call(heads.create, { user, body: { kind: 'expense', label: 'tea' } });
    assert.equal(again.statusCode, 409);
    const builtIn = await h.call(heads.create, { user, body: { kind: 'expense', label: 'UTILITIES' } });
    assert.equal(builtIn.statusCode, 409);
    const blank = await h.call(heads.create, { user, body: { kind: 'expense', label: '   ' } });
    assert.equal(blank.statusCode, 400);
    const kind = await h.call(heads.create, { user, body: { kind: 'income', label: 'Grants' } });
    assert.equal(kind.statusCode, 400);
  });
});

test('expenses file under the new head, and list, filter and summary name it', async () => {
  await h.inGym(gym, async () => {
    const created = await h.call(expenses.create, {
      user,
      body: { title: 'Tea for the desk', category: 'c_tea', amount: 12, incurredOn: '2026-09-03', status: 'paid' }
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.expense.category_label, 'Tea');
    await h.call(expenses.create, { user, body: { title: 'Power', category: 'utilities', amount: 80, incurredOn: '2026-09-04', status: 'paid' } });

    const list = await h.call(expenses.list, { query: { ...september } });
    assert.equal(list.statusCode, 200, JSON.stringify(list.body));
    assert.ok(list.body.categories.some((head) => head.key === 'c_tea' && head.label === 'Tea'));
    const byCategory = Object.fromEntries(list.body.summary.by_category.map((entry) => [entry.category, entry.label]));
    assert.equal(byCategory.c_tea, 'Tea');

    const filtered = await h.call(expenses.list, { query: { ...september, category: 'c_tea' } });
    assert.deepEqual(filtered.body.expenses.map((row) => row.title), ['Tea for the desk']);
  });
});

test('renaming a head renames every row filed under it, on every screen', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(heads.update, { user, params: { id: tea.id }, body: { label: 'Tea & snacks' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.head.key, 'c_tea', 'the key never changes');

    const list = await h.call(expenses.list, { query: { ...september, category: 'c_tea' } });
    assert.equal(list.body.expenses[0].category_label, 'Tea & snacks');

    const overview = await h.call(accounts.overview, { query: { ...september } });
    assert.equal(overview.statusCode, 200, JSON.stringify(overview.body));
    const entry = overview.body.spending.by_category.find((row) => row.category === 'c_tea');
    assert.equal(entry.label, 'Tea & snacks');
  });
});

test('an archived head is no longer offered or accepted, and old rows keep it', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(heads.update, { user, params: { id: tea.id }, body: { archived: true } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    const refused = await h.call(expenses.create, {
      user,
      body: { title: 'More tea', category: 'c_tea', amount: 5, incurredOn: '2026-09-05', status: 'paid' }
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body.message, /archived/);

    const list = await h.call(expenses.list, { query: { ...september } });
    assert.ok(!list.body.categories.some((head) => head.key === 'c_tea'), 'not offered for new rows');
    assert.deepEqual(list.body.archived_categories, [{ key: 'c_tea', label: 'Tea & snacks' }]);
    const old = list.body.expenses.find((row) => row.title === 'Tea for the desk');
    assert.equal(old.category_label, 'Tea & snacks');

    // Editing the old row without touching its head keeps it.
    const edited = await h.call(expenses.update, {
      user,
      params: { id: old.id },
      body: { title: 'Tea for the front desk', category: 'c_tea', amount: 12, incurredOn: '2026-09-03', status: 'paid' }
    });
    assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
    assert.equal((await Expense.findById(old.id).lean()).category, 'c_tea');

    // Restored, it is offered again.
    await h.call(heads.update, { user, params: { id: tea.id }, body: { archived: false } });
    const again = await h.call(expenses.list, { query: { ...september } });
    assert.ok(again.body.categories.some((head) => head.key === 'c_tea'));
  });
});

test('assets take the gym\'s own heads too, with a default useful life', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(heads.create, { user, body: { kind: 'asset', label: 'Boxing kit' } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.head.default_life, 5);

    const created = await h.call(assets.create, { user, body: { name: 'Heavy bag', category: 'c_boxing_kit', unitCost: '100', purchasedOn: '2026-09-02' } });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.asset.category_label, 'Boxing kit');
    assert.equal(created.body.asset.useful_life_years, 5);

    const list = await h.call(assets.list, { query: { category: 'c_boxing_kit' } });
    assert.deepEqual(list.body.assets.map((row) => row.name), ['Heavy bag']);
    assert.equal(list.body.summary.by_category[0].label, 'Boxing kit');
    assert.ok(list.body.categories.some((head) => head.key === 'c_boxing_kit' && head.default_life === 5));

    // Expense and asset heads are separate lists.
    const wrongKind = await h.call(expenses.create, { user, body: { title: 'Gloves', category: 'c_boxing_kit', amount: 5, incurredOn: '2026-09-05' } });
    assert.equal(wrongKind.statusCode, 400);
  });
});
