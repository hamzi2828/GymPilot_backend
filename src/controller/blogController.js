// src/controller/blogController.js
const {
  createBlogService,
  updateBlogService,
  getAllBlogsService,
  getBlogByIdService,
  deleteBlogService,
  incrementViewsService,
  getBlogsByCategoryService
} = require('../services/blogs');
const Blog = require('../models/blogModel');
const BlogCategory = require('../models/BlogCategory');


// Get featured blogs (latest 3 published blogs)
exports.getFeaturedBlogs = async (req, res) => {
  try {
    
    const limit = parseInt(req.query.limit) || 3;
    
    // Get latest published blogs
    const blogs = await Blog.find({ 
      status: 'published' 
    })
    .populate('categoryId', 'name')
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(limit);
    
    return res.status(200).json({
      success: true,
      message: 'Featured blogs retrieved successfully',
      data: blogs
    });
  } catch (error) {
    console.error('Error getting featured blogs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve featured blogs',
      error: error.message
    });
  }
};

// Get all blogs with pagination and filtering
exports.getAllBlogs = async (req, res) => {
  try {
    const result = await getAllBlogsService(req.query);
    
    return res.status(200).json({
      success: true,
      message: 'Blogs retrieved successfully',
      ...result
    });
  } catch (error) {
    console.error('Error getting blogs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve blogs',
      error: error.message
    });
  }
};

// Get a single blog by ID
exports.getBlogById = async (req, res) => {
  try {
    const { id } = req.params;
    const incrementView = req.query.view === 'true';

    const result = await getBlogByIdService(id, incrementView);

    return res.status(200).json({
      success: true,
      message: 'Blog retrieved successfully',
      ...result
    });
  } catch (error) {
    console.error(`Error getting blog ${req.params.id}:`, error);

    if (error.message === 'Blog not found') {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve blog',
      error: error.message
    });
  }
};

// Get a single blog by slug
exports.getBlogBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const incrementView = req.query.view === 'true';

    // Find blog by slug
    const blog = await Blog.findOne({
      slug: slug,
      status: 'published'
    })
    .populate('categoryId', 'name')
    .populate('author', 'name email bio avatar avatarUrl blogCount createdAt');

    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found'
      });
    }

    // Calculate actual blog count for the author
    if (blog.author) {
      const actualBlogCount = await Blog.countDocuments({
        author: blog.author._id,
        status: 'published'
      });
      blog.author.blogCount = actualBlogCount;
    }

    // Increment view count if requested
    if (incrementView) {
      blog.views = (blog.views || 0) + 1;
      await blog.save();
    }

    return res.status(200).json({
      success: true,
      message: 'Blog retrieved successfully',
      data: blog
    });
  } catch (error) {
    console.error(`Error getting blog by slug ${req.params.slug}:`, error);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve blog',
      error: error.message
    });
  }
};

// Create a new blog
exports.createBlog = async (req, res) => {
  try {
    const savedBlog = await createBlogService(req.body, req.files, req.user._id);
    
    res.status(201).json({
      success: true,
      message: 'Blog created successfully',
      data: savedBlog
    });
  } catch (error) {
    console.error('Error creating blog:', error);
    
    if (error.message.includes('required') || error.message.includes('Invalid')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    if (error.message === 'Category not found') {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create blog',
      error: error.message
    });
  }
};

// Update a blog
exports.updateBlog = async (req, res) => {
  try {
    const { id } = req.params;
    
    const updatedBlog = await updateBlogService(id, req.body, req.files);
    
    return res.status(200).json({
      success: true,
      message: 'Blog updated successfully',
      data: updatedBlog
    });
  } catch (error) {
    console.error(`Error updating blog ${req.params.id}:`, error);
    
    if (error.message === 'Blog not found' || error.message === 'Category not found') {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    if (error.message.includes('Invalid') || error.message.includes('duplicate')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to update blog',
      error: error.message
    });
  }
};

// Delete a blog
exports.deleteBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const deleteFiles = req.query.deleteFiles !== 'false';
    
    const result = await deleteBlogService(id, deleteFiles);
    
    return res.status(200).json(result);
  } catch (error) {
    console.error(`Error deleting blog ${req.params.id}:`, error);
    
    if (error.message === 'Blog not found') {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    if (error.message.includes('Invalid')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to delete blog',
      error: error.message
    });
  }
};

// Increment blog view count
exports.incrementViews = async (req, res) => {
  try {
    const { id } = req.params;
    const userIp = req.ip || req.connection.remoteAddress;
    const userId = req.user ? req.user._id : null;
    
    const result = await incrementViewsService(id, userIp, userId);
    
    return res.status(200).json(result);
  } catch (error) {
    console.error(`Error incrementing views for blog ${req.params.id}:`, error);
    
    if (error.message === 'Blog not found') {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    if (error.message.includes('Invalid')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to increment view count',
      error: error.message
    });
  }
};

// Get blogs by category
exports.getBlogsByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const options = {
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
      exclude: req.query.exclude
    };
    
    const result = await getBlogsByCategoryService(categoryId, options);
    
    return res.status(200).json({
      success: true,
      message: 'Blogs retrieved successfully',
      ...result
    });
  } catch (error) {
    console.error(`Error getting blogs for category ${req.params.categoryId}:`, error);
    
    if (error.message === 'Category not found') {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve blogs by category',
      error: error.message
    });
  }
};

// Toggle featured status of a blog
exports.toggleFeatured = async (req, res) => {
  try {
    const { id } = req.params;
    const { featured } = req.body;
    
    const blog = await Blog.findByIdAndUpdate(
      id,
      { featured: Boolean(featured) },
      { new: true, runValidators: true }
    ).populate('categoryId', 'name').populate('author', 'name');
    
    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found'
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Blog featured status updated successfully',
      data: blog
    });
  } catch (error) {
    console.error(`Error toggling blog featured status ${req.params.id}:`, error);
    
    if (error.message.includes('Cast to ObjectId failed')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid blog ID'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to update blog featured status',
      error: error.message
    });
  }
};

// Toggle publish/draft status of a blog
exports.toggleStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!status || !['published', 'draft'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status must be either "published" or "draft"'
      });
    }

    const blog = await Blog.findByIdAndUpdate(
      id,
      { status: status },
      { new: true, runValidators: true }
    ).populate('categoryId', 'name').populate('author', 'name');
    
    if (!blog) {
      return res.status(404).json({
        success: false,
        message: 'Blog not found'
      });
    }
    
    return res.status(200).json({
      success: true,
      message: `Blog ${status === 'published' ? 'published' : 'saved as draft'} successfully`,
      data: blog
    });
  } catch (error) {
    console.error(`Error toggling blog status ${req.params.id}:`, error);
    
    if (error.message.includes('Cast to ObjectId failed')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid blog ID'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Failed to update blog status',
      error: error.message
    });
  }
};

// Get featured categories with their blogs (up to 6 blogs per category)
exports.getFeaturedCategoriesWithBlogs = async (req, res) => {
  try {

    // Get featured categories
    const featuredCategories = await BlogCategory.find({
      featured: true,
      active: true
    }).sort({ createdAt: -1 });

    // For each featured category, get up to 6 published blogs
    const categoriesWithBlogs = await Promise.all(
      featuredCategories.map(async (category) => {
        const blogs = await Blog.find({
          categoryId: category._id,
          status: 'published'
        })
        .populate('author', 'name email avatar bio blogCount createdAt')
        .sort({ createdAt: -1 })
        .limit(6)
        .select('title content image thumbnail slug views createdAt updatedAt excerpt readingTime');

        // Calculate actual blog counts for authors
        for (let blog of blogs) {
          if (blog.author) {
            const actualBlogCount = await Blog.countDocuments({
              author: blog.author._id,
              status: 'published'
            });
            blog.author.blogCount = actualBlogCount;
          }
        }

        return {
          id: category._id,
          name: category.name,
          slug: category.slug,
          description: category.description,
          thumbnailUrl: category.thumbnailUrl,
          bannerUrl: category.bannerUrl,
          blogs: blogs
        };
      })
    );

    return res.status(200).json({
      success: true,
      message: 'Featured categories with blogs retrieved successfully',
      data: categoriesWithBlogs
    });
  } catch (error) {
    console.error('Error getting featured categories with blogs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve featured categories with blogs',
      error: error.message
    });
  }
};

// Get featured categories with blog (single blog per category)
exports.getFeaturedCategoriesWithBlog = async (req, res) => {
  try {

    // Get featured categories
    const featuredCategories = await BlogCategory.find({
      featured: true,
      active: true
    }).sort({ createdAt: -1 });

    // For each featured category, get the latest published blog
    const categoriesWithBlog = await Promise.all(
      featuredCategories.map(async (category) => {
        const blog = await Blog.findOne({
          categoryId: category._id,
          status: 'published'
        })
        .populate('author', 'name email avatar')
        .sort({ createdAt: -1 })
        .select('title content image thumbnail slug views createdAt updatedAt excerpt readingTime');

        return {
          id: category._id,
          name: category.name,
          slug: category.slug,
          description: category.description,
          thumbnailUrl: category.thumbnailUrl,
          bannerUrl: category.bannerUrl,
          blog: blog // Single blog instead of array
        };
      })
    );

    // Filter out categories that don't have any published blogs
    const categoriesWithValidBlogs = categoriesWithBlog.filter(category => category.blog !== null);

    return res.status(200).json({
      success: true,
      message: 'Featured categories with blog retrieved successfully',
      data: categoriesWithValidBlogs
    });
  } catch (error) {
    console.error('Error getting featured categories with blog:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve featured categories with blog',
      error: error.message
    });
  }
};