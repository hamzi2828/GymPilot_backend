// src/models/shipping.js

const mongoose = require('mongoose');

// Shipping zone schema for city/region-based shipping
const shippingZoneSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  cities: [{ type: String, trim: true }], // City names that belong to this zone
  rate: { type: Number, required: true, min: 0, default: 0 },
  estimatedDays: { type: String, trim: true, default: '3-5 days' },
  isActive: { type: Boolean, default: true }
}, { _id: true, timestamps: true });

const shippingSchema = new mongoose.Schema(
  {
    // Default shipping settings
    defaultShippingCost: { type: Number, default: 0, min: 0 },
    freeShippingThreshold: { type: Number, default: 0, min: 0 }, // 0 means no free shipping
    freeShippingEnabled: { type: Boolean, default: false },

    // Shipping zones for different regions/cities
    zones: [shippingZoneSchema],

    // Category-based shipping override (references category shippingCost)
    useCategoryShipping: { type: Boolean, default: true },

    // Estimated delivery text
    defaultEstimatedDays: { type: String, trim: true, default: '3-5 business days' },

    // Active flag
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true, collection: 'shipping' }
);

// Static method to get shipping settings (singleton pattern)
shippingSchema.statics.getSettings = async function() {
  let settings = await this.findOne({ isActive: true });

  if (!settings) {
    // Create default settings if none exist
    settings = await this.create({
      defaultShippingCost: 0,
      freeShippingThreshold: 0,
      freeShippingEnabled: false,
      zones: [],
      useCategoryShipping: true,
      defaultEstimatedDays: '3-5 business days',
      isActive: true
    });
  }

  return settings;
};

// Static method to update shipping settings
shippingSchema.statics.updateSettings = async function(updateData) {
  let settings = await this.findOne({ isActive: true });

  if (!settings) {
    settings = new this(updateData);
  } else {
    Object.keys(updateData).forEach(key => {
      if (updateData[key] !== undefined) {
        settings[key] = updateData[key];
      }
    });
  }

  await settings.save();
  return settings;
};

module.exports = mongoose.model('Shipping', shippingSchema);
