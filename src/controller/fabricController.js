// src/controller/fabricController.js

const Fabric = require('../models/fabric');
const fs = require('fs');
const path = require('path');

// Helper to convert file path to public URL path
const toPublicPath = (filePath) => {
  if (!filePath) return null;
  // Convert absolute path to relative URL path
  const uploadsIndex = filePath.indexOf('uploads');
  if (uploadsIndex === -1) return filePath;
  return '/' + filePath.substring(uploadsIndex).replace(/\\/g, '/');
};

// List all fabrics
exports.listFabrics = async (req, res) => {
  try {
    const fabrics = await Fabric.find().sort({ createdAt: -1 });
    res.json({ success: true, data: fabrics });
  } catch (error) {
    console.error('Error listing fabrics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch fabrics' });
  }
};

// Get fabric by ID
exports.getFabricById = async (req, res) => {
  try {
    const fabric = await Fabric.findById(req.params.id);
    if (!fabric) {
      return res.status(404).json({ success: false, message: 'Fabric not found' });
    }
    res.json({ success: true, data: fabric });
  } catch (error) {
    console.error('Error fetching fabric:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch fabric' });
  }
};

// Create a new fabric
exports.createFabric = async (req, res) => {
  try {
    const { name, slug, description, pricePerMeter, active } = req.body;

    // Check if slug already exists
    const existing = await Fabric.findOne({ slug: slug.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A fabric with this slug already exists' });
    }

    // Handle image upload
    let imageUrl = null;
    if (req.files && req.files.image && req.files.image[0]) {
      imageUrl = toPublicPath(req.files.image[0].path);
    }

    const fabric = new Fabric({
      name,
      slug: slug.toLowerCase(),
      description: description || '',
      imageUrl,
      pricePerMeter: pricePerMeter ? parseFloat(pricePerMeter) : null,
      active: active !== undefined ? (active === 'true' || active === true) : true,
    });

    await fabric.save();
    res.status(201).json({ success: true, data: fabric });
  } catch (error) {
    console.error('Error creating fabric:', error);
    res.status(500).json({ success: false, message: 'Failed to create fabric' });
  }
};

// Update a fabric
exports.updateFabric = async (req, res) => {
  try {
    const { name, slug, description, pricePerMeter, active } = req.body;

    // Check if slug already exists (excluding current fabric)
    if (slug) {
      const existing = await Fabric.findOne({
        slug: slug.toLowerCase(),
        _id: { $ne: req.params.id }
      });
      if (existing) {
        return res.status(400).json({ success: false, message: 'A fabric with this slug already exists' });
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (slug !== undefined) updateData.slug = slug.toLowerCase();
    if (description !== undefined) updateData.description = description;
    if (pricePerMeter !== undefined) updateData.pricePerMeter = pricePerMeter ? parseFloat(pricePerMeter) : null;
    if (active !== undefined) updateData.active = (active === 'true' || active === true);

    // Handle image upload
    if (req.files && req.files.image && req.files.image[0]) {
      // Get current fabric to delete old image
      const currentFabric = await Fabric.findById(req.params.id);
      if (currentFabric && currentFabric.imageUrl) {
        const oldImagePath = path.join(__dirname, '../../', currentFabric.imageUrl);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
      updateData.imageUrl = toPublicPath(req.files.image[0].path);
    }

    const fabric = await Fabric.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!fabric) {
      return res.status(404).json({ success: false, message: 'Fabric not found' });
    }

    res.json({ success: true, data: fabric });
  } catch (error) {
    console.error('Error updating fabric:', error);
    res.status(500).json({ success: false, message: 'Failed to update fabric' });
  }
};

// Delete a fabric
exports.deleteFabric = async (req, res) => {
  try {
    const fabric = await Fabric.findByIdAndDelete(req.params.id);
    if (!fabric) {
      return res.status(404).json({ success: false, message: 'Fabric not found' });
    }
    res.json({ success: true, message: 'Fabric deleted successfully' });
  } catch (error) {
    console.error('Error deleting fabric:', error);
    res.status(500).json({ success: false, message: 'Failed to delete fabric' });
  }
};
