// src/models/productModel.js
//
// Something sold over the counter: a drink, a towel, a protein bar, a day
// pass. Stock is tracked when the gym wants it to be; a service like a
// locker key deposit has no stock to count.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');
const { catalogueCurrency } = require('../services/currency');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true, index: true },
    category: { type: String, default: 'general', trim: true, index: true },
    price: { type: Number, required: true, min: 0 },
    // What it cost the gym, for the margin on the sales report.
    cost: { type: Number, default: 0, min: 0 },
    // The gym's currency, whatever was sent (services/currency.js).
    currency: { type: String, default: '', uppercase: true, trim: true },
    trackStock: { type: Boolean, default: true },
    stock: { type: Number, default: 0 },
    lowStockAt: { type: Number, default: 5, min: 0 },
    taxable: { type: Boolean, default: true },
    imageUrl: { type: String, default: '' },
    isActive: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 }
  },
  {
    timestamps: true,
    collection: 'gym_products'
  }
);

productSchema.index({ name: 1 });
productSchema.plugin(catalogueCurrency);

module.exports = tenantModel('Product', productSchema);
