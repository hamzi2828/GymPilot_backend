// src/accounts/models/expenseModel.js
//
// Money going out. One row per expense, with the date it BELONGS to kept
// separate from the date it was paid: a January electricity bill settled in
// February is January's cost, and a report that files it under February makes
// the two months both wrong.
//
// Categories are a fixed list rather than free text. A gym's costs are the
// same handful every month, and free text turns "Electricity", "electricity"
// and "K-Electric bill" into three categories that no report can add up.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

// The things a gym actually spends money on, in the order they usually matter.
const CATEGORIES = [
  'rent',
  'salaries',
  'utilities',
  'equipment',
  'maintenance',
  'marketing',
  'supplies',
  'insurance',
  'licenses',
  'software',
  'transport',
  'refreshments',
  'tax',
  'other'
];

const CATEGORY_LABELS = {
  rent: 'Rent & premises',
  salaries: 'Salaries & wages',
  utilities: 'Utilities',
  equipment: 'Equipment purchase',
  maintenance: 'Repairs & maintenance',
  marketing: 'Marketing',
  supplies: 'Supplies & consumables',
  insurance: 'Insurance',
  licenses: 'Licences & permits',
  software: 'Software & subscriptions',
  transport: 'Transport & fuel',
  refreshments: 'Refreshments & retail stock',
  tax: 'Tax & duties',
  other: 'Other'
};

const expenseSchema = new mongoose.Schema(
  {
    // Human-readable, sequential per month: EXP-202608-0007.
    reference: { type: String, required: true, unique: true, trim: true, index: true },

    title: { type: String, required: true, trim: true },
    category: { type: String, enum: CATEGORIES, default: 'other', index: true },

    amount: { type: Number, required: true, min: 0 },
    // Stored per row rather than assumed. A gym that buys equipment abroad has
    // costs in two currencies, and a report that silently adds them is worse
    // than one that admits it cannot.
    currency: { type: String, default: 'PKR', uppercase: true, trim: true },

    // The period this cost belongs to -- what the P&L files it under.
    incurredOn: { type: Date, required: true, index: true },
    // When money actually left. Null while unpaid.
    paidOn: { type: Date, default: null },

    status: {
      type: String,
      enum: ['pending', 'paid', 'cancelled'],
      default: 'paid',
      index: true
    },

    paymentMethod: {
      type: String,
      enum: ['cash', 'bank_transfer', 'card', 'cheque', 'online', 'other'],
      default: 'cash'
    },

    vendor: { type: String, default: '', trim: true },
    reference_no: { type: String, default: '', trim: true },   // invoice / receipt number
    notes: { type: String, default: '', trim: true },

    // A recurring cost is flagged rather than duplicated forward: the flag is
    // what lets a report say "this month is missing the rent" without this
    // model having to own a scheduler.
    recurring: {
      isRecurring: { type: Boolean, default: false },
      cycle: { type: String, enum: ['weekly', 'monthly', 'quarterly', 'yearly'], default: 'monthly' }
    },

    // Set when this row is a wage payment, so payroll can be traced back to a
    // person without parsing the title.
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    staffName: { type: String, default: '' },

    // The asset this expense bought or serviced, when there is one.
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application. See the note
    // in src/attendance/models/attendanceModel.js.
    collection: 'gym_expenses'
  }
);

// The two shapes every report asks for: a period, and a period per category.
expenseSchema.index({ incurredOn: -1, status: 1 });
expenseSchema.index({ category: 1, incurredOn: -1 });

expenseSchema.statics.CATEGORIES = CATEGORIES;
expenseSchema.statics.CATEGORY_LABELS = CATEGORY_LABELS;

module.exports = tenantModel('Expense', expenseSchema);
