// src/models/saleModel.js
//
// A till receipt: what was sold, to whom, for how much, paid how. Prices
// and names are snapshotted so a later price change does not rewrite
// yesterday's takings.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');
const { recordCurrencyDefault } = require('../services/currency');

const saleItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true },
    sku: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, default: 0 },
    total: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    receiptNumber: { type: String, required: true, unique: true },
    items: { type: [saleItemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    // Prices are tax-inclusive, like memberships; the tax share is recorded.
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    // No default here: a new row gets the gym's currency (services/currency.js).
    currency: { type: String, default: '', uppercase: true },
    // Mobile wallets beside cash and card: JazzCash, Easypaisa, or another
    // wallet ('wallet'). The same values package orders take. Kept in step
    // with METHODS in controller/posController.js.
    paymentMethod: { type: String, enum: ['cash', 'card', 'bank_transfer', 'jazzcash', 'easypaisa', 'wallet', 'online', 'account', 'other'], default: 'cash' },
    // Cash handed over and the change given back, for a cash sale where the
    // cashier entered it; null otherwise (paid exactly, or not cash).
    tendered: { type: Number, default: null },
    change: { type: Number, default: null },
    status: { type: String, enum: ['paid', 'refunded'], default: 'paid', index: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    memberName: { type: String, default: '' },
    soldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    soldByName: { type: String, default: '' },
    notes: { type: String, default: '', trim: true },
    paidAt: { type: Date, default: Date.now, index: true },
    refundedAt: { type: Date, default: null },
    refundReason: { type: String, default: '' }
  },
  {
    timestamps: true,
    collection: 'gym_sales'
  }
);

saleSchema.plugin(recordCurrencyDefault);

module.exports = tenantModel('Sale', saleSchema);
