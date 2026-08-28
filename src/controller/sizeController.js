// src/controller/sizeController.js
const Size = require('../models/size');

const sizeController = {
  // GET /sizes - list all sizes
  listSizes: async (req, res) => {
    try {
      const sizes = await Size.find().sort({ createdAt: -1 });
      return res.status(200).json({ message: 'Sizes fetched successfully', data: sizes });
    } catch (error) {
      console.error('List sizes error:', error);
      return res.status(400).json({ message: 'Error fetching sizes', error: error.message });
    }
  },

  // POST /sizes - create a new size
  createSize: async (req, res) => {
    try {
      let { name, slug, active = true } = req.body || {};

      if (!name || !slug) {
        return res.status(400).json({ message: 'name and slug are required' });
      }

      name = String(name).trim();
      slug = String(slug).trim().toLowerCase();
      active = Boolean(active);

      const created = await Size.create({ name, slug, active });
      return res.status(201).json({ message: 'Size created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Create size error:', error);
      return res.status(400).json({ message: 'Error creating size', error: error.message });
    }
  },

  // PUT /sizes/:id - update a size
  updateSize: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
      if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();
      if (typeof payload.active !== 'undefined') updates.active = Boolean(payload.active);

      const updated = await Size.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ message: 'Size not found' });
      }

      return res.status(200).json({ message: 'Size updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Update size error:', error);
      return res.status(400).json({ message: 'Error updating size', error: error.message });
    }
  },

  // DELETE /sizes/:id - delete a size
  deleteSize: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Size.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Size not found' });
      }
      return res.status(200).json({ message: 'Size deleted successfully', id });
    } catch (error) {
      console.error('Delete size error:', error);
      return res.status(400).json({ message: 'Error deleting size', error: error.message });
    }
  },
};

module.exports = sizeController;
