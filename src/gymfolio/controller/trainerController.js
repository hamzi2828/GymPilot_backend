const mongoose = require('mongoose');
const Trainer = require('../models/trainerModel');
const { checkLimit } = require('../../platform/planLimits');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

// The route takes the photo through uploadFields([{ name: 'image' }, ...]),
// which fills req.files.image, not req.file. req.file is still honoured for
// any caller mounted with a single-file upload.
function uploadedPhoto(req) {
  if (req.files && Array.isArray(req.files.image) && req.files.image[0]) return req.files.image[0];
  return req.file || null;
}

async function storePhoto(file) {
  if (USE_BLOB_STORAGE && blobUpload) {
    return blobUpload.uploadToBlob(file.buffer, file.originalname, file.mimetype, 'trainers');
  }
  return `/uploads/${file.filename}`;
}

// The multipart form sends 'true'/'false'; JSON sends booleans. Anything
// else is "not provided".
function readBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
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
/**
 * Reads the staff-account link off a form submission.
 *
 * Multipart forms have no null: an empty select arrives as the empty string,
 * and 'null'/'undefined' turn up too when a client stringifies a missing
 * value. All of those mean "not linked to a staff account".
 */
function normaliseUserId(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw || raw === 'null' || raw === 'undefined') return null;
  return mongoose.Types.ObjectId.isValid(raw) ? raw : null;
}

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
      order,
      userId
    } = req.body;

    // Handle image upload
    let imageUrl = req.body.image;
    const photo = uploadedPhoto(req);
    if (photo) imageUrl = await storePhoto(photo);

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
      acceptsPt: req.body.acceptsPt !== undefined ? req.body.acceptsPt === true || req.body.acceptsPt === 'true' : true,
      ptRate: req.body.ptRate !== undefined && req.body.ptRate !== '' ? Math.max(0, parseFloat(req.body.ptRate) || 0) : 0,
      commissionPercent: req.body.commissionPercent !== undefined && req.body.commissionPercent !== '' ? Math.min(100, Math.max(0, parseFloat(req.body.commissionPercent) || 0)) : null,
      isActive: isActive !== undefined ? isActive === 'true' || isActive === true : true,
      isFeatured: isFeatured !== undefined ? isFeatured === 'true' || isFeatured === true : false,
      // The staff account behind this profile, if any. Sent as a string from a
      // multipart form, where "unlinked" arrives as '' rather than null.
      userId: normaliseUserId(userId),
      order: order ? parseInt(order) : undefined
    };

    // The gym's platform plan may cap how many trainers it can list.
    const limit = await checkLimit('trainers');
    if (!limit.ok) return res.status(403).json({ success: false, message: limit.message, code: limit.code });

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
      order,
      userId
    } = req.body;

    // Handle image upload
    let imageUrl = req.body.image || trainer.image;
    const photo = uploadedPhoto(req);
    if (photo) imageUrl = await storePhoto(photo);

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
      acceptsPt: req.body.acceptsPt !== undefined ? req.body.acceptsPt === true || req.body.acceptsPt === 'true' : trainer.acceptsPt,
      ptRate: req.body.ptRate !== undefined && req.body.ptRate !== '' ? Math.max(0, parseFloat(req.body.ptRate) || 0) : trainer.ptRate,
      commissionPercent: req.body.commissionPercent !== undefined ? (req.body.commissionPercent === '' || req.body.commissionPercent === null ? null : Math.min(100, Math.max(0, parseFloat(req.body.commissionPercent) || 0))) : trainer.commissionPercent,
      isActive: isActive !== undefined ? (isActive === 'true' || isActive === true) : trainer.isActive,
      isFeatured: isFeatured !== undefined ? (isFeatured === 'true' || isFeatured === true) : trainer.isFeatured,
      order: order !== undefined ? parseInt(order) : trainer.order,
      // Only touched when the form actually sent the field, so an older client
      // that does not know about it cannot silently unlink a trainer.
      userId: userId !== undefined ? normaliseUserId(userId) : trainer.userId
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

// Toggle trainer active status.
//
// An explicit boolean in the body is honoured; a body with none (what the
// admin page's toggle button sends) flips the current value.
const toggleTrainerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const wanted = readBoolean((req.body || {}).isActive);

    const current = await Trainer.findById(id).select('isActive');
    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    const isActive = wanted === null ? !current.isActive : wanted;
    const trainer = await Trainer.findByIdAndUpdate(
      id,
      { isActive },
      { new: true, runValidators: true }
    );

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

// Toggle trainer featured status (same rule as toggleTrainerStatus).
const toggleTrainerFeatured = async (req, res) => {
  try {
    const { id } = req.params;
    const wanted = readBoolean((req.body || {}).isFeatured);

    const current = await Trainer.findById(id).select('isFeatured');
    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Trainer not found'
      });
    }

    const isFeatured = wanted === null ? !current.isFeatured : wanted;
    const trainer = await Trainer.findByIdAndUpdate(
      id,
      { isFeatured },
      { new: true, runValidators: true }
    );

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

    // Their fingerprints go with them: a template is biometric data with no
    // owner left to keep it for, and every desk would otherwise go on
    // downloading it. Must not block the deletion itself -- a failure is
    // logged and the trainer is still gone.
    try {
      const Fingerprint = require('../../attendance/models/fingerprintModel');
      await Fingerprint.deleteMany({ personType: 'staff', personId: trainer._id });
    } catch (cleanupError) {
      console.error('[trainers] could not delete fingerprints of', String(trainer._id), '-', cleanupError.message);
    }

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
