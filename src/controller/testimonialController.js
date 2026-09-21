// src/controller/testimonialController.js
//
// CRUD for homepage testimonials. Mirrors the hero-slide controller so the
// admin panel can reuse the same list / modal / reorder patterns.

const Testimonial = require('../models/testimonialModel');
const { tenantUploadFolder } = require('../helper/upload');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

// A photo too large for this API goes from the browser straight to the store
// (controller/uploadController.js) and arrives here as `uploadedImageUrl`
// instead of a file. Undefined when none was sent; null when one was sent
// but is not in this gym's own testimonials folder of the store, which is
// refused rather than stored.
const UPLOADED_URL_REFUSED = 'The uploaded photo could not be used. Please upload it again.';

function uploadedImageUrl(req) {
  const value = req.body && req.body.uploadedImageUrl;
  if (req.file || value === undefined || value === '') return undefined;
  if (!USE_BLOB_STORAGE || !blobUpload) return null;
  return blobUpload.ownBlobUrl(value, tenantUploadFolder(req), 'testimonials');
}

async function resolveUploadedImage(req) {
  if (!req.file) return undefined;
  if (USE_BLOB_STORAGE && blobUpload) {
    return blobUpload.uploadToBlob(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      'testimonials'
    );
  }
  return `/uploads/${req.file.filename}`;
}

function validationResponse(res, error) {
  return res.status(400).json({
    success: false,
    message: 'Validation error',
    errors: Object.values(error.errors).map((err) => err.message),
  });
}

const testimonialController = {
  // GET /testimonials/active — public.
  getActiveTestimonials: async (req, res) => {
    try {
      const testimonials = await Testimonial.getActive();
      return res.status(200).json({ success: true, data: testimonials });
    } catch (error) {
      console.error('Error fetching active testimonials:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch testimonials',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // GET /testimonials — admin.
  getAllTestimonials: async (req, res) => {
    try {
      const testimonials = await Testimonial.getAllSorted();
      return res.status(200).json({ success: true, data: testimonials });
    } catch (error) {
      console.error('Error fetching testimonials:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch testimonials',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // POST /testimonials — admin, multipart with optional `image`.
  createTestimonial: async (req, res) => {
    try {
      const { name, role, quote, rating, isActive, order } = req.body;

      const uploaded = uploadedImageUrl(req);
      if (uploaded === null) {
        return res.status(400).json({ success: false, message: UPLOADED_URL_REFUSED });
      }
      const imageUrl = uploaded || (await resolveUploadedImage(req));

      const testimonial = new Testimonial({
        name,
        role: role || '',
        quote,
        rating: rating !== undefined ? Number(rating) : 5,
        imageUrl: imageUrl || '',
        isActive: isActive !== undefined ? isActive === 'true' || isActive === true : true,
        order: order ? parseInt(order, 10) : 0,
      });
      await testimonial.save();

      return res.status(201).json({
        success: true,
        message: 'Testimonial created successfully',
        data: testimonial,
      });
    } catch (error) {
      console.error('Error creating testimonial:', error);
      if (error.name === 'ValidationError') return validationResponse(res, error);
      return res.status(500).json({
        success: false,
        message: 'Failed to create testimonial',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // PUT /testimonials/:id — admin, multipart with optional `image`.
  updateTestimonial: async (req, res) => {
    try {
      const { id } = req.params;
      const testimonial = await Testimonial.findById(id);
      if (!testimonial) {
        return res.status(404).json({ success: false, message: 'Testimonial not found' });
      }

      const uploaded = uploadedImageUrl(req);
      if (uploaded === null) {
        return res.status(400).json({ success: false, message: UPLOADED_URL_REFUSED });
      }

      const { name, role, quote, rating, isActive, order } = req.body;
      if (name !== undefined) testimonial.name = name;
      if (role !== undefined) testimonial.role = role;
      if (quote !== undefined) testimonial.quote = quote;
      if (rating !== undefined) testimonial.rating = Number(rating);
      if (isActive !== undefined) testimonial.isActive = isActive === 'true' || isActive === true;
      if (order !== undefined) testimonial.order = parseInt(order, 10) || 0;

      const imageUrl = uploaded || (await resolveUploadedImage(req));
      if (imageUrl) testimonial.imageUrl = imageUrl;

      await testimonial.save();

      return res.status(200).json({
        success: true,
        message: 'Testimonial updated successfully',
        data: testimonial,
      });
    } catch (error) {
      console.error('Error updating testimonial:', error);
      if (error.name === 'ValidationError') return validationResponse(res, error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update testimonial',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // PATCH /testimonials/:id/status — flip visibility.
  toggleTestimonialStatus: async (req, res) => {
    try {
      const { id } = req.params;
      const testimonial = await Testimonial.findById(id);
      if (!testimonial) {
        return res.status(404).json({ success: false, message: 'Testimonial not found' });
      }

      testimonial.isActive = !testimonial.isActive;
      await testimonial.save();

      return res.status(200).json({
        success: true,
        message: `Testimonial ${testimonial.isActive ? 'activated' : 'deactivated'}`,
        data: testimonial,
      });
    } catch (error) {
      console.error('Error toggling testimonial status:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to toggle testimonial status',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // PUT /testimonials/reorder — body: { order: [{ id, order }] }
  reorderTestimonials: async (req, res) => {
    try {
      const { order } = req.body;
      if (!Array.isArray(order) || order.length === 0) {
        return res.status(400).json({ success: false, message: 'order must be a non-empty array' });
      }

      await Testimonial.bulkWrite(
        order.map((item) => ({
          updateOne: {
            filter: { _id: item.id },
            update: { $set: { order: Number(item.order) || 0 } },
          },
        }))
      );

      const testimonials = await Testimonial.getAllSorted();
      return res.status(200).json({
        success: true,
        message: 'Testimonial order updated',
        data: testimonials,
      });
    } catch (error) {
      console.error('Error reordering testimonials:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to reorder testimonials',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // DELETE /testimonials/:id
  deleteTestimonial: async (req, res) => {
    try {
      const { id } = req.params;
      const testimonial = await Testimonial.findByIdAndDelete(id);
      if (!testimonial) {
        return res.status(404).json({ success: false, message: 'Testimonial not found' });
      }

      return res.status(200).json({
        success: true,
        message: 'Testimonial deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting testimonial:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete testimonial',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
};

module.exports = testimonialController;
