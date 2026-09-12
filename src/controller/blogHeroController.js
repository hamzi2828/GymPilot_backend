const BlogHero = require('../models/blogHero');

// Uploads go to Vercel Blob when it is configured (multer then keeps the file
// in memory and `.filename` is never set), to the local uploads folder
// otherwise -- the same branch settingsController and homeSectionController
// take.
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

async function storedImageUrl(file, folder = 'blog-hero') {
  if (USE_BLOB_STORAGE && blobUpload) {
    return blobUpload.uploadToBlob(file.buffer, file.originalname, file.mimetype, folder);
  }
  return `/uploads/${file.filename}`;
}

// The buttons are optional (the model supplies defaults); only what the form
// actually sent is written, so an omitted field keeps its default or its
// current value rather than being blanked.
const BUTTON_FIELDS = ['primaryButtonText', 'primaryButtonLink', 'secondaryButtonText', 'secondaryButtonLink'];

const readBoolean = (value) => value === true || value === 'true' || value === 1 || value === '1';

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
      const { title, subtitle, backgroundImage, isActive, sortOrder } = req.body;

      // Handle uploaded file
      let finalBackgroundImage = backgroundImage;
      const uploadedFile = req.files?.backgroundImage?.[0];

      if (uploadedFile) {
        finalBackgroundImage = await storedImageUrl(uploadedFile);
      }

      // Validate required fields: the headline, the line under it and the
      // photo. The buttons are optional.
      if (!title || !subtitle || !finalBackgroundImage) {
        return res.status(400).json({
          success: false,
          message: 'A title, a subtitle and a background image are required'
        });
      }

      // Create new hero
      const heroData = {
        title: String(title).trim(),
        subtitle: String(subtitle).trim(),
        backgroundImage: String(finalBackgroundImage).trim(),
        // Forms send 'false' as a string, which Boolean() would read as true.
        isActive: readBoolean(isActive),
        sortOrder: Number(sortOrder) || 0
      };
      for (const field of BUTTON_FIELDS) {
        if (req.body[field] !== undefined) heroData[field] = String(req.body[field]).trim();
      }

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
        updateData.backgroundImage = await storedImageUrl(uploadedFile);
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
      const imageUrl = await storedImageUrl(imageFile);

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