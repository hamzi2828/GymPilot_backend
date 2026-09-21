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

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const METHODS = ['cash', 'card', 'bank_transfer', 'online', 'account', 'other'];

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

function saleView(s) {
  return {
    id: String(s._id),
    receipt_number: s.receiptNumber,
    items: (s.items || []).map((i) => ({ product_id: i.productId ? String(i.productId) : null, name: i.name, sku: i.sku || '', quantity: i.quantity, unit_price: i.unitPrice, total: i.total })),
    subtotal: s.subtotal,
    discount: s.discount,
    tax_rate: s.taxRate,
    tax_amount: s.taxAmount,
    total: s.total,
    currency: s.currency,
    payment_method: s.paymentMethod,
    status: s.status,
    member_id: s.memberId ? String(s.memberId) : null,
    member_name: s.memberName || '',
    sold_by: s.soldByName || '',
    notes: s.notes || '',
    paid_at: s.paidAt,
    refunded_at: s.refundedAt,
    refund_reason: s.refundReason || ''
  };
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
      const rows = await Product.find(filter).sort({ order: 1, category: 1, name: 1 }).lean();
      return res.json({ success: true, currency: await gymCurrency(), data: rows.map(productView), low_stock: rows.filter((p) => p.trackStock !== false && (p.stock || 0) <= (p.lowStockAt || 0) && p.isActive !== false).length });
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

  // POST /admin/pos/sales   { items: [{productId, quantity}], discount, paymentMethod, memberId, notes }
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
  listSales: async (req, res) => {
    try {
      const range = L.readRange(req.query);
      const filter = { paidAt: { $gte: range.start, $lt: range.end } };
      if (isId(req.query.memberId)) filter.memberId = req.query.memberId;
      const rows = await Sale.find(filter).sort({ paidAt: -1 }).limit(500).lean();
      const totals = {};
      const byMethod = {};
      let items = 0;
      for (const s of rows) {
        if (s.status !== 'paid') continue;
        totals[s.currency] = round((totals[s.currency] || 0) + s.total);
        byMethod[s.paymentMethod] = round((byMethod[s.paymentMethod] || 0) + s.total);
        items += (s.items || []).reduce((n, i) => n + i.quantity, 0);
      }
      return res.json({ success: true, range: { from: range.from, to: range.to, label: L.rangeLabel(range.from, range.to) }, summary: { totals, by_method: byMethod, sales: rows.filter((s) => s.status === 'paid').length, items }, data: rows.map(saleView) });
    } catch (error) {
      console.error('[pos] sales failed:', error);
      return fail(res, 500, 'Could not load sales');
    }
  },

  // POST /admin/pos/sales/:id/refund   { reason }
  refundSale: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Sale not found');
      const sale = await Sale.findById(req.params.id);
      if (!sale) return fail(res, 404, 'Sale not found');
      if (sale.status === 'refunded') return fail(res, 409, 'Already refunded');
      sale.status = 'refunded';
      sale.refundedAt = new Date();
      sale.refundReason = String((req.body || {}).reason || '').trim().slice(0, 300);
      await sale.save();
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
      return res.json({ success: true, data: rows.map(saleView) });
    } catch (error) {
      return fail(res, 500, 'Could not load your purchases');
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
