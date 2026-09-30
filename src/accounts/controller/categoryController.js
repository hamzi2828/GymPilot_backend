// src/accounts/controller/categoryController.js
//
// "Manage heads" on the Accounts page: the expense and asset heads a gym has,
// and adding, renaming, archiving and restoring its own. The built-in heads
// are listed alongside, read-only. See services/categories.js.

const mongoose = require('mongoose');

const categories = require('../services/categories');

function view(head) {
  return {
    id: head.id || null,
    key: head.key,
    label: head.label,
    built_in: !!head.built_in,
    archived: !!head.archived,
    ...(head.default_life !== undefined ? { default_life: head.default_life } : {})
  };
}

// One of the gym's own heads, as the list shows it.
function docView(doc) {
  return view({
    id: String(doc._id),
    key: doc.key,
    label: doc.label,
    archived: doc.archived,
    default_life: doc.kind === 'asset' ? categories.CUSTOM_ASSET_LIFE_YEARS : undefined
  });
}

function fail(res, error, fallback) {
  if (error instanceof categories.CategoryError) return res.status(error.status).json({ message: error.message });
  console.error(`[accounts] ${fallback}:`, error);
  return res.status(500).json({ message: fallback, error: error.message });
}

module.exports = {
  // GET /api/accounts/categories
  list: async (req, res) => {
    try {
      const [expense, asset] = await Promise.all([categories.headsFor('expense'), categories.headsFor('asset')]);
      return res.json({ success: true, expense: expense.all.map(view), asset: asset.all.map(view) });
    } catch (error) {
      return fail(res, error, 'Could not load the heads');
    }
  },

  // POST /api/accounts/categories   { kind: 'expense' | 'asset', label }
  create: async (req, res) => {
    try {
      const body = req.body || {};
      const doc = await categories.createHead(String(body.kind || ''), body.label, {
        createdBy: req.user && req.user.id,
        createdByName: req.user ? [req.user.firstName, req.user.lastName].filter(Boolean).join(' ').trim() : ''
      });
      return res.status(201).json({
        success: true,
        message: `"${doc.label}" added.`,
        head: docView(doc)
      });
    } catch (error) {
      return fail(res, error, 'Could not add this head');
    }
  },

  // PUT /api/accounts/categories/:id   { label?, archived? }
  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ message: 'Head not found' });
      const body = req.body || {};
      const doc = await categories.updateHead(id, { label: body.label, archived: body.archived });
      return res.json({
        success: true,
        message:
          body.archived === undefined
            ? `Renamed to "${doc.label}".`
            : doc.archived
            ? `"${doc.label}" archived. Rows already filed under it keep it.`
            : `"${doc.label}" restored.`,
        head: docView(doc)
      });
    } catch (error) {
      return fail(res, error, 'Could not update this head');
    }
  }
};
