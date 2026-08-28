// src/controller/sizeGuideController.js

const SizeGuide = require('../models/sizeGuide');
const fs = require('fs');
const path = require('path');

// Check if using Vercel Blob storage
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Import blob upload helper if available
let blobUpload = null;
if (USE_BLOB_STORAGE) {
  try {
    blobUpload = require('../helper/blobUpload');
  } catch (e) {
    console.warn('Blob upload helper not available:', e.message);
  }
}

// Helper to convert file path to public URL path
const toPublicPath = (filePath) => {
  if (!filePath) return null;
  // Convert absolute path to relative URL path
  const uploadsIndex = filePath.indexOf('uploads');
  if (uploadsIndex === -1) return filePath;
  return '/' + filePath.substring(uploadsIndex).replace(/\\/g, '/');
};

// Helper to process uploaded image file
const processImageFile = async (file) => {
  if (!file) return null;

  // If using Blob storage and file has buffer
  if (USE_BLOB_STORAGE && blobUpload && file.buffer) {
    return await blobUpload.uploadToBlob(
      file.buffer,
      file.originalname,
      file.mimetype,
      'size-guides'
    );
  }

  // Local storage - file has path
  if (file.path) {
    return toPublicPath(file.path);
  }

  return null;
};

// List all size guides
exports.listSizeGuides = async (req, res) => {
  try {
    const sizeGuides = await SizeGuide.find().sort({ createdAt: -1 });
    res.json({ success: true, data: sizeGuides });
  } catch (error) {
    console.error('Error listing size guides:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch size guides' });
  }
};

// List active size guides (public)
exports.listActiveSizeGuides = async (req, res) => {
  try {
    const sizeGuides = await SizeGuide.find({ active: true }).sort({ createdAt: -1 });
    res.json({ success: true, data: sizeGuides });
  } catch (error) {
    console.error('Error listing active size guides:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch size guides' });
  }
};

// Get size guide by ID
exports.getSizeGuideById = async (req, res) => {
  try {
    const sizeGuide = await SizeGuide.findById(req.params.id);
    if (!sizeGuide) {
      return res.status(404).json({ success: false, message: 'Size guide not found' });
    }
    res.json({ success: true, data: sizeGuide });
  } catch (error) {
    console.error('Error fetching size guide:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch size guide' });
  }
};

// Create a new size guide
exports.createSizeGuide = async (req, res) => {
  try {
    const { name, active } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    // Handle image upload
    let imageUrl = null;
    if (req.files && req.files.image && req.files.image[0]) {
      imageUrl = await processImageFile(req.files.image[0]);
    }

    const sizeGuide = new SizeGuide({
      name: name.trim(),
      imageUrl,
      active: active !== undefined ? (active === 'true' || active === true) : true,
    });

    await sizeGuide.save();
    res.status(201).json({ success: true, data: sizeGuide });
  } catch (error) {
    console.error('Error creating size guide:', error);
    res.status(500).json({ success: false, message: 'Failed to create size guide' });
  }
};

// Update a size guide
exports.updateSizeGuide = async (req, res) => {
  try {
    const { name, active } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (active !== undefined) updateData.active = (active === 'true' || active === true);

    // Handle image upload
    if (req.files && req.files.image && req.files.image[0]) {
      // Get current size guide to delete old image
      const currentSizeGuide = await SizeGuide.findById(req.params.id);
      if (currentSizeGuide && currentSizeGuide.imageUrl) {
        // Delete old image
        if (USE_BLOB_STORAGE && blobUpload && currentSizeGuide.imageUrl.includes('blob.vercel-storage.com')) {
          await blobUpload.deleteFromBlob(currentSizeGuide.imageUrl);
        } else {
          const oldImagePath = path.join(__dirname, '../../', currentSizeGuide.imageUrl);
          if (fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
        }
      }
      updateData.imageUrl = await processImageFile(req.files.image[0]);
    }

    const sizeGuide = await SizeGuide.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!sizeGuide) {
      return res.status(404).json({ success: false, message: 'Size guide not found' });
    }

    res.json({ success: true, data: sizeGuide });
  } catch (error) {
    console.error('Error updating size guide:', error);
    res.status(500).json({ success: false, message: 'Failed to update size guide' });
  }
};

// Toggle active status
exports.toggleActive = async (req, res) => {
  try {
    const sizeGuide = await SizeGuide.findById(req.params.id);
    if (!sizeGuide) {
      return res.status(404).json({ success: false, message: 'Size guide not found' });
    }

    sizeGuide.active = !sizeGuide.active;
    await sizeGuide.save();

    res.json({ success: true, data: sizeGuide });
  } catch (error) {
    console.error('Error toggling size guide status:', error);
    res.status(500).json({ success: false, message: 'Failed to update size guide status' });
  }
};

// Delete a size guide
exports.deleteSizeGuide = async (req, res) => {
  try {
    const sizeGuide = await SizeGuide.findById(req.params.id);
    if (!sizeGuide) {
      return res.status(404).json({ success: false, message: 'Size guide not found' });
    }

    // Delete associated image if exists
    if (sizeGuide.imageUrl) {
      if (USE_BLOB_STORAGE && blobUpload && sizeGuide.imageUrl.includes('blob.vercel-storage.com')) {
        await blobUpload.deleteFromBlob(sizeGuide.imageUrl);
      } else {
        const imagePath = path.join(__dirname, '../../', sizeGuide.imageUrl);
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
      }
    }

    await SizeGuide.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Size guide deleted successfully' });
  } catch (error) {
    console.error('Error deleting size guide:', error);
    res.status(500).json({ success: false, message: 'Failed to delete size guide' });
  }
};
