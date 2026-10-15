// src/models/payslipModel.js
//
// What a staff member is paid for one period: the base (salary pro-rated to
// the period, or hours x rate), PT commission from completed sessions, any
// extra earnings and deductions typed in, and the net. Drafted from the
// staff records and attendance, then edited, issued and marked paid; paying
// files a salary expense so the accounts agree with the payslip.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');
const { recordCurrencyDefault } = require('../services/currency');

const lineSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    amount: { type: Number, required: true }
  },
  { _id: true }
);

const payslipSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    staffName: { type: String, default: '' },
    jobTitle: { type: String, default: '' },
    period: {
      from: { type: String, required: true },
      to: { type: String, required: true },
      label: { type: String, default: '' }
    },
    // No default here: a new row gets the gym's currency (services/currency.js).
    currency: { type: String, default: '', uppercase: true },
    basis: { type: String, enum: ['salaried', 'hourly'], default: 'salaried' },
    // The base pay and what it was worked out from.
    base: { type: Number, default: 0 },
    hours: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    unpaidLeaveDays: { type: Number, default: 0 },
    unpaidLeaveDeduction: { type: Number, default: 0 },
    // PT commission over the period, from completed sessions.
    ptSessions: { type: Number, default: 0 },
    ptCommission: { type: Number, default: 0 },
    earnings: { type: [lineSchema], default: [] },
    deductions: { type: [lineSchema], default: [] },
    gross: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    status: { type: String, enum: ['draft', 'issued', 'paid', 'void'], default: 'draft', index: true },
    issuedAt: { type: Date, default: null },
    paidOn: { type: Date, default: null },
    paymentMethod: { type: String, default: 'bank_transfer' },
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    // The salary expense filed when it was paid.
    expenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // True for every payslip that is not void; kept in step with status on
    // save. It exists for the unique index below.
    live: { type: Boolean, default: true }
  },
  {
    timestamps: true,
    collection: 'gym_payslips'
  }
);

payslipSchema.pre('save', function () {
  this.live = this.status !== 'void';
});

// Status changes made as conditional updates skip save(), so they keep the
// flag in step here.
payslipSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  const update = this.getUpdate() || {};
  const status = update.$set && update.$set.status !== undefined ? update.$set.status : update.status;
  if (status !== undefined) this.set('live', status !== 'void');
});

// One live payslip per person per period.
//
// Partial on `live: true` rather than on `status: { $ne: 'void' }`: MongoDB
// does not accept $ne in a partial index, so that index was never built and
// pressing "Generate" twice could draft the same payslip twice. Equality on a
// boolean is supported by every version.
payslipSchema.index({ staffId: 1, 'period.from': 1, 'period.to': 1 }, { unique: true, partialFilterExpression: { live: true } });

/** Gross and net from the parts. */
payslipSchema.methods.recalculate = function () {
  const sum = (lines) => (lines || []).reduce((total, l) => total + (Number(l.amount) || 0), 0);
  const round = (n) => Math.round(n * 100) / 100;
  this.gross = round((Number(this.base) || 0) + (Number(this.ptCommission) || 0) + sum(this.earnings));
  this.net = round(this.gross - (Number(this.unpaidLeaveDeduction) || 0) - sum(this.deductions));
  return this;
};

payslipSchema.plugin(recordCurrencyDefault);

module.exports = tenantModel('Payslip', payslipSchema);
