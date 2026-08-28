const Trainer = require('../models/trainerModel');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

// Get all active trainers (public endpoint)
const getActiveTrainers = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || undefined;
    const isFeatured = req.query.isFeatured === 'true' ? true : undefined;

    // Build query filter
    const query = { isActive: true };
    if (isFeatured !== undefined) {
      query.isFeatured = isFeatured;
    }

    // Build the database query
    let trainersQuery = Trainer.find(query).sort({ order: 1, createdAt: -1 });

    if (limit) {
      trainersQuery = trainersQuery.limit(limit);
    }

    const trainers = await trainersQuery;

    res.status(200).json({
      success: true,
      message: 'Active trainers retrieved successfully',
      data: trainers
    });
  } catch (error) {
    console.error('Error fetching active trainers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active trainers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get featured trainers (public endpoint)
const getFeaturedTrainers = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 4;
    const trainers = await Trainer.getFeaturedTrainers(limit);

    res.status(200).json({
      success: true,
      message: 'Featured trainers retrieved successfully',
      data: trainers
    });
  } catch (error) {
    console.error('Error fetching featured trainers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch featured trainers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all trainers (admin only)
const getAllTrainers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const total = await Trainer.countDocuments();
    const trainers = await Trainer.find({})
      .sort({ order: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      success: true,
      message: 'All trainers retrieved successfully',
      data: trainers,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching all trainers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trainers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single trainer by ID
const getTrainerById = async (req, res) => {
  try {
    const { id } = req.params;
    const trainer = await Trainer.findById(id);

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Trainer retrieved successfully',
      data: trainer
    });
  } catch (error) {
    console.error('Error fetching trainer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trainer',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get trainer by slug (public endpoint)
const getTrainerBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const trainer = await Trainer.findOne({ slug, isActive: true });

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Trainer retrieved successfully',
      data: trainer
    });
  } catch (error) {
    console.error('Error fetching trainer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trainer',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create new trainer
const createTrainer = async (req, res) => {
  try {
    const {
      name,
      role,
      bio,
      email,
      phone,
      specialties,
      certifications,
      experience,
      social,
      availability,
      isActive,
      isFeatured,
      order
    } = req.body;

    // Handle image upload
    let imageUrl = req.body.image;
    if (req.file) {
      if (USE_BLOB_STORAGE && blobUpload) {
        imageUrl = await blobUpload.uploadToBlob(
          req.file.buffer, req.file.originalname, req.file.mimetype, 'trainers'
        );
      } else {
        imageUrl = `/uploads/${req.file.filename}`;
      }
    }

    // Parse JSON fields if they're strings
    let parsedSpecialties = specialties;
    if (typeof specialties === 'string') {
      try {
        parsedSpecialties = JSON.parse(specialties);
      } catch (e) {
        parsedSpecialties = specialties.split(',').map(s => s.trim());
      }
    }

    let parsedCertifications = certifications;
    if (typeof certifications === 'string') {
      try {
        parsedCertifications = JSON.parse(certifications);
      } catch (e) {
        parsedCertifications = certifications.split(',').map(c => c.trim());
      }
    }

    let parsedSocial = social;
    if (typeof social === 'string') {
      try {
        parsedSocial = JSON.parse(social);
      } catch (e) {
        parsedSocial = {};
      }
    }

    let parsedAvailability = availability;
    if (typeof availability === 'string') {
      try {
        parsedAvailability = JSON.parse(availability);
      } catch (e) {
        parsedAvailability = [];
      }
    }

    const trainerData = {
      name,
      role,
      bio: bio || undefined,
      image: imageUrl || undefined,
      email: email || undefined,
      phone: phone || undefined,
      specialties: parsedSpecialties || [],
      certifications: parsedCertifications || [],
      experience: experience ? parseInt(experience) : undefined,
      social: parsedSocial || {},
      availability: parsedAvailability || [],
      isActive: isActive !== undefined ? isActive === 'true' || isActive === true : true,
      isFeatured: isFeatured !== undefined ? isFeatured === 'true' || isFeatured === true : false,
      order: order ? parseInt(order) : undefined
    };

    const trainer = new Trainer(trainerData);
    await trainer.save();

    res.status(201).json({
      success: true,
      message: 'Trainer created successfully',
      data: trainer
    });
  } catch (error) {
    console.error('Error creating trainer:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A trainer with this slug already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create trainer',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update trainer
const updateTrainer = async (req, res) => {
  try {
    const { id } = req.params;
    const trainer = await Trainer.findById(id);

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    const {
      name,
      role,
      bio,
      email,
      phone,
      specialties,
      certifications,
      experience,
      social,
      availability,
      isActive,
      isFeatured,
      order
    } = req.body;

    // Handle image upload
    let imageUrl = req.body.image || trainer.image;
    if (req.file) {
      if (USE_BLOB_STORAGE && blobUpload) {
        imageUrl = await blobUpload.uploadToBlob(
          req.file.buffer, req.file.originalname, req.file.mimetype, 'trainers'
        );
      } else {
        imageUrl = `/uploads/${req.file.filename}`;
      }
    }

    // Parse JSON fields if they're strings
    let parsedSpecialties = specialties || trainer.specialties;
    if (specialties && typeof specialties === 'string') {
      try {
        parsedSpecialties = JSON.parse(specialties);
      } catch (e) {
        parsedSpecialties = specialties.split(',').map(s => s.trim());
      }
    }

    let parsedCertifications = certifications || trainer.certifications;
    if (certifications && typeof certifications === 'string') {
      try {
        parsedCertifications = JSON.parse(certifications);
      } catch (e) {
        parsedCertifications = certifications.split(',').map(c => c.trim());
      }
    }

    let parsedSocial = social || trainer.social;
    if (social && typeof social === 'string') {
      try {
        parsedSocial = JSON.parse(social);
      } catch (e) {
        parsedSocial = trainer.social;
      }
    }

    let parsedAvailability = availability || trainer.availability;
    if (availability && typeof availability === 'string') {
      try {
        parsedAvailability = JSON.parse(availability);
      } catch (e) {
        parsedAvailability = trainer.availability;
      }
    }

    const updateData = {
      name: name || trainer.name,
      role: role || trainer.role,
      bio: bio !== undefined ? bio : trainer.bio,
      image: imageUrl,
      email: email !== undefined ? email : trainer.email,
      phone: phone !== undefined ? phone : trainer.phone,
      specialties: parsedSpecialties,
      certifications: parsedCertifications,
      experience: experience !== undefined ? parseInt(experience) : trainer.experience,
      social: parsedSocial,
      availability: parsedAvailability,
      isActive: isActive !== undefined ? (isActive === 'true' || isActive === true) : trainer.isActive,
      isFeatured: isFeatured !== undefined ? (isFeatured === 'true' || isFeatured === true) : trainer.isFeatured,
      order: order !== undefined ? parseInt(order) : trainer.order
    };

    const updatedTrainer = await Trainer.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    });

    res.status(200).json({
      success: true,
      message: 'Trainer updated successfully',
      data: updatedTrainer
    });
  } catch (error) {
    console.error('Error updating trainer:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update trainer',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle trainer active status
const toggleTrainerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }

    const trainer = await Trainer.findByIdAndUpdate(
      id,
      { isActive },
      { new: true, runValidators: true }
    );

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    res.status(200).json({
      success: true,
      message: `Trainer ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: trainer
    });
  } catch (error) {
    console.error('Error updating trainer status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update trainer status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle trainer featured status
const toggleTrainerFeatured = async (req, res) => {
  try {
    const { id } = req.params;
    const { isFeatured } = req.body;

    if (typeof isFeatured !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isFeatured must be a boolean value'
      });
    }

    const trainer = await Trainer.findByIdAndUpdate(
      id,
      { isFeatured },
      { new: true, runValidators: true }
    );

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    res.status(200).json({
      success: true,
      message: `Trainer ${isFeatured ? 'marked as featured' : 'removed from featured'} successfully`,
      data: trainer
    });
  } catch (error) {
    console.error('Error updating trainer featured status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update trainer featured status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete trainer
const deleteTrainer = async (req, res) => {
  try {
    const { id } = req.params;

    const trainer = await Trainer.findById(id);
    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    await Trainer.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Trainer deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting trainer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete trainer',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  getActiveTrainers,
  getFeaturedTrainers,
  getAllTrainers,
  getTrainerById,
  getTrainerBySlug,
  createTrainer,
  updateTrainer,
  toggleTrainerStatus,
  toggleTrainerFeatured,
  deleteTrainer
};
