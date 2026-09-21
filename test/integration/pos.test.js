// The till against a real MongoDB, through posController: a sale takes stock
// with one conditional decrement, so the last unit is never sold twice; a
// refund returns stock exactly once, however many times it is pressed; and
// the accounts overview counts a sale until it is refunded.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let User;
let Product;
let Sale;
let StockMovement;
let pos;
let accounts;
let cashier;

const test = h.suite(async () => {
  User = h.src('models/user');
  Product = h.src('models/productModel');
  Sale = h.src('models/saleModel');
  StockMovement = h.src('models/stockMovementModel');
  pos = h.src('controller/posController');
  accounts = h.src('accounts/controller/accountsController');

  gym = await h.createGym('pos-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(Sale, Product, StockMovement);
    cashier = await User.create({ firstName: 'Cass', lastName: 'Ier', email: 'cass@pos.test', role: 'admin' });
  });
});

const as = (req) => ({ user: { id: String(cashier._id) }, roleSlug: 'admin', ...req });

async function product(name, stock, price = 2.5) {
  const res = await h.call(pos.createProduct, as({ body: { name, price, cost: 1, stock } }));
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body.data;
}

const sell = (productId, quantity) => h.call(pos.createSale, as({ body: { items: [{ productId, quantity }], paymentMethod: 'cash' } }));
const refund = (saleId) => h.call(pos.refundSale, as({ params: { id: saleId }, body: { reason: 'returned' } }));
const stockOf = async (id) => (await Product.findById(id).lean()).stock;

test('a sale takes stock, writes a receipt and a movement, and counts as money in', async () => {
  await h.inGym(gym, async () => {
    const water = await product('Water', 10, 1.5);
    const res = await sell(water.id, 3);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.total, 4.5);
    assert.equal(res.body.data.currency, 'GBP');
    assert.match(res.body.data.receipt_number, /^RCP-\d{4}-\d{5}$/);
    assert.equal(await stockOf(water.id), 7);
    const moves = await StockMovement.find({ productId: water.id, reason: 'sale' }).lean();
    assert.deepEqual(moves.map((m) => [m.delta, m.stockAfter]), [[-3, 7]]);

    const overview = await h.call(accounts.overview, { query: {} });
    assert.equal(overview.statusCode, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.income.base_amount, 4.5);
  });
});

test('two tills selling the last unit at once: one sale, one refusal, stock never negative', async () => {
  await h.inGym(gym, async () => {
    const bar = await product('Protein bar', 1);
    const results = await Promise.all([sell(bar.id, 1), sell(bar.id, 1)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409], JSON.stringify(results.map((r) => r.body)));
    assert.equal(await stockOf(bar.id), 0);
    assert.equal(await Sale.countDocuments({ 'items.productId': bar.id }), 1);
  });
});

test('a refund pressed twice returns the stock once', async () => {
  await h.inGym(gym, async () => {
    const towel = await product('Towel', 5, 6);
    const sold = await sell(towel.id, 2);
    assert.equal(sold.statusCode, 201, JSON.stringify(sold.body));
    assert.equal(await stockOf(towel.id), 3);

    const results = await Promise.all([refund(sold.body.data.id), refund(sold.body.data.id)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
    assert.equal(await stockOf(towel.id), 5, 'two units back, not four');

    const moves = await StockMovement.find({ productId: towel.id, reason: 'refund' }).lean();
    assert.deepEqual(moves.map((m) => [m.delta, m.stockAfter]), [[2, 5]]);
    const sale = await Sale.findById(sold.body.data.id).lean();
    assert.equal(sale.status, 'refunded');
    assert.ok(sale.refundedAt instanceof Date);

    // And once more, later: still refused, still five on the shelf.
    const late = await refund(sold.body.data.id);
    assert.equal(late.statusCode, 409);
    assert.equal(await stockOf(towel.id), 5);
  });
});

test('a refunded sale drops out of the takings', async () => {
  await h.inGym(gym, async () => {
    const overview = await h.call(accounts.overview, { query: {} });
    // Water (4.50) still counts; the towel sale (12.00) was refunded; the
    // protein bar (2.50) sold once.
    assert.equal(overview.body.income.base_amount, 7);
  });
});
