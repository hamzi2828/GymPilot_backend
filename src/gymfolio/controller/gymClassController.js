const GymClass = require('../models/gymClassModel');
const { currencyOr } = require('../../services/currency');
const { checkLimit } = require('../../platform/planLimits');

// A list field as it arrives from either kind of client: a real array from a
// JSON body, a JSON string ('["a","b"]') from a multipart form, or a plain
// comma-separated string from an older form. An array is used as it is --
// never joined into "a,b" -- and an absent field yields `fallback`.
function parseList(value, fallback = []) {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined && item !== null && String(item).trim() !== '').map((item) => (typeof item === 'string' ? item.trim() : item));
  }
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parseList(parsed, fallback);
    } catch (e) {
      // Not JSON after all: fall through to the comma form.
    }
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

// The multipart form sends 'true'/'false'; JSON sends booleans. Anything
// else is "not provided".
function readBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../../helper/blobUpload');
}

// Get all active classes (public endpoint)
const getActiveClasses = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || undefined;
    const isFeatured = req.query.isFeatured === 'true' ? true : undefined;

    // Build query filter
    const query = { isActive: true };
    if (isFeatured !== undefined) {
      query.isFeatured = isFeatured;
    }

    // Build the database query with instructor population
    let classesQuery = GymClass.find(query)
      .populate('schedule.instructor', 'name role')
      .sort({ order: 1, createdAt: -1 });

    if (limit) {
      classesQuery = classesQuery.limit(limit);
    }

    const classes = await classesQuery;

    res.status(200).json({
      success: true,
      message: 'Active classes retrieved successfully',
      data: classes
    });
  } catch (error) {
    console.error('Error fetching active classes:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch active classes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get featured classes (public endpoint)
const getFeaturedClasses = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 4;
    const classes = await GymClass.getFeaturedClasses(limit);

    res.status(200).json({
      success: true,
      message: 'Featured classes retrieved successfully',
      data: classes
    });
  } catch (error) {
    console.error('Error fetching featured classes:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch featured classes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get classes by category (public endpoint)
const getClassesByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const classes = await GymClass.getClassesByCategory(category);

    res.status(200).json({
      success: true,
      message: 'Classes retrieved successfully',
      data: classes
    });
  } catch (error) {
    console.error('Error fetching classes by category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch classes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all classes (admin only)
const getAllClasses = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const total = await GymClass.countDocuments();
    const classes = await GymClass.find({})
      .populate('schedule.instructor', 'name role image')
      .sort({ order: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.status(200).json({
      success: true,
      message: 'All classes retrieved successfully',
      data: classes,
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
    console.error('Error fetching all classes:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch classes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single class by ID
const getClassById = async (req, res) => {
  try {
    const { id } = req.params;
    const gymClass = await GymClass.findById(id)
      .populate('schedule.instructor', 'name role image email phone');

    if (!gymClass) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Class retrieved successfully',
      data: gymClass
    });
  } catch (error) {
    console.error('Error fetching class:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch class',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get class by slug (public endpoint)
const getClassBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const gymClass = await GymClass.findOne({ slug, isActive: true })
      .populate('schedule.instructor', 'name role image email phone social');

    if (!gymClass) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Class retrieved successfully',
      data: gymClass
    });
  } catch (error) {
    console.error('Error fetching class:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch class',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create new class
const createClass = async (req, res) => {
  try {
    const {
      name,
      description,
      shortDescription,
      videoUrl,
      videoPoster,
      schedule,
      duration,
      difficulty,
      capacity,
      features,
      requirements,
      category,
      tags,
      isActive,
      isFeatured,
      order,
      price,
      currency
    } = req.body;

    // Handle file uploads. Gallery URLs the form already holds arrive as a
    // list (array or JSON string); freshly uploaded files are added to it.
    let thumbnailUrl = req.body.thumbnail;
    let galleryUrls = parseList(req.body.gallery, []);

    if (req.files) {
      if (USE_BLOB_STORAGE && blobUpload) {
        if (req.files.thumbnail && req.files.thumbnail[0]) {
          const file = req.files.thumbnail[0];
          thumbnailUrl = await blobUpload.uploadToBlob(
            file.buffer, file.originalname, file.mimetype, 'gym-classes/thumbnails'
          );
        }
        if (req.files.gallery) {
          galleryUrls = galleryUrls.concat(await blobUpload.uploadMultipleToBlob(req.files.gallery, 'gym-classes/gallery'));
        }
      } else {
        if (req.files.thumbnail && req.files.thumbnail[0]) {
          thumbnailUrl = `/uploads/${req.files.thumbnail[0].filename}`;
        }
        if (req.files.gallery) {
          galleryUrls = galleryUrls.concat(req.files.gallery.map(file => `/uploads/${file.filename}`));
        }
      }
    }

    // Parse JSON fields if they're strings
    let parsedSchedule = schedule;
    if (typeof schedule === 'string') {
      try {
        parsedSchedule = JSON.parse(schedule);
      } catch (e) {
        parsedSchedule = [];
      }
    }

    const parsedFeatures = parseList(features, []);
    const parsedRequirements = parseList(requirements, []);
    const parsedTags = parseList(tags, []);

    const classData = {
      name,
      description,
      shortDescription: shortDescription || undefined,
      thumbnail: thumbnailUrl || undefined,
      videoUrl: videoUrl || undefined,
      videoPoster: videoPoster || undefined,
      gallery: galleryUrls,
      schedule: Array.isArray(parsedSchedule) ? parsedSchedule : [],
      duration: duration ? parseInt(duration) : undefined,
      difficulty: difficulty || 'All Levels',
      capacity: capacity ? parseInt(capacity) : 20,
      room: req.body.room !== undefined ? String(req.body.room).trim() : '',
      features: parsedFeatures,
      requirements: parsedRequirements,
      category: category || 'Other',
      tags: parsedTags,
      isActive: isActive !== undefined ? isActive === 'true' || isActive === true : true,
      isFeatured: isFeatured !== undefined ? isFeatured === 'true' || isFeatured === true : false,
      order: order ? parseInt(order) : undefined,
      price: price ? parseFloat(price) : 0,
      currency: await currencyOr(currency)
    };

    // The gym's platform plan may cap how many classes it can run.
    const limit = await checkLimit('classes');
    if (!limit.ok) return res.status(403).json({ success: false, message: limit.message, code: limit.code });

    const gymClass = new GymClass(classData);
    await gymClass.save();

    // Populate instructor details
    await gymClass.populate('schedule.instructor', 'name role image');

    res.status(201).json({
      success: true,
      message: 'Class created successfully',
      data: gymClass
    });
  } catch (error) {
    console.error('Error creating class:', error);

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
        message: 'A class with this slug already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create class',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update class
const updateClass = async (req, res) => {
  try {
    const { id } = req.params;
    const gymClass = await GymClass.findById(id);

    if (!gymClass) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    const {
      name,
      description,
      shortDescription,
      videoUrl,
      videoPoster,
      schedule,
      duration,
      difficulty,
      capacity,
      features,
      requirements,
      category,
      tags,
      isActive,
      isFeatured,
      order,
      price,
      currency
    } = req.body;

    // Handle file uploads. A gallery list in the body (array or JSON string)
    // replaces the stored one; none keeps it. Newly uploaded files are added
    // to whichever applies, so uploading more photos never drops the rest.
    let thumbnailUrl = req.body.thumbnail || gymClass.thumbnail;
    let galleryUrls = parseList(req.body.gallery, gymClass.gallery || []);

    if (req.files) {
      if (USE_BLOB_STORAGE && blobUpload) {
        if (req.files.thumbnail && req.files.thumbnail[0]) {
          const file = req.files.thumbnail[0];
          thumbnailUrl = await blobUpload.uploadToBlob(
            file.buffer, file.originalname, file.mimetype, 'gym-classes/thumbnails'
          );
        }
        if (req.files.gallery) {
          galleryUrls = galleryUrls.concat(await blobUpload.uploadMultipleToBlob(req.files.gallery, 'gym-classes/gallery'));
        }
      } else {
        if (req.files.thumbnail && req.files.thumbnail[0]) {
          thumbnailUrl = `/uploads/${req.files.thumbnail[0].filename}`;
        }
        if (req.files.gallery) {
          galleryUrls = galleryUrls.concat(req.files.gallery.map(file => `/uploads/${file.filename}`));
        }
      }
    }

    // Parse JSON fields if they're strings
    let parsedSchedule = schedule || gymClass.schedule;
    if (schedule && typeof schedule === 'string') {
      try {
        parsedSchedule = JSON.parse(schedule);
      } catch (e) {
        parsedSchedule = gymClass.schedule;
      }
    }

    const parsedFeatures = parseList(features, gymClass.features);
    const parsedRequirements = parseList(requirements, gymClass.requirements);
    const parsedTags = parseList(tags, gymClass.tags);

    const updateData = {
      name: name || gymClass.name,
      description: description || gymClass.description,
      shortDescription: shortDescription !== undefined ? shortDescription : gymClass.shortDescription,
      thumbnail: thumbnailUrl,
      videoUrl: videoUrl !== undefined ? videoUrl : gymClass.videoUrl,
      videoPoster: videoPoster !== undefined ? videoPoster : gymClass.videoPoster,
      gallery: galleryUrls,
      schedule: parsedSchedule,
      duration: duration !== undefined ? parseInt(duration) : gymClass.duration,
      difficulty: difficulty || gymClass.difficulty,
      capacity: capacity !== undefined ? parseInt(capacity) : gymClass.capacity,
      room: req.body.room !== undefined ? String(req.body.room).trim() : gymClass.room,
      features: parsedFeatures,
      requirements: parsedRequirements,
      category: category || gymClass.category,
      tags: parsedTags,
      isActive: isActive !== undefined ? (isActive === 'true' || isActive === true) : gymClass.isActive,
      isFeatured: isFeatured !== undefined ? (isFeatured === 'true' || isFeatured === true) : gymClass.isFeatured,
      order: order !== undefined ? parseInt(order) : gymClass.order,
      price: price !== undefined ? parseFloat(price) : gymClass.price,
      currency: currency || gymClass.currency
    };

    const updatedClass = await GymClass.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true
    }).populate('schedule.instructor', 'name role image');

    res.status(200).json({
      success: true,
      message: 'Class updated successfully',
      data: updatedClass
    });
  } catch (error) {
    console.error('Error updating class:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update class',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle class active status.
//
// An explicit boolean in the body is honoured; a body with none (what the
// admin page's toggle button sends) flips the current value.
const toggleClassStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const wanted = readBoolean((req.body || {}).isActive);

    const current = await GymClass.findById(id).select('isActive');
    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    const isActive = wanted === null ? !current.isActive : wanted;
    const gymClass = await GymClass.findByIdAndUpdate(
      id,
      { isActive },
      { new: true, runValidators: true }
    ).populate('schedule.instructor', 'name role image');

    res.status(200).json({
      success: true,
      message: `Class ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: gymClass
    });
  } catch (error) {
    console.error('Error updating class status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update class status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle class featured status (same rule as toggleClassStatus).
const toggleClassFeatured = async (req, res) => {
  try {
    const { id } = req.params;
    const wanted = readBoolean((req.body || {}).isFeatured);

    const current = await GymClass.findById(id).select('isFeatured');
    if (!current) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    const isFeatured = wanted === null ? !current.isFeatured : wanted;
    const gymClass = await GymClass.findByIdAndUpdate(
      id,
      { isFeatured },
      { new: true, runValidators: true }
    ).populate('schedule.instructor', 'name role image');

    res.status(200).json({
      success: true,
      message: `Class ${isFeatured ? 'marked as featured' : 'removed from featured'} successfully`,
      data: gymClass
    });
  } catch (error) {
    console.error('Error updating class featured status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update class featured status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete class
const deleteClass = async (req, res) => {
  try {
    const { id } = req.params;

    const gymClass = await GymClass.findById(id);
    if (!gymClass) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    await GymClass.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Class deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting class:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete class',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  parseList,
  getActiveClasses,
  getFeaturedClasses,
  getClassesByCategory,
  getAllClasses,
  getClassById,
  getClassBySlug,
  createClass,
  updateClass,
  toggleClassStatus,
  toggleClassFeatured,
  deleteClass
};
