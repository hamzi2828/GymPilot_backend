// src/models/customOrder.js

const mongoose = require('mongoose');

// Customer details schema
const customerDetailsSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, required: true, trim: true },
  address: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  country: { type: String, trim: true },
  notes: { type: String, trim: true }
}, { _id: false });

// Measurement entry schema
const measurementEntrySchema = new mongoose.Schema({
  measurementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Measurement' },
  name: { type: String, required: true },
  value: { type: String, required: true },
  unit: { type: String, default: 'inches' }
}, { _id: false });

// Selection schemas for kind, style, fabric, shipping
const kindSelectionSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, ref: 'Kind' },
  name: { type: String }
}, { _id: false });

const styleSelectionSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, ref: 'Style' },
  name: { type: String },
  imageUrl: { type: String },
  maxClothUsage: { type: Number }
}, { _id: false });

const fabricSelectionSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, ref: 'Fabric' },
  name: { type: String },
  imageUrl: { type: String },
  pricePerMeter: { type: Number }
}, { _id: false });

const shippingSelectionSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, ref: 'ShippingOption' },
  name: { type: String },
  price: { type: Number }
}, { _id: false });

const pricingSchema = new mongoose.Schema({
  fabricCost: { type: Number, default: 0 },
  shippingCost: { type: Number, default: 0 },
  total: { type: Number, default: 0 }
}, { _id: false });

const customOrderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      index: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false
    },
    // New selection fields
    kind: kindSelectionSchema,
    style: styleSelectionSchema,
    fabric: fabricSelectionSchema,
    shippingOption: shippingSelectionSchema,
    pricing: pricingSchema,
    // Legacy fields for backwards compatibility
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: false,
      default: null
    },
    categoryName: {
      type: String,
      default: 'Custom Order'
    },
    customerDetails: {
      type: customerDetailsSchema,
      required: true
    },
    measurements: [measurementEntrySchema],
    referenceImages: [{
      type: String // URLs to uploaded images
    }],
    status: {
      type: String,
      enum: ['pending', 'reviewing', 'quoted', 'confirmed', 'in_progress', 'completed', 'cancelled'],
      default: 'pending'
    },
    adminNotes: {
      type: String,
      trim: true
    },
    quotedPrice: {
      type: Number,
      default: null
    },
    estimatedDelivery: {
      type: String,
      trim: true
    },
    respondedAt: {
      type: Date
    },
    completedAt: {
      type: Date
    }
  },
  { timestamps: true }
);

// Generate order number before saving
customOrderSchema.pre('save', async function(next) {
  if (!this.orderNumber) {
    const count = await this.constructor.countDocuments();
    const timestamp = Date.now().toString().slice(-6);
    this.orderNumber = `CUST-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

// Static method to generate order number
customOrderSchema.statics.generateOrderNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString().slice(-6);
  return `CUST-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
};

module.exports = mongoose.models.CustomOrder || mongoose.model('CustomOrder', customOrderSchema);
