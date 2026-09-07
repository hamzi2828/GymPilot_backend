// src/gymfolio/models/counterModel.js
//
// Gap-free sequences per gym -- invoice numbers, mainly. An atomic upsert +
// increment, so two payments landing in the same instant never share one.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 }
  },
  {
    collection: 'gym_counters'
  }
);

counterSchema.statics.next = async function (key) {
  const doc = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

module.exports = tenantModel('Counter', counterSchema);
