// src/accounts/models/categoryModel.js
//
// A gym's own expense and asset heads -- "Tea", "Electricity bill",
// "Boxing kit" -- beside the built-in lists on the expense and asset models.
//
// Kept in a collection of their own rather than on the settings document: a
// head is referred to by its key from every expense or asset filed under it,
// so it needs an identity that outlives a rename, and an archived head must
// still be there to label the old rows that used it.
//
// The key is fixed when the head is created and never changes; renaming
// edits the label only, so a year of rows filed under "Tea" read as
// "Tea & snacks" the moment it is renamed. Heads are archived, not deleted:
// an archived head is no longer offered for new rows, and old rows keep it.

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

const KINDS = ['expense', 'asset'];

const categorySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: KINDS, required: true, index: true },
    // 'c_tea'. The prefix keeps a gym's own keys clear of every built-in one,
    // present and future.
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    archived: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' }
  },
  {
    timestamps: true,
    // Prefixed like the other accounts collections.
    collection: 'gym_accounts_categories'
  }
);

categorySchema.index({ kind: 1, key: 1 }, { unique: true });

categorySchema.statics.KINDS = KINDS;

module.exports = tenantModel('AccountsCategory', categorySchema);
