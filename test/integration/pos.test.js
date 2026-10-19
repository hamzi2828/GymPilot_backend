// The till against a real MongoDB, through posController: a sale takes stock
// with one conditional decrement, so the last unit is never sold twice; a
// refund returns stock exactly once, however many times it is pressed; and
// the accounts overview counts a sale until it is refunded. The receipt
// settings are read by anyone who can see the till and changed only at
// manage, checked over HTTP through allRoutes.

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let Product;
let Sale;
let StockMovement;
let pos;
let accounts;
let cashier;
let bookkeeper;

const test = h.suite(async () => {
  User = h.src('models/user');
  Product = h.src('models/productModel');
  Sale = h.src('models/saleModel');
  StockMovement = h.src('models/stockMovementModel');
  pos = h.src('controller/posController');
  accounts = h.src('accounts/controller/accountsController');

  gym = await h.createGym('pos-gym', {
    timezone: 'UTC',
    currency: 'GBP',
    settings: { address: '1 High Street', mobileNumber: '+44 20 7946 0000', invoice: { taxLabel: 'VAT', taxNumber: 'GB123', footerNote: 'Thanks for training with us' } }
  });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(Sale, Product, StockMovement);
    await h.src('services/roleService').ensureDefaultRoles();
    cashier = await User.create({ firstName: 'Cass', lastName: 'Ier', email: 'cass@pos.test', role: 'admin' });
    // The default Accountant role: the till at view, nothing more.
    bookkeeper = await User.create({ firstName: 'Bea', lastName: 'Keeper', email: 'bea@pos.test', role: 'accountant', employment: { isStaff: true } });
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

// allRoutes on a real port, the way index.js mounts it, so the permission
// gates in front of each handler are the ones being tested.
async function withServer(fn) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.tenant = gym;
    h.inGym(gym, async () => next()).catch(next);
  });
  app.use('/', h.src('routes/allRoutes'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (user, method, path, body) => {
    const token = jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, body: json };
  };
  try {
    return await fn(send);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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

test('receipt settings: the gym details, sensible defaults, and only valid values saved', async () => {
  await h.inGym(gym, async () => {
    const Settings = h.src('models/settings');
    const read = await h.call(pos.receiptSettings, as({}));
    assert.equal(read.statusCode, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.data.receipt, { paper_width: '80mm', show_logo: true, footer_text: '' });
    const g = read.body.data.gym;
    assert.equal(g.name, gym.name);
    assert.equal(g.address, '1 High Street');
    assert.equal(g.phone, '+44 20 7946 0000');
    assert.equal(g.tax_label, 'VAT');
    assert.equal(g.tax_number, 'GB123');
    assert.equal(g.footer_note, 'Thanks for training with us');
    // No logo of its own: none on the receipt, never a placeholder picture.
    assert.equal(g.logo_url, '');

    const saved = await h.call(pos.updateReceiptSettings, as({ body: { paperWidth: '58mm', showLogo: false, footerText: '  No refunds after 7 days  ' } }));
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data.receipt, { paper_width: '58mm', show_logo: false, footer_text: 'No refunds after 7 days' });

    // Only what is sent changes.
    const partial = await h.call(pos.updateReceiptSettings, as({ body: { showLogo: true } }));
    assert.equal(partial.statusCode, 200, JSON.stringify(partial.body));
    assert.deepEqual(partial.body.data.receipt, { paper_width: '58mm', show_logo: true, footer_text: 'No refunds after 7 days' });

    for (const body of [{ paperWidth: '110mm' }, { showLogo: 'yes' }, { footerText: 42 }, { footerText: 'x'.repeat(301) }, {}]) {
      const refused = await h.call(pos.updateReceiptSettings, as({ body }));
      assert.equal(refused.statusCode, 400, JSON.stringify(body));
    }
    const stored = (await Settings.findOne({ isActive: true }).lean()).receipt;
    assert.deepEqual({ paperWidth: stored.paperWidth, showLogo: stored.showLogo, footerText: stored.footerText }, { paperWidth: '58mm', showLogo: true, footerText: 'No refunds after 7 days' });

    // The general settings page's own fields are untouched.
    assert.equal((await Settings.findOne({ isActive: true }).lean()).invoice.footerNote, 'Thanks for training with us');
  });
});

test('over HTTP: a view role on the till reads the receipt settings but cannot change them', async () => {
  await withServer(async (send) => {
    const read = await send(bookkeeper, 'GET', '/admin/pos/receipt-settings');
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.data.receipt.paper_width, '58mm');

    const refused = await send(bookkeeper, 'PUT', '/admin/pos/receipt-settings', { paperWidth: '80mm' });
    assert.equal(refused.status, 403, refused.text);

    const saved = await send(cashier, 'PUT', '/admin/pos/receipt-settings', { paperWidth: '80mm' });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.data.receipt.paper_width, '80mm');

    // The change is in the audit trail (written after the response).
    const AdminAuditLog = h.src('models/adminAuditLogModel');
    let trail = [];
    for (let i = 0; i < 50 && !trail.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      trail = await h.inGym(gym, () => AdminAuditLog.find({ method: 'PUT', path: '/admin/pos/receipt-settings', status: 200 }).lean());
    }
    assert.equal(trail.length, 1);
    assert.equal(trail[0].tab, 'pos');
  });
});

test('mobile wallets are payment methods; anything else is refused and takes nothing', async () => {
  await h.inGym(gym, async () => {
    const gel = await product('Energy gel', 10, 3);
    const pay = (paymentMethod) => h.call(pos.createSale, as({ body: { items: [{ productId: gel.id, quantity: 1 }], paymentMethod } }));
    for (const method of ['jazzcash', 'easypaisa', 'wallet']) {
      const res = await pay(method);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.payment_method, method);
    }
    // Not read as cash, not lower-cased into a match: refused.
    for (const method of ['bitcoin', 'JazzCash', '', undefined]) {
      const res = await pay(method);
      assert.equal(res.statusCode, 400, `${method}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(await stockOf(gel.id), 7, 'a refused sale takes no stock');
    assert.equal(await Sale.countDocuments({ 'items.productId': gel.id }), 3);
  });
});

test('the tax in a sale is the included share of its taxable lines, after the discount, at the Settings rate', async () => {
  await h.inGym(gym, async () => {
    const Settings = h.src('models/settings');
    await Settings.updateOne({ isActive: true }, { $set: { taxRate: 20 } });
    try {
      const listed = await h.call(pos.listProducts, as({ query: {} }));
      assert.equal(listed.body.tax_rate, 20, 'the till is told the rate so the basket can show it');

      const shake = await product('Shake', 10, 6);
      const pass = await h.call(pos.createProduct, as({ body: { name: 'Day pass', price: 4, taxable: false, trackStock: false } }));
      assert.equal(pass.statusCode, 201, JSON.stringify(pass.body));
      const res = await h.call(pos.createSale, as({ body: { items: [{ productId: shake.id, quantity: 2 }, { productId: pass.body.data.id, quantity: 1 }], discount: 2, paymentMethod: 'card' } }));
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      const sale = res.body.data;
      // 16 in the basket, 2 off, 14 to pay. The taxable 12 of the 16 is
      // 10.50 of the 14, which includes 20% tax: 10.50 - 10.50 / 1.2 = 1.75.
      assert.deepEqual([sale.subtotal, sale.discount, sale.total, sale.tax_rate, sale.tax_amount], [16, 2, 14, 20, 1.75]);
      assert.deepEqual(sale.items.map((i) => [i.quantity, i.unit_price, i.total]), [[2, 6, 12], [1, 4, 4]]);
    } finally {
      await Settings.updateOne({ isActive: true }, { $set: { taxRate: 0 } });
    }
  });
});

test('cash received: the change is worked out, too little is refused, and other methods ignore it', async () => {
  await h.inGym(gym, async () => {
    const bottle = await product('Bottle', 10, 7.25);
    const sell1 = (paymentMethod, tendered) => h.call(pos.createSale, as({ body: { items: [{ productId: bottle.id, quantity: 1 }], paymentMethod, tendered } }));

    const short = await sell1('cash', 5);
    assert.equal(short.statusCode, 400, JSON.stringify(short.body));
    assert.equal(await stockOf(bottle.id), 10);
    assert.equal((await sell1('cash', 'lots')).statusCode, 400);

    const paid = await sell1('cash', 10);
    assert.equal(paid.statusCode, 201, JSON.stringify(paid.body));
    assert.deepEqual([paid.body.data.total, paid.body.data.tendered, paid.body.data.change], [7.25, 10, 2.75]);

    const exact = await sell1('cash', undefined);
    assert.deepEqual([exact.body.data.tendered, exact.body.data.change], [null, null]);

    const card = await sell1('card', 50);
    assert.equal(card.statusCode, 201, JSON.stringify(card.body));
    assert.deepEqual([card.body.data.tendered, card.body.data.change], [null, null]);
    assert.equal(await stockOf(bottle.id), 7);
  });
});

// Three sales moved into March 2025, away from every other sale in this
// gym: a taxed card sale with a discount, a cash sale to a member, and a
// sale that was refunded.
let march;

async function marchSales() {
  if (march) return march;
  const Settings = h.src('models/settings');
  const make = async (body) => {
    const res = await h.call(pos.createProduct, as({ body }));
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const tub = await make({ name: 'Protein tub', price: 30, cost: 18, stock: 20 });
  const shaker = await make({ name: 'Shaker', price: 10, cost: 4, stock: 20 });

  await Settings.updateOne({ isActive: true }, { $set: { taxRate: 25 } });
  let big;
  try {
    big = await h.call(pos.createSale, as({ body: { items: [{ productId: tub.id, quantity: 2 }, { productId: shaker.id, quantity: 1 }], discount: 5, paymentMethod: 'card' } }));
  } finally {
    await Settings.updateOne({ isActive: true }, { $set: { taxRate: 0 } });
  }
  const small = await h.call(pos.createSale, as({ body: { items: [{ productId: shaker.id, quantity: 1 }], paymentMethod: 'cash', memberId: String(bookkeeper._id) } }));
  const back = await h.call(pos.createSale, as({ body: { items: [{ productId: shaker.id, quantity: 1 }], paymentMethod: 'cash' } }));
  for (const res of [big, small, back]) assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal((await refund(back.body.data.id)).statusCode, 200);

  const days = [[big, '2025-03-10'], [small, '2025-03-11'], [back, '2025-03-12']];
  for (const [res, day] of days) await Sale.updateOne({ _id: res.body.data.id }, { $set: { paidAt: new Date(`${day}T10:00:00Z`) } });
  march = { big: big.body.data.receipt_number, small: small.body.data.receipt_number, back: back.body.data.receipt_number };
  return march;
}

const MARCH = { from: '2025-03-01', to: '2025-03-31' };
const asViewer = (req) => ({ user: { id: String(bookkeeper._id) }, roleSlug: 'accountant', ...req });

test('sales history: a date range, and cost and profit per line, per sale and for the range', async () => {
  await h.inGym(gym, async () => {
    const r = await marchSales();
    const res = await h.call(pos.listSales, as({ query: MARCH }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.map((s) => s.receipt_number), [r.back, r.small, r.big], 'the range holds these three and nothing else, newest first');
    assert.equal(res.body.range.label, 'Mar 2025');
    assert.equal(res.body.truncated, false);

    const [back, small, big] = res.body.data;
    // 70 in the basket, 5 off: 65 paid, of which 13 is the 25% tax. The
    // goods cost 2 x 18 + 4 = 40, so the sale made 65 - 13 - 40 = 12.
    assert.deepEqual([big.total, big.tax_amount, big.cost, big.profit], [65, 13, 40, 12]);
    assert.deepEqual(big.items.map((i) => [i.name, i.unit_cost, i.cost, i.margin]), [['Protein tub', 18, 36, 24], ['Shaker', 4, 4, 6]]);
    assert.deepEqual([small.total, small.cost, small.profit], [10, 4, 6]);
    assert.equal(back.status, 'refunded');

    // The range's summary counts paid sales only: the refund is out.
    assert.deepEqual(res.body.summary.totals, { GBP: 75 });
    assert.equal(res.body.summary.sales, 2);
    assert.equal(res.body.summary.items, 4);
    assert.deepEqual(res.body.summary.cost, { GBP: 44 });
    assert.deepEqual(res.body.summary.gross_profit, { GBP: 18 });

    const oneDay = await h.call(pos.listSales, as({ query: { from: '2025-03-11', to: '2025-03-11' } }));
    assert.deepEqual(oneDay.body.data.map((s) => s.receipt_number), [r.small]);
    assert.deepEqual(oneDay.body.summary.totals, { GBP: 10 });
  });
});

test('sales history: a view-only role and the member see no cost, margin or profit', async () => {
  await h.inGym(gym, async () => {
    const r = await marchSales();
    const res = await h.call(pos.listSales, asViewer({ query: MARCH }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 3);
    assert.deepEqual(res.body.summary.totals, { GBP: 75 });
    assert.ok(!('cost' in res.body.summary) && !('gross_profit' in res.body.summary));
    for (const sale of res.body.data) {
      assert.ok(!('cost' in sale) && !('profit' in sale), JSON.stringify(sale));
      for (const item of sale.items) assert.ok(!('unit_cost' in item) && !('cost' in item) && !('margin' in item), JSON.stringify(item));
    }

    const mine = await h.call(pos.myPurchases, { user: { id: String(bookkeeper._id) } });
    assert.deepEqual(mine.body.data.map((s) => s.receipt_number), [r.small]);
    assert.ok(!('profit' in mine.body.data[0]) && !('unit_cost' in mine.body.data[0].items[0]));
  });
});

// A CSV line to its fields; enough for these rows, whose quoted fields have
// no line breaks in them.
function csvFields(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

function readCsv(body) {
  const [header, ...rows] = String(body).replace(/^﻿/, '').trim().split('\r\n').map(csvFields);
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i]])));
}

test('sales export: every sale in the range as a CSV, with cost and profit only for manage', async () => {
  await h.inGym(gym, async () => {
    const r = await marchSales();
    const res = await h.call(pos.exportSales, as({ query: MARCH }));
    assert.equal(res.statusCode, 200, String(res.body));
    assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(res.headers['content-disposition'], /filename="sales_2025-03-01_2025-03-31\.csv"/);

    const rows = readCsv(res.body);
    assert.deepEqual(rows.map((row) => row.Receipt), [r.back, r.small, r.big]);
    const big = rows.find((row) => row.Receipt === r.big);
    assert.equal(big.Date, '2025-03-10');
    assert.equal(big.Items, '2 x Protein tub; 1 x Shaker');
    assert.deepEqual([big.Quantity, big.Subtotal, big.Discount, big['Tax included'], big.Total, big.Currency, big.Method], ['3', '70', '5', '13', '65', 'GBP', 'card']);
    assert.deepEqual([big.Cost, big.Profit], ['40', '12']);
    const back = rows.find((row) => row.Receipt === r.back);
    assert.equal(back.Status, 'refunded');
    assert.equal(back['Refund reason'], 'returned');

    const viewer = readCsv((await h.call(pos.exportSales, asViewer({ query: MARCH }))).body);
    assert.equal(viewer.length, 3);
    assert.ok(viewer.every((row) => !('Cost' in row) && !('Profit' in row)));
  });
});

test('over HTTP: the sales list and export take the range, and cost follows the live role', async () => {
  const r = await h.inGym(gym, () => marchSales());
  await withServer(async (send) => {
    const managed = await send(cashier, 'GET', '/admin/pos/sales?from=2025-03-01&to=2025-03-31');
    assert.equal(managed.status, 200, managed.text);
    assert.deepEqual(managed.body.summary.gross_profit, { GBP: 18 });

    const viewed = await send(bookkeeper, 'GET', '/admin/pos/sales?from=2025-03-10&to=2025-03-10');
    assert.equal(viewed.status, 200, viewed.text);
    assert.deepEqual(viewed.body.data.map((s) => s.receipt_number), [r.big]);
    assert.ok(!('profit' in viewed.body.data[0]) && !('gross_profit' in viewed.body.summary));

    const csv = await send(bookkeeper, 'GET', '/admin/pos/sales/export?from=2025-03-01&to=2025-03-31');
    assert.equal(csv.status, 200, csv.text);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    const rows = readCsv(csv.text);
    assert.equal(rows.length, 3);
    assert.ok(!('Profit' in rows[0]));
  });
});

// ---- A sale sent again (request_id) ----------------------------------------
//
// The till sends its own id with each sale attempt and the same id again
// when it retries. The retry is the sale already rung up -- answered with
// `repeated: true` -- and never a second receipt, a second stock take or a
// second movement, even when the copies arrive together.

const sellOnce = (productId, quantity, requestId) =>
  h.call(pos.createSale, as({ body: { items: [{ productId, quantity }], paymentMethod: 'cash', request_id: requestId } }));

test('a sale sent again with its request_id is the sale already made: one receipt, stock taken once', async () => {
  await h.inGym(gym, async () => {
    const shake = await product('Shake', 10, 4);
    const first = await sellOnce(shake.id, 2, 'till-attempt-0001');
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    assert.equal(first.body.repeated, undefined);

    const again = await sellOnce(shake.id, 2, 'till-attempt-0001');
    assert.equal(again.statusCode, 201, JSON.stringify(again.body));
    assert.equal(again.body.repeated, true);
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(again.body.data.receipt_number, first.body.data.receipt_number);
    assert.equal(again.body.message, first.body.message);

    assert.equal(await stockOf(shake.id), 8);
    assert.equal(await Sale.countDocuments({ 'items.productId': shake.id }), 1);
    assert.equal(await StockMovement.countDocuments({ productId: shake.id, reason: 'sale' }), 1);

    // A new attempt is a new sale.
    const next = await sellOnce(shake.id, 1, 'till-attempt-0002');
    assert.equal(next.body.repeated, undefined);
    assert.notEqual(next.body.data.id, first.body.data.id);
    assert.equal(await stockOf(shake.id), 7);
  });
});

test('over HTTP: copies of one sale sent together make one sale, and the stock the others took goes back', async () => {
  const gloves = await h.inGym(gym, () => product('Gloves', 10, 12));
  const results = await withServer((send) =>
    Promise.all(Array.from({ length: 5 }, () => send(cashier, 'POST', '/admin/pos/sales', { items: [{ productId: gloves.id, quantity: 2 }], paymentMethod: 'card', request_id: 'till-race-0001' })))
  );
  for (const r of results) assert.equal(r.status, 201, r.text);
  assert.equal(new Set(results.map((r) => r.body.data.receipt_number)).size, 1, 'every copy is answered with the same receipt');
  assert.equal(results.filter((r) => !r.body.repeated).length, 1);
  await h.inGym(gym, async () => {
    assert.equal(await Sale.countDocuments({ 'items.productId': gloves.id }), 1);
    assert.equal(await stockOf(gloves.id), 8, 'two taken, not ten');
    assert.equal(await StockMovement.countDocuments({ productId: gloves.id, reason: 'sale' }), 1);
  });
});

test('over HTTP: copies of a sale of the last unit are all answered with that sale, not "out of stock"', async () => {
  const mat = await h.inGym(gym, () => product('Yoga mat', 1, 20));
  const results = await withServer((send) =>
    Promise.all(Array.from({ length: 3 }, () => send(cashier, 'POST', '/admin/pos/sales', { items: [{ productId: mat.id, quantity: 1 }], paymentMethod: 'cash', request_id: 'till-race-last-01' })))
  );
  for (const r of results) assert.equal(r.status, 201, r.text);
  assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
  await h.inGym(gym, async () => {
    assert.equal(await Sale.countDocuments({ 'items.productId': mat.id }), 1);
    assert.equal(await stockOf(mat.id), 0);
  });
});

test('a request_id that is not one is refused and nothing is sold', async () => {
  await h.inGym(gym, async () => {
    const bottle = await product('Bottle', 5, 3);
    for (const requestId of ['short', 'has spaces in it', 'x'.repeat(101), 'dots.not.allowed']) {
      const res = await sellOnce(bottle.id, 1, requestId);
      assert.equal(res.statusCode, 400, requestId);
      assert.match(res.body.message, /^request_id must be 8 to 100 letters, digits, hyphens or underscores/);
    }
    assert.equal(await stockOf(bottle.id), 5);
    assert.equal(await Sale.countDocuments({ 'items.productId': bottle.id }), 0);
  });
});
