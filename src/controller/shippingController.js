// src/controller/shippingController.js

const Shipping = require('../models/shipping');

const shippingController = {
  // GET /shipping - Get shipping settings
  getSettings: async (req, res) => {
    try {
      const settings = await Shipping.getSettings();
      return res.status(200).json({ message: 'Shipping settings fetched successfully', data: settings });
    } catch (error) {
      console.error('Get shipping settings error:', error);
      return res.status(400).json({ message: 'Error fetching shipping settings', error: error.message });
    }
  },

  // GET /shipping/public - Get public shipping settings (for checkout)
  getPublicSettings: async (req, res) => {
    try {
      const settings = await Shipping.getSettings();
      // Return only public-facing settings
      return res.status(200).json({
        message: 'Shipping settings fetched successfully',
        data: {
          defaultShippingCost: settings.defaultShippingCost,
          freeShippingThreshold: settings.freeShippingThreshold,
          freeShippingEnabled: settings.freeShippingEnabled,
          zones: settings.zones.filter(z => z.isActive),
          useCategoryShipping: settings.useCategoryShipping,
          defaultEstimatedDays: settings.defaultEstimatedDays
        }
      });
    } catch (error) {
      console.error('Get public shipping settings error:', error);
      return res.status(400).json({ message: 'Error fetching shipping settings', error: error.message });
    }
  },

  // PUT /shipping - Update shipping settings
  updateSettings: async (req, res) => {
    try {
      const {
        defaultShippingCost,
        freeShippingThreshold,
        freeShippingEnabled,
        useCategoryShipping,
        defaultEstimatedDays
      } = req.body;

      const updates = {};

      if (typeof defaultShippingCost !== 'undefined') {
        updates.defaultShippingCost = parseFloat(defaultShippingCost) || 0;
      }
      if (typeof freeShippingThreshold !== 'undefined') {
        updates.freeShippingThreshold = parseFloat(freeShippingThreshold) || 0;
      }
      if (typeof freeShippingEnabled !== 'undefined') {
        updates.freeShippingEnabled = freeShippingEnabled === true || freeShippingEnabled === 'true';
      }
      if (typeof useCategoryShipping !== 'undefined') {
        updates.useCategoryShipping = useCategoryShipping === true || useCategoryShipping === 'true';
      }
      if (typeof defaultEstimatedDays !== 'undefined') {
        updates.defaultEstimatedDays = String(defaultEstimatedDays).trim();
      }

      const settings = await Shipping.updateSettings(updates);
      return res.status(200).json({ message: 'Shipping settings updated successfully', data: settings });
    } catch (error) {
      console.error('Update shipping settings error:', error);
      return res.status(400).json({ message: 'Error updating shipping settings', error: error.message });
    }
  },

  // POST /shipping/zones - Add a new shipping zone
  addZone: async (req, res) => {
    try {
      const { name, cities, rate, estimatedDays, isActive } = req.body;

      if (!name) {
        return res.status(400).json({ message: 'Zone name is required' });
      }

      const settings = await Shipping.getSettings();

      const newZone = {
        name: String(name).trim(),
        cities: Array.isArray(cities) ? cities.map(c => String(c).trim()) : [],
        rate: parseFloat(rate) || 0,
        estimatedDays: String(estimatedDays || '3-5 days').trim(),
        isActive: isActive !== false && isActive !== 'false'
      };

      settings.zones.push(newZone);
      await settings.save();

      return res.status(201).json({ message: 'Shipping zone added successfully', data: settings });
    } catch (error) {
      console.error('Add shipping zone error:', error);
      return res.status(400).json({ message: 'Error adding shipping zone', error: error.message });
    }
  },

  // PUT /shipping/zones/:zoneId - Update a shipping zone
  updateZone: async (req, res) => {
    try {
      const { zoneId } = req.params;
      const { name, cities, rate, estimatedDays, isActive } = req.body;

      const settings = await Shipping.getSettings();
      const zone = settings.zones.id(zoneId);

      if (!zone) {
        return res.status(404).json({ message: 'Shipping zone not found' });
      }

      if (typeof name !== 'undefined') zone.name = String(name).trim();
      if (typeof cities !== 'undefined') {
        zone.cities = Array.isArray(cities) ? cities.map(c => String(c).trim()) : [];
      }
      if (typeof rate !== 'undefined') zone.rate = parseFloat(rate) || 0;
      if (typeof estimatedDays !== 'undefined') zone.estimatedDays = String(estimatedDays).trim();
      if (typeof isActive !== 'undefined') zone.isActive = isActive === true || isActive === 'true';

      await settings.save();

      return res.status(200).json({ message: 'Shipping zone updated successfully', data: settings });
    } catch (error) {
      console.error('Update shipping zone error:', error);
      return res.status(400).json({ message: 'Error updating shipping zone', error: error.message });
    }
  },

  // DELETE /shipping/zones/:zoneId - Delete a shipping zone
  deleteZone: async (req, res) => {
    try {
      const { zoneId } = req.params;

      const settings = await Shipping.getSettings();
      const zone = settings.zones.id(zoneId);

      if (!zone) {
        return res.status(404).json({ message: 'Shipping zone not found' });
      }

      zone.deleteOne();
      await settings.save();

      return res.status(200).json({ message: 'Shipping zone deleted successfully', data: settings });
    } catch (error) {
      console.error('Delete shipping zone error:', error);
      return res.status(400).json({ message: 'Error deleting shipping zone', error: error.message });
    }
  },

  // POST /shipping/calculate - Calculate shipping for an order
  calculateShipping: async (req, res) => {
    try {
      const { city, cartTotal, categoryShippingCosts } = req.body;

      const settings = await Shipping.getSettings();

      // Check for free shipping
      if (settings.freeShippingEnabled && cartTotal >= settings.freeShippingThreshold) {
        return res.status(200).json({
          message: 'Free shipping applied',
          data: {
            shippingCost: 0,
            isFreeShipping: true,
            estimatedDays: settings.defaultEstimatedDays
          }
        });
      }

      let shippingCost = settings.defaultShippingCost;
      let estimatedDays = settings.defaultEstimatedDays;

      // Check for zone-based shipping
      if (city) {
        const matchingZone = settings.zones.find(z =>
          z.isActive && z.cities.some(c => c.toLowerCase() === city.toLowerCase())
        );
        if (matchingZone) {
          shippingCost = matchingZone.rate;
          estimatedDays = matchingZone.estimatedDays;
        }
      }

      // Add category-based shipping if enabled
      if (settings.useCategoryShipping && Array.isArray(categoryShippingCosts)) {
        const categoryShipping = categoryShippingCosts.reduce((sum, cost) => sum + (parseFloat(cost) || 0), 0);
        shippingCost += categoryShipping;
      }

      return res.status(200).json({
        message: 'Shipping calculated',
        data: {
          shippingCost,
          isFreeShipping: false,
          estimatedDays
        }
      });
    } catch (error) {
      console.error('Calculate shipping error:', error);
      return res.status(400).json({ message: 'Error calculating shipping', error: error.message });
    }
  }
};

module.exports = shippingController;
