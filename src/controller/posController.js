// src/controller/posController.js
//
// The till and the stockroom: products, sales with receipts, refunds, stock
// movements and the lockers. Sales are money in and appear beside
// membership revenue on the accounts overview and the reports.

const mongoose = require('mongoose');
const Product = require('../models/productModel');
const Sale = require('../models/saleModel');
const StockMovement = require('../models/stockMovementModel');
const Locker = require('../models/lockerModel');
const User = require('../models/user');
const Settings = require('../models/settings');
const Counter = require('../gymfolio/models/counterModel');
const L = require('../accounts/services/ledger');
const T = require('../attendance/services/timeUtils');
const { branding } = require('../services/branding');
const { sendCsv } = require('../services/csv');
const { can, ADMIN_SLUG } = require('../services/roleService');

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
// How a sale was paid. The mobile wallets (JazzCash, Easypaisa, any other
// wallet) are the same values package orders take. Anything else is refused,
// never read as cash. Kept in step with the enum in models/saleModel.js.
const METHODS = ['cash', 'card', 'bank_transfer', 'jazzcash', 'easypaisa', 'wallet', 'online', 'account', 'other'];
// Thermal roll widths the receipt is laid out for.
const PAPER_WIDTHS = ['80mm', '58mm'];
const RECEIPT_FOOTER_MAX = 300;
// Rows on the sales list; the summary and the CSV cover the whole range.
const SALES_LIST_LIMIT = 500;
const EXPORT_LIMIT = 20000;

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

async function actorName(req) {
  const me = await User.findById(actorId(req)).select('firstName lastName email').lean();
  return me ? [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email : '';
}

// The currency sales and lockers are written in: the one set in Settings,
// not whatever past takings happened to be recorded in.
async function gymCurrency() {
  try {
    return await L.recordCurrency();
  } catch {
    return 'USD';
  }
}

function productView(p) {
  return {
    id: String(p._id),
    name: p.name,
    sku: p.sku || '',
    category: p.category || 'general',
    price: p.price,
    cost: p.cost || 0,
    currency: p.currency || '',
    track_stock: p.trackStock !== false,
    stock: p.stock || 0,
    low_stock_at: p.lowStockAt || 0,
    low: p.trackStock !== false && (p.stock || 0) <= (p.lowStockAt || 0),
    taxable: p.taxable !== false,
    image_url: p.imageUrl || '',
    is_active: p.isActive !== false,
    order: p.order || 0
  };
}

// What a sale cost the gym and what it made. Each line's margin is its
// price against its cost, as rung up; the sale's profit is what was taken
// less the tax in it (prices include tax, and the tax is not the gym's) and
// less the cost, so a basket discount comes off it too. The cost is the
// product's cost when it was sold (unitCost is snapshotted on the line).
function saleMoney(s) {
  const lines = (s.items || []).map((i) => {
    const cost = round((i.unitCost || 0) * i.quantity);
    return { unit_cost: i.unitCost || 0, cost, margin: round(i.total - cost) };
  });
  const cost = round(lines.reduce((sum, l) => sum + l.cost, 0));
  return { lines, cost, profit: round((s.total || 0) - (s.taxAmount || 0) - cost) };
}

// Cost and profit are for the people who run the till (pos at manage): a
// view-only role reading the sales -- an accountant, a trainer -- sees what
// was sold, not what the gym paid for it.
async function seesCost(req) {
  const slug = req.roleSlug;
  if (!slug) return false;
  return slug === ADMIN_SLUG || can(slug, 'pos', 'manage');
}

function saleView(s, { withCost = false } = {}) {
  const money = withCost ? saleMoney(s) : null;
  const view = {
    id: String(s._id),
    receipt_number: s.receiptNumber,
    items: (s.items || []).map((i, n) => ({
      product_id: i.productId ? String(i.productId) : null,
      name: i.name,
      sku: i.sku || '',
      quantity: i.quantity,
      unit_price: i.unitPrice,
      total: i.total,
      ...(money ? money.lines[n] : {})
    })),
    subtotal: s.subtotal,
    discount: s.discount,
    tax_rate: s.taxRate,
    tax_amount: s.taxAmount,
    total: s.total,
    currency: s.currency,
    payment_method: s.paymentMethod,
    tendered: s.tendered ?? null,
    change: s.change ?? null,
    status: s.status,
    member_id: s.memberId ? String(s.memberId) : null,
    member_name: s.memberName || '',
    sold_by: s.soldByName || '',
    notes: s.notes || '',
    paid_at: s.paidAt,
    refunded_at: s.refundedAt,
    refund_reason: s.refundReason || ''
  };
  if (money) {
    view.cost = money.cost;
    view.profit = money.profit;
  }
  return view;
}

// The sales in a range, as the list and the export read them: ?from=&to=
// (local calendar days, this month so far by default) and ?memberId=.
function salesFilter(query) {
  const range = L.readRange(query);
  const filter = { paidAt: { $gte: range.start, $lt: range.end } };
  // An ObjectId, not the string: aggregate() does not cast like find().
  if (isId(query.memberId)) filter.memberId = new mongoose.Types.ObjectId(String(query.memberId));
  return { range, filter };
}

function lockerView(l) {
  return {
    id: String(l._id),
    number: l.number,
    zone: l.zone || '',
    status: l.status,
    member_id: l.memberId ? String(l.memberId) : null,
    member_name: l.memberName || '',
    assigned_at: l.assignedAt,
    until: l.until || null,
    overdue: !!(l.status === 'assigned' && l.until && l.until < T.dateKey()),
    fee: l.fee || 0,
    currency: l.currency || '',
    notes: l.notes || ''
  };
}

// Everything a printed receipt carries besides the sale itself: the gym's
// own details -- the same name, address, phone and tax number the invoice
// prints -- and how the till prints (settings.receipt).
async function receiptProfile() {
  const [settings, brand] = await Promise.all([Settings.getSettings(), branding()]);
  const receipt = settings.receipt || {};
  const invoice = settings.invoice || {};
  return {
    receipt: {
      paper_width: PAPER_WIDTHS.includes(receipt.paperWidth) ? receipt.paperWidth : '80mm',
      show_logo: receipt.showLogo !== false,
      footer_text: receipt.footerText || ''
    },
    gym: {
      name: brand.siteName,
      logo_url: brand.logoUrl,
      address: brand.contact.address,
      phone: brand.phone,
      email: brand.supportEmail,
      tax_label: invoice.taxLabel || 'Tax',
      tax_number: invoice.taxNumber || '',
      // The invoice's footer, printed when the receipt has none of its own.
      footer_note: invoice.footerNote || ''
    }
  };
}

// Not enough on the shelf for what was asked. Carries a 409 so the handlers
// can answer with it instead of a generic failure.
function shortStock(product, available) {
  const error = new Error(`Only ${available || 0} × ${product.name} in stock`);
  error.status = 409;
  return error;
}

// Takes stock with ONE conditional decrement: it only goes through while at
// least `quantity` is on the shelf, so two tills selling the last unit at the
// same moment cannot both take it. Returns the product as written, or throws
// shortStock. Restocks (positive delta) never fail.
async function changeStock(product, delta) {
  const filter = { _id: product._id };
  if (delta < 0) filter.stock = { $gte: -delta };
  const updated = await Product.findOneAndUpdate(filter, { $inc: { stock: delta } }, { new: true });
  if (!updated) {
    const fresh = await Product.findById(product._id).select('stock').lean();
    throw shortStock(product, fresh ? fresh.stock : 0);
  }
  product.stock = updated.stock;
  return updated;
}

async function moveStock(product, delta, reason, { saleId = null, note = '', by = null, byName = '' } = {}) {
  if (product.trackStock === false) return product;
  const updated = await changeStock(product, delta);
  await StockMovement.create({ productId: product._id, productName: product.name, delta, stockAfter: updated.stock, reason, saleId, note, by, byName });
  return updated;
}

module.exports = {
  // ---- products ---------------------------------------------------------------

  // GET /admin/pos/products?all=1
  listProducts: async (req, res) => {
    try {
      const filter = req.query.all === '1' ? {} : { isActive: true };
      const [rows, settings] = await Promise.all([Product.find(filter).sort({ order: 1, category: 1, name: 1 }).lean(), Settings.getSettings().catch(() => null)]);
      // The tax rate goes with the prices so the till can show the tax in a
      // basket before it is paid for, worked out as createSale works it out.
      const taxRate = Math.max(0, Number((settings && settings.taxRate) || 0));
      return res.json({ success: true, currency: await gymCurrency(), tax_rate: taxRate, data: rows.map(productView), low_stock: rows.filter((p) => p.trackStock !== false && (p.stock || 0) <= (p.lowStockAt || 0) && p.isActive !== false).length });
    } catch (error) {
      console.error('[pos] products failed:', error);
      return fail(res, 500, 'Could not load products');
    }
  },

  // POST /admin/pos/products
  createProduct: async (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.name || '').trim()) return fail(res, 400, 'A name is required');
      if (!(Number(b.price) >= 0)) return fail(res, 400, 'A price is required');
      const product = await Product.create({
        name: String(b.name).trim(),
        sku: String(b.sku || '').trim(),
        category: String(b.category || 'general').trim().toLowerCase() || 'general',
        price: round(b.price),
        cost: round(b.cost),
        currency: String(b.currency || '').toUpperCase().trim(),
        trackStock: b.trackStock !== false && b.trackStock !== 'false',
        stock: Math.max(0, parseInt(b.stock, 10) || 0),
        lowStockAt: Math.max(0, parseInt(b.lowStockAt, 10) || 0),
        taxable: b.taxable !== false && b.taxable !== 'false',
        imageUrl: String(b.imageUrl || '').trim(),
        isActive: b.isActive === undefined ? true : b.isActive === true || b.isActive === 'true',
        order: parseInt(b.order, 10) || 0
      });
      if (product.stock > 0 && product.trackStock) {
        await StockMovement.create({ productId: product._id, productName: product.name, delta: product.stock, stockAfter: product.stock, reason: 'count', note: 'Opening stock', by: actorId(req), byName: await actorName(req) });
      }
      return res.status(201).json({ success: true, data: productView(product) });
    } catch (error) {
      console.error('[pos] create product failed:', error);
      return fail(res, 500, 'Could not create the product');
    }
  },

  // PUT /admin/pos/products/:id
  updateProduct: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Product not found');
      const product = await Product.findById(req.params.id);
      if (!product) return fail(res, 404, 'Product not found');
      const b = req.body || {};
      if (b.name !== undefined) product.name = String(b.name).trim() || product.name;
      if (b.sku !== undefined) product.sku = String(b.sku).trim();
      if (b.category !== undefined) product.category = String(b.category).trim().toLowerCase() || 'general';
      if (b.price !== undefined && Number(b.price) >= 0) product.price = round(b.price);
      if (b.cost !== undefined) product.cost = round(b.cost);
      if (b.currency !== undefined) product.currency = String(b.currency).toUpperCase().trim();
      if (b.trackStock !== undefined) product.trackStock = b.trackStock === true || b.trackStock === 'true';
      if (b.lowStockAt !== undefined) product.lowStockAt = Math.max(0, parseInt(b.lowStockAt, 10) || 0);
      if (b.taxable !== undefined) product.taxable = b.taxable === true || b.taxable === 'true';
      if (b.imageUrl !== undefined) product.imageUrl = String(b.imageUrl).trim();
      if (b.isActive !== undefined) product.isActive = b.isActive === true || b.isActive === 'true';
      if (b.order !== undefined) product.order = parseInt(b.order, 10) || 0;
      await product.save();
      return res.json({ success: true, data: productView(product) });
    } catch (error) {
      console.error('[pos] update product failed:', error);
      return fail(res, 500, 'Could not save the product');
    }
  },

  // POST /admin/pos/products/:id/stock   { delta | set, reason, note }
  adjustStock: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Product not found');
      const product = await Product.findById(req.params.id);
      if (!product) return fail(res, 404, 'Product not found');
      const b = req.body || {};
      const reason = ['restock', 'count', 'waste', 'adjust'].includes(b.reason) ? b.reason : 'adjust';
      const movement = { note: String(b.note || '').trim(), by: actorId(req), byName: await actorName(req) };
      const before = product.stock || 0;

      if (b.set !== undefined && b.set !== null && b.set !== '') {
        // A count: written only if the level is still what the operator was
        // looking at, so a sale rung up meanwhile is not silently undone.
        const target = Math.max(0, parseInt(b.set, 10) || 0);
        const delta = target - before;
        if (!delta) return fail(res, 400, 'Nothing to change');
        const updated = await Product.findOneAndUpdate(
          { _id: product._id, stock: before ? before : { $in: [0, null] } },
          { $set: { stock: target, trackStock: true } },
          { new: true }
        );
        if (!updated) return fail(res, 409, 'The stock level changed while you were editing it. Reload and try again.');
        product.stock = target;
        product.trackStock = true;
        await StockMovement.create({ productId: product._id, productName: product.name, delta, stockAfter: target, reason, saleId: null, ...movement });
        return res.json({ success: true, message: `Stock is now ${product.stock}.`, data: productView(product) });
      }

      const delta = parseInt(b.delta, 10) || 0;
      if (!delta) return fail(res, 400, 'Nothing to change');
      if (before + delta < 0) return fail(res, 400, 'Stock cannot go below zero');
      await Product.updateOne({ _id: product._id }, { $set: { trackStock: true } });
      product.trackStock = true;
      await moveStock(product, delta, reason, movement);
      return res.json({ success: true, message: `Stock is now ${product.stock}.`, data: productView(product) });
    } catch (error) {
      if (error && error.status === 409) return fail(res, 409, error.message);
      console.error('[pos] stock failed:', error);
      return fail(res, 500, 'Could not adjust stock');
    }
  },

  // GET /admin/pos/products/:id/movements
  movements: async (req, res) => {
    try {
      const filter = isId(req.params.id) ? { productId: req.params.id } : {};
      const rows = await StockMovement.find(filter).sort({ createdAt: -1 }).limit(200).lean();
      return res.json({ success: true, data: rows.map((m) => ({ id: String(m._id), product_id: String(m.productId), product_name: m.productName, delta: m.delta, stock_after: m.stockAfter, reason: m.reason, note: m.note || '', by: m.byName || '', at: m.createdAt })) });
    } catch (error) {
      return fail(res, 500, 'Could not load stock movements');
    }
  },

  // DELETE /admin/pos/products/:id
  deleteProduct: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Product not found');
      const sold = await Sale.exists({ 'items.productId': req.params.id });
      if (sold) {
        await Product.updateOne({ _id: req.params.id }, { $set: { isActive: false } });
        return res.json({ success: true, message: 'This product has sales against it, so it was hidden rather than deleted.' });
      }
      await Product.deleteOne({ _id: req.params.id });
      await StockMovement.deleteMany({ productId: req.params.id });
      return res.json({ success: true, message: 'Product deleted.' });
    } catch (error) {
      return fail(res, 500, 'Could not delete the product');
    }
  },

  // ---- sales --------------------------------------------------------------------

  // POST /admin/pos/sales   { items: [{productId, quantity}], discount, paymentMethod, tendered, memberId, notes }
  createSale: async (req, res) => {
    try {
      const b = req.body || {};
      const wanted = Array.isArray(b.items) ? b.items.filter((i) => i && isId(i.productId) && parseInt(i.quantity, 10) > 0) : [];
      if (!wanted.length) return fail(res, 400, 'Add at least one item');
      if (!METHODS.includes(b.paymentMethod)) return fail(res, 400, `paymentMethod must be one of ${METHODS.join(', ')}`);

      const products = await Product.find({ _id: { $in: wanted.map((i) => i.productId) }, isActive: true });
      const byId = new Map(products.map((p) => [String(p._id), p]));
      const settings = await Settings.getSettings().catch(() => null);
      const currency = await gymCurrency();
      const taxRate = Math.max(0, Number((settings && settings.taxRate) || 0));

      const items = [];
      for (const w of wanted) {
        const p = byId.get(String(w.productId));
        if (!p) return fail(res, 404, 'One of the products is no longer for sale');
        const qty = parseInt(w.quantity, 10);
        if (p.trackStock !== false && (p.stock || 0) < qty) return fail(res, 409, `Only ${p.stock || 0} × ${p.name} in stock`);
        const unitPrice = w.unitPrice !== undefined && Number(w.unitPrice) >= 0 ? round(w.unitPrice) : p.price;
        items.push({ productId: p._id, name: p.name, sku: p.sku || '', quantity: qty, unitPrice, unitCost: p.cost || 0, total: round(unitPrice * qty), taxable: p.taxable !== false });
      }

      const subtotal = round(items.reduce((s, i) => s + i.total, 0));
      const discount = Math.min(subtotal, Math.max(0, round(b.discount)));
      const total = round(subtotal - discount);
      const taxableShare = subtotal ? items.filter((i) => i.taxable).reduce((s, i) => s + i.total, 0) / subtotal : 0;
      const taxAmount = taxRate > 0 ? round((total * taxableShare) - (total * taxableShare) / (1 + taxRate / 100)) : 0;

      // Cash handed over, when the cashier typed it in. Never less than the
      // total, and the change is worked out here so the receipt and the till
      // agree. Only cash has change; for any other method it is ignored.
      let tendered = null;
      let change = null;
      if (b.paymentMethod === 'cash' && b.tendered !== undefined && b.tendered !== null && b.tendered !== '') {
        const given = Number(b.tendered);
        if (!Number.isFinite(given) || given < 0) return fail(res, 400, 'Cash received must be an amount');
        if (round(given) < total) return fail(res, 400, `Cash received (${round(given).toFixed(2)}) is less than the total (${total.toFixed(2)})`);
        tendered = round(given);
        change = round(given - total);
      }

      let member = null;
      if (b.memberId) {
        if (!isId(b.memberId)) return fail(res, 400, 'Invalid memberId');
        member = await User.findById(b.memberId).select('firstName lastName email').lean();
      }

      // Stock is taken BEFORE the receipt is written, one conditional
      // decrement per line, so the last unit cannot be sold twice by two
      // tills at once. Anything taken goes back if a later line is short or
      // the receipt itself cannot be saved.
      const taken = [];
      let sale;
      try {
        for (const item of items) {
          const p = byId.get(String(item.productId));
          if (p.trackStock === false) continue;
          await changeStock(p, -item.quantity);
          taken.push({ product: p, quantity: item.quantity });
        }

        const year = new Date().getFullYear();
        const seq = await Counter.next(`receipt-${year}`);
        sale = await Sale.create({
          receiptNumber: `RCP-${year}-${String(seq).padStart(5, '0')}`,
          items: items.map(({ taxable, ...i }) => i),
          subtotal,
          discount,
          taxRate,
          taxAmount,
          total,
          currency,
          paymentMethod: b.paymentMethod,
          tendered,
          change,
          memberId: member ? member._id : null,
          memberName: member ? [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email : '',
          soldBy: actorId(req),
          soldByName: await actorName(req),
          notes: String(b.notes || '').trim().slice(0, 300)
        });
      } catch (error) {
        for (const t of taken) {
          await Product.updateOne({ _id: t.product._id }, { $inc: { stock: t.quantity } }).catch(() => {});
        }
        if (error && error.status === 409) return fail(res, 409, error.message);
        throw error;
      }

      // The movements are written once the receipt exists so each carries
      // its number.
      const byName = sale.soldByName;
      for (const t of taken) {
        await StockMovement.create({ productId: t.product._id, productName: t.product.name, delta: -t.quantity, stockAfter: t.product.stock, reason: 'sale', saleId: sale._id, note: '', by: actorId(req), byName });
      }

      return res.status(201).json({ success: true, message: `Receipt ${sale.receiptNumber} · ${currency} ${total.toFixed(2)}`, data: saleView(sale) });
    } catch (error) {
      console.error('[pos] sale failed:', error);
      return fail(res, 500, 'Could not record the sale');
    }
  },

  // GET /admin/pos/sales?from=&to=&memberId=
  //
  // Cost, margin and profit -- per line, per sale, and the range's cost and
  // gross profit per currency -- only for pos at manage (seesCost).
  listSales: async (req, res) => {
    try {
      const { range, filter } = salesFilter(req.query);
      const withCost = await seesCost(req);
      // The list is capped; the summary is worked out over every sale in the
      // range, so a busy till's totals are not just its latest 500 receipts.
      const [rows, [summary]] = await Promise.all([
        Sale.find(filter).sort({ paidAt: -1 }).limit(SALES_LIST_LIMIT).lean(),
        Sale.aggregate([
          { $match: { ...filter, status: 'paid' } },
          {
            $facet: {
              byCurrency: [{ $group: { _id: '$currency', total: { $sum: '$total' }, tax: { $sum: '$taxAmount' }, n: { $sum: 1 } } }],
              byMethod: [{ $group: { _id: '$paymentMethod', total: { $sum: '$total' } } }],
              items: [{ $unwind: '$items' }, { $group: { _id: null, n: { $sum: '$items.quantity' } } }],
              costs: [{ $unwind: '$items' }, { $group: { _id: '$currency', cost: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitCost', 0] }] } } } }]
            }
          }
        ])
      ]);
      const totals = {};
      const byMethod = {};
      let sales = 0;
      for (const row of summary.byCurrency) {
        totals[row._id] = round(row.total);
        sales += row.n;
      }
      for (const row of summary.byMethod) byMethod[row._id] = round(row.total);
      const items = (summary.items[0] && summary.items[0].n) || 0;
      const summaryOut = { totals, by_method: byMethod, sales, items };
      if (withCost) {
        // Gross profit per currency, never added across currencies: takings
        // less the tax in them, less what the goods cost.
        const costOf = new Map(summary.costs.map((row) => [row._id, row.cost]));
        summaryOut.cost = {};
        summaryOut.gross_profit = {};
        for (const row of summary.byCurrency) {
          summaryOut.cost[row._id] = round(costOf.get(row._id) || 0);
          summaryOut.gross_profit[row._id] = round(row.total - row.tax - (costOf.get(row._id) || 0));
        }
      }
      return res.json({
        success: true,
        range: { from: range.from, to: range.to, label: L.rangeLabel(range.from, range.to) },
        summary: summaryOut,
        // More sales in the range than the list shows; the export has them all.
        truncated: rows.length >= SALES_LIST_LIMIT,
        data: rows.map((s) => saleView(s, { withCost }))
      });
    } catch (error) {
      console.error('[pos] sales failed:', error);
      return fail(res, 500, 'Could not load sales');
    }
  },

  // GET /admin/pos/sales/export?from=&to=&memberId=
  //
  // Every sale in the range as a CSV, refunded ones included and marked, one
  // row per receipt. The cost and profit columns only for pos at manage.
  exportSales: async (req, res) => {
    try {
      const { range, filter } = salesFilter(req.query);
      const withCost = await seesCost(req);
      const rows = await Sale.find(filter).sort({ paidAt: -1 }).limit(EXPORT_LIMIT).lean();
      const columns = [
        { key: 'receiptNumber', label: 'Receipt' },
        { key: 'date', label: 'Date', value: (r) => T.dateKey(r.paidAt) },
        { key: 'time', label: 'Time', value: (r) => T.timeLabel(r.paidAt) },
        { key: 'status', label: 'Status' },
        { key: 'memberName', label: 'Member' },
        { key: 'items', label: 'Items', value: (r) => (r.items || []).map((i) => `${i.quantity} x ${i.name}`).join('; ') },
        { key: 'quantity', label: 'Quantity', value: (r) => (r.items || []).reduce((n, i) => n + (i.quantity || 0), 0) },
        { key: 'subtotal', label: 'Subtotal' },
        { key: 'discount', label: 'Discount' },
        { key: 'taxRate', label: 'Tax rate %' },
        { key: 'taxAmount', label: 'Tax included' },
        { key: 'total', label: 'Total' },
        { key: 'currency', label: 'Currency' },
        { key: 'paymentMethod', label: 'Method' },
        { key: 'tendered', label: 'Cash received', value: (r) => (r.tendered ?? '') },
        { key: 'change', label: 'Change', value: (r) => (r.change ?? '') },
        { key: 'soldByName', label: 'Sold by' },
        { key: 'notes', label: 'Notes' },
        { key: 'refundedAt', label: 'Refunded on', value: (r) => (r.refundedAt ? T.dateKey(r.refundedAt) : '') },
        { key: 'refundReason', label: 'Refund reason' }
      ];
      if (withCost) {
        columns.push(
          { key: 'cost', label: 'Cost', value: (r) => saleMoney(r).cost },
          { key: 'profit', label: 'Profit', value: (r) => saleMoney(r).profit }
        );
      }
      return sendCsv(res, `sales_${range.from}_${range.to}.csv`, columns, rows);
    } catch (error) {
      console.error('[pos] sales export failed:', error);
      return fail(res, 500, 'Could not export the sales');
    }
  },

  // POST /admin/pos/sales/:id/refund   { reason }
  refundSale: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Sale not found');
      // One conditional update from paid to refunded: a double-click sends two
      // refunds, and only the one that makes the change returns the stock.
      const sale = await Sale.findOneAndUpdate(
        { _id: req.params.id, status: 'paid' },
        { $set: { status: 'refunded', refundedAt: new Date(), refundReason: String((req.body || {}).reason || '').trim().slice(0, 300) } },
        { new: true }
      );
      if (!sale) {
        return (await Sale.exists({ _id: req.params.id })) ? fail(res, 409, 'Already refunded') : fail(res, 404, 'Sale not found');
      }
      const byName = await actorName(req);
      for (const item of sale.items) {
        if (!item.productId) continue;
        const p = await Product.findById(item.productId);
        if (p) await moveStock(p, item.quantity, 'refund', { saleId: sale._id, by: actorId(req), byName });
      }
      return res.json({ success: true, message: `${sale.receiptNumber} refunded; stock returned.`, data: saleView(sale) });
    } catch (error) {
      console.error('[pos] refund failed:', error);
      return fail(res, 500, 'Could not refund the sale');
    }
  },

  // GET /user/purchases   (member: my receipts)
  myPurchases: async (req, res) => {
    try {
      const rows = await Sale.find({ memberId: actorId(req) }).sort({ paidAt: -1 }).limit(100).lean();
      // Never with cost: this is the member's own receipts.
      return res.json({ success: true, data: rows.map((s) => saleView(s)) });
    } catch (error) {
      return fail(res, 500, 'Could not load your purchases');
    }
  },

  // ---- receipt -----------------------------------------------------------------

  // GET /admin/pos/receipt-settings
  //
  // Read by anyone who can see the till, since anyone who can see a sale can
  // reprint its receipt.
  receiptSettings: async (req, res) => {
    try {
      return res.json({ success: true, data: await receiptProfile() });
    } catch (error) {
      console.error('[pos] receipt settings failed:', error);
      return fail(res, 500, 'Could not load the receipt settings');
    }
  },

  // PUT /admin/pos/receipt-settings   { paperWidth, showLogo, footerText }
  //
  // Only the fields sent are changed, and a value of the wrong kind is
  // refused rather than guessed at: a printer set to a width it does not
  // have prints nothing useful.
  updateReceiptSettings: async (req, res) => {
    try {
      const b = req.body || {};
      const set = {};
      if (b.paperWidth !== undefined) {
        if (!PAPER_WIDTHS.includes(b.paperWidth)) return fail(res, 400, `paperWidth must be one of ${PAPER_WIDTHS.join(', ')}`);
        set['receipt.paperWidth'] = b.paperWidth;
      }
      if (b.showLogo !== undefined) {
        if (typeof b.showLogo !== 'boolean') return fail(res, 400, 'showLogo must be true or false');
        set['receipt.showLogo'] = b.showLogo;
      }
      if (b.footerText !== undefined) {
        if (typeof b.footerText !== 'string') return fail(res, 400, 'footerText must be text');
        const footerText = b.footerText.trim();
        if (footerText.length > RECEIPT_FOOTER_MAX) return fail(res, 400, `The footer can be up to ${RECEIPT_FOOTER_MAX} characters`);
        set['receipt.footerText'] = footerText;
      }
      if (!Object.keys(set).length) return fail(res, 400, 'Nothing to change');

      // getSettings() creates the gym's settings row if it has none yet.
      const current = await Settings.getSettings();
      await Settings.updateOne({ _id: current._id }, { $set: set });
      return res.json({ success: true, message: 'Receipt settings saved.', data: await receiptProfile() });
    } catch (error) {
      console.error('[pos] receipt settings update failed:', error);
      return fail(res, 500, 'Could not save the receipt settings');
    }
  },

  // ---- lockers -----------------------------------------------------------------

  // GET /admin/lockers
  listLockers: async (req, res) => {
    try {
      const rows = await Locker.find({}).sort({ zone: 1, order: 1, number: 1 }).lean();
      const today = T.dateKey();
      return res.json({
        success: true,
        counts: {
          total: rows.length,
          free: rows.filter((l) => l.status === 'free').length,
          assigned: rows.filter((l) => l.status === 'assigned').length,
          maintenance: rows.filter((l) => l.status === 'maintenance').length,
          overdue: rows.filter((l) => l.status === 'assigned' && l.until && l.until < today).length
        },
        data: rows.map(lockerView)
      });
    } catch (error) {
      return fail(res, 500, 'Could not load lockers');
    }
  },

  // POST /admin/lockers   { number | from,to (range), zone, fee }
  createLockers: async (req, res) => {
    try {
      const b = req.body || {};
      const zone = String(b.zone || '').trim();
      const fee = round(b.fee);
      const currency = await gymCurrency();
      const numbers = [];
      if (b.from !== undefined && b.to !== undefined) {
        const from = parseInt(b.from, 10);
        const to = parseInt(b.to, 10);
        if (!(from >= 0 && to >= from && to - from < 500)) return fail(res, 400, 'Give a sensible range (up to 500 lockers)');
        for (let n = from; n <= to; n++) numbers.push(String(n));
      } else if (String(b.number || '').trim()) numbers.push(String(b.number).trim());
      else return fail(res, 400, 'A locker number or a range is required');
      let created = 0;
      for (const number of numbers) {
        try {
          await Locker.create({ number, zone, fee, currency, order: parseInt(number, 10) || 0 });
          created += 1;
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }
      return res.status(201).json({ success: true, message: `${created} locker(s) added${numbers.length - created ? `, ${numbers.length - created} already existed` : ''}.` });
    } catch (error) {
      console.error('[pos] create lockers failed:', error);
      return fail(res, 500, 'Could not add lockers');
    }
  },

  // PUT /admin/lockers/:id   { status, zone, fee, notes, number }
  updateLocker: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Locker not found');
      const locker = await Locker.findById(req.params.id);
      if (!locker) return fail(res, 404, 'Locker not found');
      const b = req.body || {};
      if (b.number !== undefined) locker.number = String(b.number).trim() || locker.number;
      if (b.zone !== undefined) locker.zone = String(b.zone).trim();
      if (b.fee !== undefined) locker.fee = round(b.fee);
      if (b.notes !== undefined) locker.notes = String(b.notes).trim();
      if (b.status !== undefined && ['free', 'maintenance'].includes(b.status)) {
        if (locker.status === 'assigned' && b.status === 'free') return fail(res, 409, 'Release the locker first');
        locker.status = b.status;
      }
      await locker.save();
      return res.json({ success: true, data: lockerView(locker) });
    } catch (error) {
      if (error && error.code === 11000) return fail(res, 409, 'A locker with that number already exists in that zone');
      return fail(res, 500, 'Could not save the locker');
    }
  },

  // POST /admin/lockers/:id/assign   { memberId, until, fee }
  assignLocker: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Locker not found');
      const { memberId, until, fee } = req.body || {};
      if (!isId(memberId)) return fail(res, 400, 'A valid memberId is required');
      const [locker, member] = await Promise.all([Locker.findById(req.params.id), User.findById(memberId).select('firstName lastName email').lean()]);
      if (!locker) return fail(res, 404, 'Locker not found');
      if (!member) return fail(res, 404, 'Member not found');
      if (locker.status === 'assigned') return fail(res, 409, `Locker ${locker.number} is already assigned to ${locker.memberName}`);
      if (locker.status === 'maintenance') return fail(res, 409, `Locker ${locker.number} is out of order`);
      locker.status = 'assigned';
      locker.memberId = member._id;
      locker.memberName = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;
      locker.assignedAt = new Date();
      locker.until = /^\d{4}-\d{2}-\d{2}$/.test(String(until || '')) ? String(until) : null;
      if (fee !== undefined) locker.fee = round(fee);
      await locker.save();
      return res.json({ success: true, message: `Locker ${locker.number} assigned to ${locker.memberName}.`, data: lockerView(locker) });
    } catch (error) {
      console.error('[pos] assign locker failed:', error);
      return fail(res, 500, 'Could not assign the locker');
    }
  },

  // POST /admin/lockers/:id/release
  releaseLocker: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Locker not found');
      const locker = await Locker.findById(req.params.id);
      if (!locker) return fail(res, 404, 'Locker not found');
      locker.status = 'free';
      locker.memberId = null;
      locker.memberName = '';
      locker.assignedAt = null;
      locker.until = null;
      await locker.save();
      return res.json({ success: true, message: `Locker ${locker.number} is free.`, data: lockerView(locker) });
    } catch (error) {
      return fail(res, 500, 'Could not release the locker');
    }
  },

  // DELETE /admin/lockers/:id
  deleteLocker: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Locker not found');
      const locker = await Locker.findById(req.params.id);
      if (!locker) return fail(res, 404, 'Locker not found');
      if (locker.status === 'assigned') return fail(res, 409, 'Release the locker first');
      await Locker.deleteOne({ _id: locker._id });
      return res.json({ success: true, message: 'Locker removed.' });
    } catch (error) {
      return fail(res, 500, 'Could not remove the locker');
    }
  },

  // GET /user/locker   (member)
  myLocker: async (req, res) => {
    try {
      const rows = await Locker.find({ memberId: actorId(req), status: 'assigned' }).lean();
      return res.json({ success: true, data: rows.map(lockerView) });
    } catch (error) {
      return fail(res, 500, 'Could not load your locker');
    }
  }
};
