// src/models/stockMovementModel.js
//
// Every change to a product's stock and why: sold, restocked, counted,
// written off, refunded. The running stock on the product is the sum of
// these; the log is what answers "where did twelve bottles go".

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const stockMovementSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productName: { type: String, default: '' },
    delta: { type: Number, required: true },
    stockAfter: { type: Number, default: 0 },
    reason: { type: String, enum: ['sale', 'refund', 'restock', 'count', 'waste', 'adjust'], required: true },
    saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    note: { type: String, default: '', trim: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' }
  },
  {
    timestamps: true,
    collection: 'gym_stock_movements'
  }
);

stockMovementSchema.index({ createdAt: -1 });

module.exports = tenantModel('StockMovement', stockMovementSchema);
