// src/accounts/models/assetModel.js
//
// The equipment register. A gym's assets are not a line in a spreadsheet --
// they are the treadmills the members are standing on, so this tracks two
// things a plain fixed-asset list would not:
//
//   * SERVICE dates. A cable machine that has missed its service is a safety
//     problem before it is an accounting one, so `nextServiceDue` is a first
//     class field and the register can be filtered by it.
//
//   * CONDITION separately from status. "Working but worn out" is the state
//     that drives next year's replacement budget, and it is invisible if the
//     only flag is active/retired.
//
// Book value is computed, never stored: storing it would mean every asset
// needs a nightly job to stay honest, and straight-line depreciation is two
// subtractions.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const CATEGORIES = [
  'cardio',
  'strength',
  'free_weights',
  'functional',
  'studio',
  'facility',
  'technology',
  'furniture',
  'vehicle',
  'other'
];

const CATEGORY_LABELS = {
  cardio: 'Cardio machines',
  strength: 'Strength machines',
  free_weights: 'Free weights',
  functional: 'Functional training',
  studio: 'Studio & classes',
  facility: 'Facility & fit-out',
  technology: 'Technology & IT',
  furniture: 'Furniture & fixtures',
  vehicle: 'Vehicles',
  other: 'Other'
};

// How long each kind of thing is worth writing down over, in years. These are
// defaults an accountant can override per asset, not rules -- but a treadmill
// and a reception desk do not wear out at the same rate, and defaulting them
// both to five years would make the register useless out of the box.
const DEFAULT_LIFE_YEARS = {
  cardio: 7,
  strength: 10,
  free_weights: 15,
  functional: 8,
  studio: 8,
  facility: 15,
  technology: 4,
  furniture: 10,
  vehicle: 8,
  other: 5
};

const assetSchema = new mongoose.Schema(
  {
    // Printed on the sticker that goes on the machine: AST-0042.
    tag: { type: String, required: true, unique: true, trim: true, index: true },

    name: { type: String, required: true, trim: true },
    // A built-in key below or one of the gym's own heads (categoryModel.js,
    // services/categories.js).
    category: { type: String, default: 'other', trim: true, index: true },

    quantity: { type: Number, default: 1, min: 1 },
    // Cost of ONE unit. Total is quantity x this, computed where it is shown,
    // so editing the count of a rack of dumbbells does not require restating
    // what one pair cost.
    unitCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'PKR', uppercase: true, trim: true },

    purchasedOn: { type: Date, default: null, index: true },
    supplier: { type: String, default: '', trim: true },
    invoiceNo: { type: String, default: '', trim: true },
    serialNumber: { type: String, default: '', trim: true },
    warrantyUntil: { type: Date, default: null },

    location: { type: String, default: '', trim: true },   // 'Main floor', 'Studio 2'

    condition: {
      type: String,
      enum: ['new', 'good', 'fair', 'poor', 'unusable'],
      default: 'good',
      index: true
    },

    status: {
      type: String,
      enum: ['active', 'maintenance', 'retired', 'sold', 'lost'],
      default: 'active',
      index: true
    },

    // Straight-line depreciation inputs.
    usefulLifeYears: { type: Number, default: 0, min: 0 },
    salvageValue: { type: Number, default: 0, min: 0 },

    lastServicedOn: { type: Date, default: null },
    nextServiceDue: { type: Date, default: null, index: true },
    serviceIntervalDays: { type: Number, default: 0, min: 0 },

    disposedOn: { type: Date, default: null },
    disposalAmount: { type: Number, default: 0, min: 0 },

    notes: { type: String, default: '', trim: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application.
    collection: 'gym_assets'
  }
);

assetSchema.index({ status: 1, category: 1 });

assetSchema.statics.CATEGORIES = CATEGORIES;
assetSchema.statics.CATEGORY_LABELS = CATEGORY_LABELS;
assetSchema.statics.DEFAULT_LIFE_YEARS = DEFAULT_LIFE_YEARS;

module.exports = tenantModel('Asset', assetSchema);
