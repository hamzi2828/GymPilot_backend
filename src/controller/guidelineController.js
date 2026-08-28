// src/controller/guidelineController.js
const Guideline = require('../models/guideline');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

// Import blob upload helper if using Vercel Blob
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

const guidelineController = {
  // GET /guidelines - list all guidelines
  listGuidelines: async (req, res) => {
    try {
      const { activeOnly, type } = req.query;
      let query = {};

      if (activeOnly === 'true') {
        query.active = true;
      }

      if (type && ['size-chart', 'measuring-tip'].includes(type)) {
        query.type = type;
      }

      const guidelines = await Guideline.find(query).sort({ order: 1, createdAt: -1 });
      return res.status(200).json({
        success: true,
        message: 'Guidelines fetched successfully',
        data: guidelines
      });
    } catch (error) {
      console.error('List guidelines error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching guidelines',
        error: error.message
      });
    }
  },

  // GET /guidelines/:id - get a single guideline
  getGuidelineById: async (req, res) => {
    try {
      const { id } = req.params;
      const guideline = await Guideline.findById(id);

      if (!guideline) {
        return res.status(404).json({
          success: false,
          message: 'Guideline not found'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Guideline fetched successfully',
        data: guideline
      });
    } catch (error) {
      console.error('Get guideline error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching guideline',
        error: error.message
      });
    }
  },

  // POST /guidelines - create a new guideline
  createGuideline: async (req, res) => {
    try {
      let { name, slug, type = 'size-chart', active = true, order = 0 } = req.body || {};

      if (!name || !slug) {
        return res.status(400).json({
          success: false,
          message: 'name and slug are required'
        });
      }

      name = String(name).trim();
      slug = String(slug).trim().toLowerCase();
      type = ['size-chart', 'measuring-tip'].includes(type) ? type : 'size-chart';
      active = active === 'true' || active === true;
      order = parseInt(order) || 0;

      // Handle multiple image uploads
      const imageFiles = req.files?.images || req.files?.image || [];
      const images = [];
      let imageUrl = null;

      if (USE_BLOB_STORAGE && blobUpload) {
        // Upload to Vercel Blob
        for (const imageFile of imageFiles) {
          const uploadedUrl = await blobUpload.uploadToBlob(
            imageFile.buffer,
            imageFile.originalname,
            imageFile.mimetype,
            'guidelines'
          );
          images.push(uploadedUrl);
        }
      } else {
        // Local storage
        for (const imageFile of imageFiles) {
          images.push(`/uploads/${imageFile.filename}`);
        }
      }

      // Set imageUrl to first image for backward compatibility
      if (images.length > 0) {
        imageUrl = images[0];
      }

      const guidelineData = {
        name,
        slug,
        type,
        imageUrl,
        images,
        active,
        order,
      };

      const created = await Guideline.create(guidelineData);
      return res.status(201).json({
        success: true,
        message: 'Guideline created successfully',
        data: created
      });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'Slug already exists'
        });
      }
      console.error('Create guideline error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error creating guideline',
        error: error.message
      });
    }
  },

  // PUT /guidelines/:id - update a guideline
  updateGuideline: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.name !== 'undefined') updates.name = String(payload.name).trim();
      if (typeof payload.slug !== 'undefined') updates.slug = String(payload.slug).trim().toLowerCase();
      if (typeof payload.type !== 'undefined' && ['size-chart', 'measuring-tip'].includes(payload.type)) {
        updates.type = payload.type;
      }
      if (typeof payload.active !== 'undefined') updates.active = payload.active === 'true' || payload.active === true;
      if (typeof payload.order !== 'undefined') updates.order = parseInt(payload.order) || 0;

      // Handle existing images (passed as JSON string or array)
      let existingImages = [];
      if (payload.existingImages) {
        try {
          existingImages = typeof payload.existingImages === 'string'
            ? JSON.parse(payload.existingImages)
            : payload.existingImages;
        } catch (e) {
          existingImages = [];
        }
      }

      // Handle new image uploads
      const imageFiles = req.files?.images || req.files?.image || [];
      const newImages = [];

      if (USE_BLOB_STORAGE && blobUpload) {
        // Upload to Vercel Blob
        for (const imageFile of imageFiles) {
          const uploadedUrl = await blobUpload.uploadToBlob(
            imageFile.buffer,
            imageFile.originalname,
            imageFile.mimetype,
            'guidelines'
          );
          newImages.push(uploadedUrl);
        }
      } else {
        // Local storage
        for (const imageFile of imageFiles) {
          newImages.push(`/uploads/${imageFile.filename}`);
        }
      }

      // Combine existing and new images
      const allImages = [...existingImages, ...newImages];
      if (allImages.length > 0 || payload.existingImages !== undefined) {
        updates.images = allImages;
        updates.imageUrl = allImages[0] || null;
      }

      const updated = await Guideline.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Guideline not found'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Guideline updated successfully',
        data: updated
      });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'Slug already exists'
        });
      }
      console.error('Update guideline error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error updating guideline',
        error: error.message
      });
    }
  },

  // PATCH /guidelines/:id/toggle-active - toggle active status
  toggleActive: async (req, res) => {
    try {
      const { id } = req.params;
      const guideline = await Guideline.findById(id);

      if (!guideline) {
        return res.status(404).json({
          success: false,
          message: 'Guideline not found'
        });
      }

      guideline.active = !guideline.active;
      await guideline.save();

      return res.status(200).json({
        success: true,
        message: `Guideline ${guideline.active ? 'activated' : 'deactivated'} successfully`,
        data: guideline
      });
    } catch (error) {
      console.error('Toggle guideline active error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error toggling guideline status',
        error: error.message
      });
    }
  },

  // DELETE /guidelines/:id - delete a guideline
  deleteGuideline: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Guideline.findByIdAndDelete(id);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          message: 'Guideline not found'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Guideline deleted successfully',
        id
      });
    } catch (error) {
      console.error('Delete guideline error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error deleting guideline',
        error: error.message
      });
    }
  },
};

module.exports = guidelineController;
