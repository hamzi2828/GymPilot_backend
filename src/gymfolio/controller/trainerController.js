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

// Pay terms never reach the public site: what a trainer is on is between
// them and the gym. The salary is `select: false` on the model; the
// commission is left out of every public read here.
//
// Nor does how to reach or identify the person behind the profile: their
// own email and phone, the staff account they sign in with and the code they
// are looked up by at the desk. The public endpoints need no sign-in, so
// these would otherwise be a list anyone can collect; a visitor contacts the
// gym, and staff read them from the admin list.
const PUBLIC_HIDDEN = '-commissionPercent -commissionType -commissionValue -email -phone -userId -staffCode';
// The admin screen reads the salary on top of the default fields.
const WITH_PAY = '+salary +salaryCycle';

const SALARY_CYCLES = ['monthly', 'biweekly', 'weekly'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A 400 in the shape the create/update handlers already answer validation
// errors with.
function invalid(field, message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.errors = { [field]: { message } };
  return error;
}

/**
 * The PT commission from a form: `commissionType` ('percent' | 'amount', or
 * '' for the gym's default) with `commissionValue`, or -- from a form that
 * predates the fixed amount -- `commissionPercent` alone. Nothing sent keeps
 * what is stored. commissionPercent is kept in step (the percent, or null)
 * for anything still reading only that.
 */
function readCommission(body, current = {}) {
  const none = { commissionType: null, commissionValue: null, commissionPercent: null };

  if (body.commissionType !== undefined) {
    const type = ['percent', 'amount'].includes(body.commissionType) ? body.commissionType : null;
    if (!type) return none;
    const raw = body.commissionValue;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw invalid('commissionValue', type === 'percent' ? 'Enter the commission percent' : 'Enter the commission per session');
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw invalid('commissionValue', 'The commission cannot be negative');
    if (type === 'percent') {
      if (value > 100) throw invalid('commissionValue', 'A commission percent cannot be over 100');
      return { commissionType: 'percent', commissionValue: value, commissionPercent: value };
    }
    return { commissionType: 'amount', commissionValue: round2(value), commissionPercent: null };
  }

  if (body.commissionPercent !== undefined) {
    if (body.commissionPercent === '' || body.commissionPercent === null) return none;
    const percent = Math.min(100, Math.max(0, parseFloat(body.commissionPercent) || 0));
    return { commissionType: 'percent', commissionValue: percent, commissionPercent: percent };
  }

  return {
    commissionType: current.commissionType ?? null,
    commissionValue: current.commissionValue ?? null,
    commissionPercent: current.commissionPercent ?? null
  };
}

/** The salary and its cycle from a form; blank = not set, 0 = commission only. */
function readSalary(body, current = {}) {
  let salary = current.salary ?? null;
  if (body.salary !== undefined) {
    const raw = body.salary;
    if (raw === null || String(raw).trim() === '' || raw === 'null') salary = null;
    else {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw invalid('salary', 'Enter a salary of 0 or more, or leave it blank');
      salary = round2(value);
    }
  }
  const salaryCycle = SALARY_CYCLES.includes(body.salaryCycle) ? body.salaryCycle : current.salaryCycle || 'monthly';
  return { salary, salaryCycle };
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
    let trainersQuery = Trainer.find(query).select(PUBLIC_HIDDEN).sort({ order: 1, createdAt: -1 });

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
    const trainers = await Trainer.getFeaturedTrainers(limit).select(PUBLIC_HIDDEN);

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

    // ?id= narrows the list to one trainer: the admin screen opens a trainer
    // from a link this way, with the pay terms the public read leaves out.
    const filter = {};
    if (req.query.id !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(String(req.query.id))) {
        return res.status(404).json({ success: false, message: 'Trainer not found' });
      }
      filter._id = String(req.query.id);
    }

    const total = await Trainer.countDocuments(filter);
    const trainers = await Trainer.find(filter)
      .select(WITH_PAY)
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
    const trainer = await Trainer.findById(id).select(PUBLIC_HIDDEN);

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
    const trainer = await Trainer.findOne({ slug, isActive: true }).select(PUBLIC_HIDDEN);

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
      ...readCommission(req.body),
      ...readSalary(req.body),
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
    const trainer = await Trainer.findById(id).select(WITH_PAY);

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
      // Each kept as stored when the form does not send it.
      ...readCommission(req.body, trainer),
      ...readSalary(req.body, trainer),
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
    }).select(WITH_PAY);

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
