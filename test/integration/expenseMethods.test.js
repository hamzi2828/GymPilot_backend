// How an expense was paid, and how much, against a real MongoDB: JazzCash and
// Easypaisa are kept as themselves (they used to be filed as cash without a
// word), an unknown method is refused with the list, an old row's retired
// method survives an edit, and an amount typed as "1,20,000" is read the way
// a package price is.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let Expense;
let Asset;
let expenses;
let assets;

const test = h.suite(async () => {
  Expense = h.src('accounts/models/expenseModel');
  Asset = h.src('accounts/models/assetModel');
  expenses = h.src('accounts/controller/expenseController');
  assets = h.src('accounts/controller/assetController');
  gym = await h.createGym('expense-methods-gym', { timezone: 'Asia/Karachi', currency: 'PKR' });
  await h.inGym(gym, () => h.ensureIndexes(Expense, Asset));
});

const user = { id: null, firstName: 'Ada', lastName: 'Admin' };
const create = (body) => h.inGym(gym, () => h.call(expenses.create, { user, body: { title: 'Rent', category: 'rent', incurredOn: '2026-10-01', ...body } }));

test('JazzCash, Easypaisa and the rest are kept as they were paid, with a readable label', async () => {
  for (const [method, label] of [['jazzcash', 'JazzCash'], ['easypaisa', 'Easypaisa'], ['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['cheque', 'Cheque'], ['other', 'Other']]) {
    const res = await create({ amount: 1000, paymentMethod: method });
    assert.equal(res.statusCode, 201, `${method}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.expense.payment_method, method);
    assert.equal(res.body.expense.payment_method_label, label);
    const stored = await h.inGym(gym, () => Expense.findById(res.body.expense.id).lean());
    assert.equal(stored.paymentMethod, method);
  }

  // Nothing sent is cash, as before.
  const plain = await create({ amount: 10 });
  assert.equal(plain.body.expense.payment_method, 'cash');

  const list = await h.inGym(gym, () => h.call(expenses.list, { query: { from: '2026-10-01', to: '2026-10-31' } }));
  assert.equal(list.statusCode, 200);
  assert.ok(list.body.methods.includes('jazzcash') && list.body.methods.includes('easypaisa'));
  assert.ok(!list.body.methods.includes('stripe'), 'a bill is not paid through the gym\'s Stripe');
  assert.deepEqual(list.body.method_options.find((o) => o.value === 'easypaisa'), { value: 'easypaisa', label: 'Easypaisa' });
});

test('an unknown method is refused with the list, and nothing is recorded', async () => {
  const before = await h.inGym(gym, () => Expense.countDocuments());
  for (const method of ['paypal', 'JazzCash', 'stripe']) {
    const res = await create({ amount: 500, paymentMethod: method });
    assert.equal(res.statusCode, 400, method);
    assert.match(res.body.message, new RegExp(`"${method}" is not a payment method for an expense`));
    assert.match(res.body.message, /JazzCash, Easypaisa/);
  }
  assert.equal(await h.inGym(gym, () => Expense.countDocuments()), before);
});

test('amounts are read as the gym writes them: "1,20,000", "Rs 5,000"', async () => {
  for (const [typed, amount] of [['1,20,000', 120000], ['Rs 5,000', 5000], ['2500.50', 2500.5], [750, 750]]) {
    const res = await create({ amount: typed, paymentMethod: 'cash' });
    assert.equal(res.statusCode, 201, `${typed}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.expense.amount, amount, String(typed));
  }
  for (const typed of ['', 'abc', '-50', null]) {
    const res = await create({ amount: typed });
    assert.equal(res.statusCode, 400, String(typed));
    assert.match(res.body.message, /Enter a valid amount/);
  }
});

test('editing keeps the method the row has: an old "online" row, and an edit that does not send one', async () => {
  const old = await h.inGym(gym, () =>
    Expense.create({ reference: 'EXP-202610-0900', title: 'Old', category: 'rent', amount: 100, currency: 'PKR', incurredOn: new Date('2026-10-02T07:00:00Z'), status: 'paid', paymentMethod: 'online' })
  );
  const kept = await h.inGym(gym, () => h.call(expenses.update, { user, params: { id: String(old._id) }, body: { title: 'Old bill', amount: '1,000', paymentMethod: 'online' } }));
  assert.equal(kept.statusCode, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.expense.payment_method, 'online');
  assert.equal(kept.body.expense.amount, 1000);

  const wallet = await create({ amount: 300, paymentMethod: 'jazzcash' });
  const untouched = await h.inGym(gym, () => h.call(expenses.update, { user, params: { id: wallet.body.expense.id }, body: { title: 'Rent (Oct)', amount: 300 } }));
  assert.equal(untouched.statusCode, 200);
  assert.equal(untouched.body.expense.payment_method, 'jazzcash', 'not turned into cash by an edit that left it out');

  // A new row cannot be given the retired method.
  const fresh = await create({ amount: 1, paymentMethod: 'online' });
  assert.equal(fresh.statusCode, 400);
});

test('an asset bought by Easypaisa records its expense as Easypaisa; an unknown method saves neither', async () => {
  const body = { name: 'Treadmill', category: 'cardio', quantity: 1, unitCost: '1,50,000', purchasedOn: '2026-10-03', recordExpense: true };
  const bought = await h.inGym(gym, () => h.call(assets.create, { user, body: { ...body, paymentMethod: 'easypaisa' } }));
  assert.equal(bought.statusCode, 201, JSON.stringify(bought.body));
  const expense = await h.inGym(gym, () => Expense.findOne({ title: /Treadmill/ }).lean());
  assert.equal(expense.paymentMethod, 'easypaisa');

  const assetsBefore = await h.inGym(gym, () => Asset.countDocuments());
  const refused = await h.inGym(gym, () => h.call(assets.create, { user, body: { ...body, name: 'Bike', paymentMethod: 'barter' } }));
  assert.equal(refused.statusCode, 400);
  assert.equal(await h.inGym(gym, () => Asset.countDocuments()), assetsBefore);
});
