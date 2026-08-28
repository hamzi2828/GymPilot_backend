const HeroSlide = require('../models/heroSlideModel');
const path = require('path');
const fs = require('fs');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

// Get all active hero slides (public endpoint)
const getActiveSlides = async (req, res) => {
  try {
    const slides = await HeroSlide.find({ isActive: true }).sort({ order: 1, createdAt: 1 });

    res.status(200).json({
      success: true,
      message: 'Active hero slides retrieved successfully',
      data: slides
    });
  } catch (error) {
    console.error('Error fetching active hero slides:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active hero slides',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all hero slides (admin only)
const getAllSlides = async (req, res) => {
  try {
    const slides = await HeroSlide.getAllSlidesSorted();
    
    res.status(200).json({
      success: true,
      message: 'All hero slides retrieved successfully',
      data: slides
    });
  } catch (error) {
    console.error('Error fetching all hero slides:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch hero slides',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single hero slide by ID
const getSlideById = async (req, res) => {
  try {
    const { id } = req.params;
    const slide = await HeroSlide.findById(id);
    
    if (!slide) {
      return res.status(404).json({
        success: false,
        message: 'Hero slide not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Hero slide retrieved successfully',
      data: slide
    });
  } catch (error) {
    console.error('Error fetching hero slide:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch hero slide',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create new hero slide
const createSlide = async (req, res) => {
  try {
    const {
      title,
      description,
      buttonText,
      buttonLink,
      secondButtonText,
      secondButtonLink,
      isActive,
      order,
      ariaLabel
    } = req.body;

    // Handle file upload
    let imageUrl = '';
    if (req.file) {
      if (USE_BLOB_STORAGE && blobUpload) {
        imageUrl = await blobUpload.uploadToBlob(
          req.file.buffer, req.file.originalname, req.file.mimetype, 'hero-slides'
        );
      } else {
        imageUrl = `/uploads/${req.file.filename}`;
      }
    } else {
      return res.status(400).json({
        success: false,
        message: 'Image is required'
      });
    }

    const slideData = {
      title,
      description,
      imageUrl,
      buttonText: buttonText || undefined,
      buttonLink: buttonLink || undefined,
      secondButtonText: secondButtonText || undefined,
      secondButtonLink: secondButtonLink || undefined,
      isActive: isActive !== undefined ? isActive === 'true' : true,
      order: order ? parseInt(order) : undefined,
      ariaLabel: ariaLabel || undefined
    };
    
    const slide = new HeroSlide(slideData);
    await slide.save();
    
    res.status(201).json({
      success: true,
      message: 'Hero slide created successfully',
      data: slide
    });
  } catch (error) {
    // Clean up uploaded file if database save fails
    if (req.file) {
      const filePath = path.join(__dirname, '../../uploads', req.file.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    console.error('Error creating hero slide:', error);
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create hero slide',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update hero slide
const updateSlide = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      buttonText,
      buttonLink,
      secondButtonText,
      secondButtonLink,
      isActive,
      order,
      ariaLabel
    } = req.body;

    const slide = await HeroSlide.findById(id);
    if (!slide) {
      return res.status(404).json({
        success: false,
        message: 'Hero slide not found'
      });
    }

    const oldImagePath = slide.imageUrl;

    const updateData = {
      title: title || slide.title,
      description: description || slide.description,
      buttonText: buttonText !== undefined ? buttonText : slide.buttonText,
      buttonLink: buttonLink !== undefined ? buttonLink : slide.buttonLink,
      secondButtonText: secondButtonText !== undefined ? secondButtonText : slide.secondButtonText,
      secondButtonLink: secondButtonLink !== undefined ? secondButtonLink : slide.secondButtonLink,
      isActive: isActive !== undefined ? isActive === 'true' : slide.isActive,
      order: order ? parseInt(order) : slide.order,
      ariaLabel: ariaLabel !== undefined ? ariaLabel : slide.ariaLabel
    };
    
    // Handle new image upload
    if (req.file) {
      if (USE_BLOB_STORAGE && blobUpload) {
        updateData.imageUrl = await blobUpload.uploadToBlob(
          req.file.buffer, req.file.originalname, req.file.mimetype, 'hero-slides'
        );
      } else {
        updateData.imageUrl = `/uploads/${req.file.filename}`;

        // Delete old image file if it exists and is not the default
        if (oldImagePath && oldImagePath.startsWith('/uploads/')) {
          const oldFilePath = path.join(__dirname, '../../uploads', path.basename(oldImagePath));
          if (fs.existsSync(oldFilePath)) {
            fs.unlinkSync(oldFilePath);
          }
        }
      }
    }
    
    const updatedSlide = await HeroSlide.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    });
    
    res.status(200).json({
      success: true,
      message: 'Hero slide updated successfully',
      data: updatedSlide
    });
  } catch (error) {
    // Clean up uploaded file if database save fails
    if (req.file) {
      const filePath = path.join(__dirname, '../../uploads', req.file.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    console.error('Error updating hero slide:', error);
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to update hero slide',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle hero slide active status
const toggleSlideStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }
    
    const slide = await HeroSlide.findByIdAndUpdate(
      id,
      { isActive },
      { new: true, runValidators: true }
    );
    
    if (!slide) {
      return res.status(404).json({
        success: false,
        message: 'Hero slide not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: `Hero slide ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: slide
    });
  } catch (error) {
    console.error('Error updating hero slide status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update hero slide status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update hero slide order
const updateSlideOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { order } = req.body;
    
    if (typeof order !== 'number' || order < 0) {
      return res.status(400).json({
        success: false,
        message: 'Order must be a non-negative number'
      });
    }
    
    const slide = await HeroSlide.findByIdAndUpdate(
      id,
      { order },
      { new: true, runValidators: true }
    );
    
    if (!slide) {
      return res.status(404).json({
        success: false,
        message: 'Hero slide not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Hero slide order updated successfully',
      data: slide
    });
  } catch (error) {
    console.error('Error updating hero slide order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update hero slide order',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete hero slide
const deleteSlide = async (req, res) => {
  try {
    const { id } = req.params;
    
    const slide = await HeroSlide.findById(id);
    if (!slide) {
      return res.status(404).json({
        success: false,
        message: 'Hero slide not found'
      });
    }
    
    // Delete image file if it exists
    if (slide.imageUrl && slide.imageUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../../uploads', path.basename(slide.imageUrl));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    await HeroSlide.findByIdAndDelete(id);
    
    res.status(200).json({
      success: true,
      message: 'Hero slide deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting hero slide:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete hero slide',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  getActiveSlides,
  getAllSlides,
  getSlideById,
  createSlide,
  updateSlide,
  toggleSlideStatus,
  updateSlideOrder,
  deleteSlide
};