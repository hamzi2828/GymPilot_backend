const Kind = require('../models/kind');

// Helper to generate slug from name
const generateSlug = (name) => {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const kindController = {
  // GET - list all kinds
  listKinds: async (req, res) => {
    try {
      const kinds = await Kind.find().sort({ createdAt: -1 });
      return res.status(200).json({ message: 'Kinds fetched successfully', data: kinds });
    } catch (error) {
      console.error('List kinds error:', error);
      return res.status(400).json({ message: 'Error fetching kinds', error: error.message });
    }
  },

  // GET - get single kind by ID
  getKind: async (req, res) => {
    try {
      const { id } = req.params;
      const kind = await Kind.findById(id);
      if (!kind) {
        return res.status(404).json({ message: 'Kind not found' });
      }
      return res.status(200).json({ message: 'Kind fetched successfully', data: kind });
    } catch (error) {
      console.error('Get kind error:', error);
      return res.status(400).json({ message: 'Error fetching kind', error: error.message });
    }
  },

  // POST - create a new kind
  createKind: async (req, res) => {
    try {
      let { name, slug, active = true } = req.body || {};

      if (!name) {
        return res.status(400).json({ message: 'Name is required' });
      }

      name = String(name).trim();
      slug = slug ? String(slug).trim().toLowerCase() : generateSlug(name);
      active = Boolean(active);

      const created = await Kind.create({ name, slug, active });
      return res.status(201).json({ message: 'Kind created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Kind with this name already exists' });
      }
      console.error('Create kind error:', error);
      return res.status(400).json({ message: 'Error creating kind', error: error.message });
    }
  },

  // PUT - update a kind
  updateKind: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.name !== 'undefined') {
        updates.name = String(payload.name).trim();
        if (!payload.slug) {
          updates.slug = generateSlug(payload.name);
        }
      }
      if (typeof payload.slug !== 'undefined') {
        updates.slug = String(payload.slug).trim().toLowerCase();
      }
      if (typeof payload.active !== 'undefined') {
        updates.active = Boolean(payload.active);
      }

      const updated = await Kind.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ message: 'Kind not found' });
      }

      return res.status(200).json({ message: 'Kind updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Kind with this name already exists' });
      }
      console.error('Update kind error:', error);
      return res.status(400).json({ message: 'Error updating kind', error: error.message });
    }
  },

  // DELETE - delete a kind
  deleteKind: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Kind.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Kind not found' });
      }
      return res.status(200).json({ message: 'Kind deleted successfully', id });
    } catch (error) {
      console.error('Delete kind error:', error);
      return res.status(400).json({ message: 'Error deleting kind', error: error.message });
    }
  },

  // GET - list active kinds (public)
  listActiveKinds: async (req, res) => {
    try {
      const kinds = await Kind.find({ active: true }).sort({ name: 1 });
      return res.status(200).json({ message: 'Kinds fetched successfully', data: kinds });
    } catch (error) {
      console.error('List active kinds error:', error);
      return res.status(400).json({ message: 'Error fetching kinds', error: error.message });
    }
  },
};

module.exports = kindController;
