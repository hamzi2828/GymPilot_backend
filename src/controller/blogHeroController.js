const BlogHero = require('../models/blogHero');
const fs = require('fs').promises;
const path = require('path');

const blogHeroController = {
  // GET /blog-hero/active - Get active hero section (public)
  getActiveHero: async (req, res) => {
    try {
      const hero = await BlogHero.getActiveHero();

      if (!hero) {
        return res.status(404).json({
          success: false,
          message: 'No active hero section found'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Active hero retrieved successfully',
        data: hero
      });
    } catch (error) {
      console.error('Get active hero error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve active hero',
        error: error.message
      });
    }
  },

  // GET /blog-hero - Get all heroes (admin)
  getAllHeroes: async (req, res) => {
    try {
      const heroes = await BlogHero.getAllHeroes();

      return res.status(200).json({
        success: true,
        message: 'Heroes retrieved successfully',
        data: heroes
      });
    } catch (error) {
      console.error('Get all heroes error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve heroes',
        error: error.message
      });
    }
  },

  // GET /blog-hero/:id - Get hero by ID (admin)
  getHeroById: async (req, res) => {
    try {
      const { id } = req.params;
      const hero = await BlogHero.findById(id);

      if (!hero) {
        return res.status(404).json({
          success: false,
          message: 'Hero not found'
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Hero retrieved successfully',
        data: hero
      });
    } catch (error) {
      console.error('Get hero by ID error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve hero',
        error: error.message
      });
    }
  },

  // POST /blog-hero - Create new hero (admin)
  createHero: async (req, res) => {
    try {
      const {
        title,
        subtitle,
        backgroundImage,
        primaryButtonText,
        primaryButtonLink,
        secondaryButtonText,
        secondaryButtonLink,
        isActive,
        sortOrder
      } = req.body;

      // Handle uploaded file
      let finalBackgroundImage = backgroundImage;
      const uploadedFile = req.files?.backgroundImage?.[0];

      if (uploadedFile) {
        // Generate image URL for uploaded file
        finalBackgroundImage = `/uploads/${uploadedFile.filename}`;
      }

      // Validate required fields
      if (!title || !subtitle || !finalBackgroundImage || !primaryButtonText ||
          !primaryButtonLink || !secondaryButtonText || !secondaryButtonLink) {
        return res.status(400).json({
          success: false,
          message: 'All fields are required including background image'
        });
      }

      // Create new hero
      const heroData = {
        title: title.trim(),
        subtitle: subtitle.trim(),
        backgroundImage: finalBackgroundImage.trim(),
        primaryButtonText: primaryButtonText.trim(),
        primaryButtonLink: primaryButtonLink.trim(),
        secondaryButtonText: secondaryButtonText.trim(),
        secondaryButtonLink: secondaryButtonLink.trim(),
        isActive: Boolean(isActive),
        sortOrder: sortOrder || 0
      };

      const hero = new BlogHero(heroData);
      await hero.save();

      return res.status(201).json({
        success: true,
        message: 'Hero created successfully',
        data: hero
      });
    } catch (error) {
      console.error('Create hero error:', error);

      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to create hero',
        error: error.message
      });
    }
  },

  // PUT /blog-hero/:id - Update hero (admin)
  updateHero: async (req, res) => {
    try {
      const { id } = req.params;
      const updateData = req.body;

      const hero = await BlogHero.findById(id);
      if (!hero) {
        return res.status(404).json({
          success: false,
          message: 'Hero not found'
        });
      }

      // Handle uploaded file
      const uploadedFile = req.files?.backgroundImage?.[0];
      if (uploadedFile) {
        // Generate image URL for uploaded file
        updateData.backgroundImage = `/uploads/${uploadedFile.filename}`;
      }

      // Update fields if provided
      Object.keys(updateData).forEach(key => {
        if (updateData[key] !== undefined) {
          if (typeof updateData[key] === 'string') {
            hero[key] = updateData[key].trim();
          } else {
            hero[key] = updateData[key];
          }
        }
      });

      await hero.save();

      return res.status(200).json({
        success: true,
        message: 'Hero updated successfully',
        data: hero
      });
    } catch (error) {
      console.error('Update hero error:', error);

      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to update hero',
        error: error.message
      });
    }
  },

  // DELETE /blog-hero/:id - Delete hero (admin)
  deleteHero: async (req, res) => {
    try {
      const { id } = req.params;

      const hero = await BlogHero.findById(id);
      if (!hero) {
        return res.status(404).json({
          success: false,
          message: 'Hero not found'
        });
      }

      await BlogHero.findByIdAndDelete(id);

      return res.status(200).json({
        success: true,
        message: 'Hero deleted successfully'
      });
    } catch (error) {
      console.error('Delete hero error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete hero',
        error: error.message
      });
    }
  },

  // PATCH /blog-hero/:id/toggle-active - Toggle active status (admin)
  toggleActiveStatus: async (req, res) => {
    try {
      const { id } = req.params;

      const hero = await BlogHero.findById(id);
      if (!hero) {
        return res.status(404).json({
          success: false,
          message: 'Hero not found'
        });
      }

      const updatedHero = await hero.toggleActive();

      return res.status(200).json({
        success: true,
        message: 'Hero status updated successfully',
        data: updatedHero
      });
    } catch (error) {
      console.error('Toggle hero status error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to toggle hero status',
        error: error.message
      });
    }
  },

  // POST /blog-hero/upload-image - Upload hero background image (admin)
  uploadImage: async (req, res) => {
    try {
      const imageFile = req.files?.image?.[0];

      if (!imageFile) {
        return res.status(400).json({
          success: false,
          message: 'Image file is required'
        });
      }

      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
      if (!allowedTypes.includes(imageFile.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Please upload PNG, JPG, GIF, WebP, or SVG images only.'
        });
      }

      // Validate file size (20MB)
      if (imageFile.size > 20 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size allowed is 20MB.'
        });
      }

      // Generate image URL
      const imageUrl = `/uploads/${imageFile.filename}`;

      return res.status(200).json({
        success: true,
        message: 'Image uploaded successfully',
        data: {
          imageUrl
        }
      });
    } catch (error) {
      console.error('Upload image error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload image',
        error: error.message
      });
    }
  }
};

module.exports = blogHeroController;