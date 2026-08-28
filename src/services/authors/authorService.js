// src/services/authors/authorService.js
const Author = require('../../models/authorModel');
const mongoose = require('mongoose');

/**
 * Get all authors with pagination and filtering
 * @param {Object} queryParams - Query parameters
 * @returns {Promise<Object>} Authors with pagination info
 */
const getAllAuthorsService = async (queryParams = {}) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      active,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = queryParams;

    // Build query
    const query = {};
    
    if (active !== undefined) {
      query.active = active === 'true' || active === true;
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

    // Execute queries in parallel
    const [authors, total] = await Promise.all([
      Author.find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Author.countDocuments(query)
    ]);

    return {
      success: true,
      data: authors,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1
      }
    };
  } catch (error) {
    throw new Error(`Failed to fetch authors: ${error.message}`);
  }
};

/**
 * Get a single author by ID or slug
 * @param {String} identifier - Author ID or slug
 * @returns {Promise<Object>} Author details
 */
const getAuthorByIdService = async (identifier) => {
  try {
    let author;
    
    if (mongoose.Types.ObjectId.isValid(identifier)) {
      author = await Author.findById(identifier);
    } else {
      author = await Author.findOne({ slug: identifier });
    }
    
    if (!author) {
      throw new Error('Author not found');
    }

    return {
      success: true,
      data: author
    };
  } catch (error) {
    throw new Error(`Failed to fetch author: ${error.message}`);
  }
};

/**
 * Create a new author
 * @param {Object} authorData - Author data
 * @param {Object} files - Uploaded files
 * @returns {Promise<Object>} Created author
 */
const createAuthorService = async (authorData, files = {}) => {
  try {
    const { 
      name, 
      email, 
      bio, 
      active = true
    } = authorData;

    // Validate required fields
    if (!name || !email) {
      throw new Error('Name and email are required');
    }

    // Check for duplicate email
    const existingAuthor = await Author.findOne({ email: email.toLowerCase() });
    if (existingAuthor) {
      throw new Error('Author with this email already exists');
    }

    // Handle file upload
    const avatarFile = files?.avatar?.[0];


    // Create author data
    const newAuthorData = {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      bio: bio || '',
      avatar: avatarFile ? `/uploads/${avatarFile.filename}` : null,
      active
    };

    // Create and save author
    const author = new Author(newAuthorData);
    await author.save();

    return {
      success: true,
      data: author
    };
  } catch (error) {
    throw new Error(`Failed to create author: ${error.message}`);
  }
};

/**
 * Update an author
 * @param {String} authorId - Author ID
 * @param {Object} updateData - Updated author data
 * @param {Object} files - Uploaded files
 * @returns {Promise<Object>} Updated author
 */
const updateAuthorService = async (authorId, updateData, files = {}) => {
  try {
    // Validate author ID
    if (!mongoose.Types.ObjectId.isValid(authorId)) {
      throw new Error('Invalid author ID format');
    }

    // Check if author exists
    const existingAuthor = await Author.findById(authorId);
    if (!existingAuthor) {
      throw new Error('Author not found');
    }

    const { 
      name, 
      email, 
      bio, 
      active
    } = updateData;

    // Check for duplicate email (excluding current author)
    if (email && email !== existingAuthor.email) {
      const duplicateAuthor = await Author.findOne({ 
        email: email.toLowerCase(),
        _id: { $ne: authorId }
      });
      if (duplicateAuthor) {
        throw new Error('Author with this email already exists');
      }
    }

    // Handle file upload
    const avatarFile = files?.avatar?.[0];


    // Build update object
    const updateObject = {};
    if (name !== undefined) updateObject.name = name.trim();
    if (email !== undefined) updateObject.email = email.toLowerCase().trim();
    if (bio !== undefined) updateObject.bio = bio;
    if (avatarFile) updateObject.avatar = `/uploads/${avatarFile.filename}`;
    if (active !== undefined) updateObject.active = active;

    // Update author
    const updatedAuthor = await Author.findByIdAndUpdate(
      authorId,
      updateObject,
      { new: true, runValidators: true }
    );

    return {
      success: true,
      data: updatedAuthor
    };
  } catch (error) {
    throw new Error(`Failed to update author: ${error.message}`);
  }
};

/**
 * Delete an author
 * @param {String} authorId - Author ID
 * @returns {Promise<Object>} Deletion result
 */
const deleteAuthorService = async (authorId) => {
  try {
    // Validate author ID
    if (!mongoose.Types.ObjectId.isValid(authorId)) {
      throw new Error('Invalid author ID format');
    }

    // Check if author has any blogs
    const Blog = require('../../models/blogModel');
    const blogCount = await Blog.countDocuments({ author: authorId });
    
    if (blogCount > 0) {
      throw new Error(`Cannot delete author. They have ${blogCount} blog(s) associated with them. Please reassign or delete those blogs first.`);
    }

    const author = await Author.findByIdAndDelete(authorId);

    if (!author) {
      throw new Error('Author not found');
    }

    return {
      success: true,
      message: 'Author deleted successfully',
      data: {
        id: author._id,
        name: author.name,
        email: author.email
      }
    };
  } catch (error) {
    throw new Error(`Failed to delete author: ${error.message}`);
  }
};

/**
 * Toggle author active status
 * @param {String} authorId - Author ID
 * @returns {Promise<Object>} Updated author
 */
const toggleAuthorActiveService = async (authorId) => {
  try {
    // Validate author ID
    if (!mongoose.Types.ObjectId.isValid(authorId)) {
      throw new Error('Invalid author ID format');
    }

    const author = await Author.findById(authorId);
    if (!author) {
      throw new Error('Author not found');
    }

    author.active = !author.active;
    await author.save();

    return {
      success: true,
      message: `Author ${author.active ? 'activated' : 'deactivated'} successfully`,
      data: author
    };
  } catch (error) {
    throw new Error(`Failed to toggle author status: ${error.message}`);
  }
};

/**
 * Get authors for dropdown (active authors only)
 * @returns {Promise<Object>} Active authors list
 */
const getAuthorsForDropdownService = async () => {
  try {
    const authors = await Author.find({ active: true })
      .select('_id name slug email')
      .sort({ name: 1 })
      .lean();

    return {
      success: true,
      data: authors
    };
  } catch (error) {
    throw new Error(`Failed to fetch authors for dropdown: ${error.message}`);
  }
};

module.exports = {
  getAllAuthorsService,
  getAuthorByIdService,
  createAuthorService,
  updateAuthorService,
  deleteAuthorService,
  toggleAuthorActiveService,
  getAuthorsForDropdownService
};