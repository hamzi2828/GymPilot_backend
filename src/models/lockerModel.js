// src/models/lockerModel.js
//
// The lockers on the wall: which member has which one, until when, and
// which are out of order.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');
const { catalogueCurrency } = require('../services/currency');

const lockerSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, trim: true },
    zone: { type: String, default: '', trim: true, index: true },
    status: { type: String, enum: ['free', 'assigned', 'maintenance'], default: 'free', index: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    memberName: { type: String, default: '' },
    assignedAt: { type: Date, default: null },
    // Local calendar date the rental runs to; null = open-ended.
    until: { type: String, default: null },
    fee: { type: Number, default: 0 },
    // The gym's currency, whatever was sent (services/currency.js).
    currency: { type: String, default: '', uppercase: true },
    notes: { type: String, default: '', trim: true },
    order: { type: Number, default: 0 }
  },
  {
    timestamps: true,
    collection: 'gym_lockers'
  }
);

lockerSchema.index({ zone: 1, number: 1 }, { unique: true });
lockerSchema.plugin(catalogueCurrency);

module.exports = tenantModel('Locker', lockerSchema);
