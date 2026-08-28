// src/controller/colorController.js
const Color = require('../models/color');

const colorController = {
  // GET /colors - list all colors
  listColors: async (req, res) => {
    try {
      const colors = await Color.find().sort({ createdAt: -1 });
      return res.status(200).json({ message: 'Colors fetched successfully', data: colors });
    } catch (error) {
      console.error('List colors error:', error);
      return res.status(400).json({ message: 'Error fetching colors', error: error.message });
    }
  },

  // POST /colors - create a new color
  createColor: async (req, res) => {
    try {
      let { name, slug, hex = '', active = true } = req.body || {};

      if (!name || !slug) {
        return res.status(400).json({ message: 'name and slug are required' });
      }

      name = String(name).trim();
      slug = String(slug).trim().toLowerCase();
      hex = String(hex || '').trim();
      active = Boolean(active);

      const created = await Color.create({ name, slug, hex, active });
      return res.status(201).json({ message: 'Color created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Create color error:', error);
      return res.status(400).json({ message: 'Error creating color', error: error.message });
    }
  },

  // PUT /colors/:id - update a color
  updateColor: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
      if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();
      if (typeof payload.hex !== 'undefined') updates.hex = String(payload.hex || '').trim();
      if (typeof payload.active !== 'undefined') updates.active = Boolean(payload.active);

      const updated = await Color.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ message: 'Color not found' });
      }

      return res.status(200).json({ message: 'Color updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Update color error:', error);
      return res.status(400).json({ message: 'Error updating color', error: error.message });
    }
  },

  // DELETE /colors/:id - delete a color
  deleteColor: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Color.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Color not found' });
      }
      return res.status(200).json({ message: 'Color deleted successfully', id });
    } catch (error) {
      console.error('Delete color error:', error);
      return res.status(400).json({ message: 'Error deleting color', error: error.message });
    }
  },
};

module.exports = colorController;
