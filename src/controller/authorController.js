// src/controller/authorController.js
const Author = require('../models/authorModel');
const mongoose = require('mongoose');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

// Get all authors with pagination and filtering
exports.getAllAuthors = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      search, 
      active, 
      sortBy = 'createdAt', 
      sortOrder = 'desc' 
    } = req.query;

    // Build query
    const query = {};
    
    if (active !== undefined) {
      query.active = active === 'true';
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { bio: { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute queries
    const [authors, total] = await Promise.all([
      Author.find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Author.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      message: 'Authors retrieved successfully',
      data: authors,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error getting authors:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve authors',
      error: error.message
    });
  }
};

// Get a single author by ID or slug
exports.getAuthorById = async (req, res) => {
  try {
    const { id } = req.params;
    
    let author;
    if (mongoose.Types.ObjectId.isValid(id)) {
      author = await Author.findById(id);
    } else {
      author = await Author.findOne({ slug: id });
    }
    
    if (!author) {
      return res.status(404).json({
        success: false,
        message: 'Author not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Author retrieved successfully',
      data: author
    });
  } catch (error) {
    console.error(`Error getting author ${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve author',
      error: error.message
    });
  }
};

// Create a new author
exports.createAuthor = async (req, res) => {
  try {
    const { 
      name, 
      email, 
      bio, 
      active = true
    } = req.body;

    console.log('createAuthor req.files:', req.files);
    console.log('createAuthor req.body:', req.body);
    
    // Handle file upload
    const avatarFile = req.files?.avatar?.[0];

    // Basic validation
    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: 'Name and email are required'
      });
    }

    // Check for duplicate email
    const existingAuthor = await Author.findOne({ email: email.toLowerCase() });
    if (existingAuthor) {
      return res.status(400).json({
        success: false,
        message: 'Author with this email already exists'
      });
    }


    // Create author data
    let avatarUrl = null;
    if (avatarFile) {
      if (USE_BLOB_STORAGE && blobUpload) {
        avatarUrl = await blobUpload.uploadToBlob(
          avatarFile.buffer, avatarFile.originalname, avatarFile.mimetype, 'authors'
        );
      } else {
        avatarUrl = `/uploads/${avatarFile.filename}`;
      }
    }

    const authorData = {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      bio: bio || '',
      avatar: avatarUrl,
      active
    };

    // Create and save author
    const author = new Author(authorData);
    await author.save();

    return res.status(201).json({
      success: true,
      message: 'Author created successfully',
      data: author
    });
  } catch (error) {
    console.error('Error creating author:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Author with this email or slug already exists'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to create author',
      error: error.message
    });
  }
};

// Update an author
exports.updateAuthor = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      email, 
      bio, 
      active
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid author ID format'
      });
    }

    // Check if author exists
    const existingAuthor = await Author.findById(id);
    if (!existingAuthor) {
      return res.status(404).json({
        success: false,
        message: 'Author not found'
      });
    }

    // Check for duplicate email (excluding current author)
    if (email && email !== existingAuthor.email) {
      const duplicateAuthor = await Author.findOne({ 
        email: email.toLowerCase(),
        _id: { $ne: id }
      });
      if (duplicateAuthor) {
        return res.status(400).json({
          success: false,
          message: 'Author with this email already exists'
        });
      }
    }

    // Handle file upload
    const avatarFile = req.files?.avatar?.[0];


    // Build update object
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (email !== undefined) updateData.email = email.toLowerCase().trim();
    if (bio !== undefined) updateData.bio = bio;
    if (avatarFile) {
      if (USE_BLOB_STORAGE && blobUpload) {
        updateData.avatar = await blobUpload.uploadToBlob(
          avatarFile.buffer, avatarFile.originalname, avatarFile.mimetype, 'authors'
        );
      } else {
        updateData.avatar = `/uploads/${avatarFile.filename}`;
      }
    }
    if (active !== undefined) updateData.active = active;

    // Update author
    const updatedAuthor = await Author.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Author updated successfully',
      data: updatedAuthor
    });
  } catch (error) {
    console.error(`Error updating author ${req.params.id}:`, error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Author with this email already exists'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to update author',
      error: error.message
    });
  }
};

// Delete an author
exports.deleteAuthor = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid author ID format'
      });
    }

    // Check if author has any blogs
    const Blog = require('../models/blogModel');
    const blogCount = await Blog.countDocuments({ author: id });
    
    if (blogCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete author. They have ${blogCount} blog(s) associated with them. Please reassign or delete those blogs first.`
      });
    }

    const author = await Author.findByIdAndDelete(id);

    if (!author) {
      return res.status(404).json({
        success: false,
        message: 'Author not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Author deleted successfully',
      data: {
        id: author._id,
        name: author.name,
        email: author.email
      }
    });
  } catch (error) {
    console.error(`Error deleting author ${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete author',
      error: error.message
    });
  }
};

// Toggle author active status
exports.toggleAuthorActive = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid author ID format'
      });
    }

    const author = await Author.findById(id);
    if (!author) {
      return res.status(404).json({
        success: false,
        message: 'Author not found'
      });
    }

    author.active = !author.active;
    await author.save();

    return res.status(200).json({
      success: true,
      message: `Author ${author.active ? 'activated' : 'deactivated'} successfully`,
      data: author
    });
  } catch (error) {
    console.error(`Error toggling author status ${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to toggle author status',
      error: error.message
    });
  }
};

// Get authors for dropdown (active authors only)
exports.getAuthorsForDropdown = async (req, res) => {
  try {
    const authors = await Author.find({ active: true })
      .select('_id name slug email')
      .sort({ name: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Authors for dropdown retrieved successfully',
      data: authors
    });
  } catch (error) {
    console.error('Error getting authors for dropdown:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve authors for dropdown',
      error: error.message
    });
  }
};