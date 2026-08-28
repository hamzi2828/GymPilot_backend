const Style = require('../models/style');
const path = require('path');
const fs = require('fs');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

// Helper to generate slug from name
const generateSlug = (name) => {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

// Helper function to convert file path to public URL
const toPublicPath = (filePath) => {
  if (!filePath) return null;
  const uploadsIndex = filePath.indexOf('uploads');
  if (uploadsIndex === -1) return filePath;
  return '/' + filePath.substring(uploadsIndex).replace(/\\/g, '/');
};

// Helper to delete old image
const deleteOldImage = async (imageUrl) => {
  if (!imageUrl) return;

  // If it's a blob URL, delete from blob storage
  if (USE_BLOB_STORAGE && blobUpload && imageUrl.includes('blob.vercel-storage.com')) {
    try {
      await blobUpload.deleteFromBlob(imageUrl);
    } catch (err) {
      console.error('Error deleting blob image:', err);
    }
    return;
  }

  // Local file deletion
  if (imageUrl.startsWith('/uploads/')) {
    const filePath = path.resolve(__dirname, '../../', imageUrl.substring(1));
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error('Error deleting local image:', err);
      }
    }
  }
};

const styleController = {
  // GET - list all styles
  listStyles: async (req, res) => {
    try {
      const styles = await Style.find().sort({ createdAt: -1 });
      return res.status(200).json({ message: 'Styles fetched successfully', data: styles });
    } catch (error) {
      console.error('List styles error:', error);
      return res.status(400).json({ message: 'Error fetching styles', error: error.message });
    }
  },

  // GET - get single style by ID
  getStyle: async (req, res) => {
    try {
      const { id } = req.params;
      const style = await Style.findById(id);
      if (!style) {
        return res.status(404).json({ message: 'Style not found' });
      }
      return res.status(200).json({ message: 'Style fetched successfully', data: style });
    } catch (error) {
      console.error('Get style error:', error);
      return res.status(400).json({ message: 'Error fetching style', error: error.message });
    }
  },

  // POST - create a new style
  createStyle: async (req, res) => {
    try {
      let { name, slug, maxClothUsage = 0, active = true } = req.body || {};

      if (!name) {
        return res.status(400).json({ message: 'Name is required' });
      }

      name = String(name).trim();
      slug = slug ? String(slug).trim().toLowerCase() : generateSlug(name);
      maxClothUsage = parseFloat(maxClothUsage) || 0;
      active = Boolean(active);

      let imageUrl = null;
      const file = req.files?.image?.[0];

      if (file) {
        if (USE_BLOB_STORAGE && blobUpload) {
          imageUrl = await blobUpload.uploadToBlob(
            file.buffer,
            file.originalname,
            file.mimetype,
            'styles'
          );
        } else {
          imageUrl = `/uploads/${file.filename}`;
        }
      }

      const created = await Style.create({ name, slug, imageUrl, maxClothUsage, active });
      return res.status(201).json({ message: 'Style created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Style with this name already exists' });
      }
      console.error('Create style error:', error);
      return res.status(400).json({ message: 'Error creating style', error: error.message });
    }
  },

  // PUT - update a style
  updateStyle: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const existing = await Style.findById(id);
      if (!existing) {
        return res.status(404).json({ message: 'Style not found' });
      }

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
      if (typeof payload.maxClothUsage !== 'undefined') {
        updates.maxClothUsage = parseFloat(payload.maxClothUsage) || 0;
      }
      if (typeof payload.active !== 'undefined') {
        updates.active = Boolean(payload.active);
      }

      // Handle image upload
      const file = req.files?.image?.[0];
      if (file) {
        // Delete old image
        await deleteOldImage(existing.imageUrl);

        if (USE_BLOB_STORAGE && blobUpload) {
          updates.imageUrl = await blobUpload.uploadToBlob(
            file.buffer,
            file.originalname,
            file.mimetype,
            'styles'
          );
        } else {
          updates.imageUrl = `/uploads/${file.filename}`;
        }
      }

      // Handle image removal
      if (payload.removeImage === 'true' || payload.removeImage === true) {
        await deleteOldImage(existing.imageUrl);
        updates.imageUrl = null;
      }

      const updated = await Style.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      return res.status(200).json({ message: 'Style updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Style with this name already exists' });
      }
      console.error('Update style error:', error);
      return res.status(400).json({ message: 'Error updating style', error: error.message });
    }
  },

  // DELETE - delete a style
  deleteStyle: async (req, res) => {
    try {
      const { id } = req.params;
      const style = await Style.findById(id);

      if (!style) {
        return res.status(404).json({ message: 'Style not found' });
      }

      // Delete associated image
      await deleteOldImage(style.imageUrl);

      await Style.findByIdAndDelete(id);
      return res.status(200).json({ message: 'Style deleted successfully', id });
    } catch (error) {
      console.error('Delete style error:', error);
      return res.status(400).json({ message: 'Error deleting style', error: error.message });
    }
  },

  // GET - list active styles (public)
  listActiveStyles: async (req, res) => {
    try {
      const styles = await Style.find({ active: true }).sort({ name: 1 });
      return res.status(200).json({ message: 'Styles fetched successfully', data: styles });
    } catch (error) {
      console.error('List active styles error:', error);
      return res.status(400).json({ message: 'Error fetching styles', error: error.message });
    }
  },
};

module.exports = styleController;
