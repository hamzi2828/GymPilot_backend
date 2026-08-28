const ShippingOption = require('../models/shippingOption');

// Helper to generate slug from name
const generateSlug = (name) => {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const shippingOptionController = {
  // GET - list all shipping options
  listShippingOptions: async (req, res) => {
    try {
      const options = await ShippingOption.find().sort({ createdAt: -1 });
      return res.status(200).json({ message: 'Shipping options fetched successfully', data: options });
    } catch (error) {
      console.error('List shipping options error:', error);
      return res.status(400).json({ message: 'Error fetching shipping options', error: error.message });
    }
  },

  // GET - get single shipping option by ID
  getShippingOption: async (req, res) => {
    try {
      const { id } = req.params;
      const option = await ShippingOption.findById(id);
      if (!option) {
        return res.status(404).json({ message: 'Shipping option not found' });
      }
      return res.status(200).json({ message: 'Shipping option fetched successfully', data: option });
    } catch (error) {
      console.error('Get shipping option error:', error);
      return res.status(400).json({ message: 'Error fetching shipping option', error: error.message });
    }
  },

  // POST - create a new shipping option
  createShippingOption: async (req, res) => {
    try {
      let { name, slug, price = 0, active = true } = req.body || {};

      if (!name) {
        return res.status(400).json({ message: 'Name is required' });
      }

      name = String(name).trim();
      slug = slug ? String(slug).trim().toLowerCase() : generateSlug(name);
      price = parseFloat(price) || 0;
      active = Boolean(active);

      const created = await ShippingOption.create({ name, slug, price, active });
      return res.status(201).json({ message: 'Shipping option created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Shipping option with this name already exists' });
      }
      console.error('Create shipping option error:', error);
      return res.status(400).json({ message: 'Error creating shipping option', error: error.message });
    }
  },

  // PUT - update a shipping option
  updateShippingOption: async (req, res) => {
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
      if (typeof payload.price !== 'undefined') {
        updates.price = parseFloat(payload.price) || 0;
      }
      if (typeof payload.active !== 'undefined') {
        updates.active = Boolean(payload.active);
      }

      const updated = await ShippingOption.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ message: 'Shipping option not found' });
      }

      return res.status(200).json({ message: 'Shipping option updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Shipping option with this name already exists' });
      }
      console.error('Update shipping option error:', error);
      return res.status(400).json({ message: 'Error updating shipping option', error: error.message });
    }
  },

  // DELETE - delete a shipping option
  deleteShippingOption: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await ShippingOption.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Shipping option not found' });
      }
      return res.status(200).json({ message: 'Shipping option deleted successfully', id });
    } catch (error) {
      console.error('Delete shipping option error:', error);
      return res.status(400).json({ message: 'Error deleting shipping option', error: error.message });
    }
  },

  // GET - list active shipping options (public)
  listActiveShippingOptions: async (req, res) => {
    try {
      const options = await ShippingOption.find({ active: true }).sort({ price: 1 });
      return res.status(200).json({ message: 'Shipping options fetched successfully', data: options });
    } catch (error) {
      console.error('List active shipping options error:', error);
      return res.status(400).json({ message: 'Error fetching shipping options', error: error.message });
    }
  },
};

module.exports = shippingOptionController;
