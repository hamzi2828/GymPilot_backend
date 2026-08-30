// src/models/blogModel.js
const mongoose = require('mongoose');

// Imported for its side effect: registering the 'Author' model that the
// `author` field below refs.
//
// Without this, GET /blogs returned a 500 -- "Schema hasn't been registered
// for model 'Author'" -- and the public blog listing was down. The write paths
// got away with it because createBlogService and updateBlogService require the
// model themselves, so by the time anything was saved it existed; nothing on
// the read path ever did, and populate('author') has no model to populate
// from. Requiring it here ties registration to the schema that declares the
// ref, so it cannot go missing again depending on which endpoint ran first.
require('./authorModel');

const blogSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Blog title is required'],
      trim: true,
      maxLength: [200, 'Title cannot exceed 200 characters']
    },
    content: {
      type: String,
      required: [true, 'Blog content is required']
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BlogCategory',
      required: [true, 'Blog category is required']
    },
    status: {
      type: String,
      enum: ['published', 'draft'],
      default: 'draft'
    },
    featured: {
      type: Boolean,
      default: false
    },
    image: {
      type: String,
      required: [true, 'Blog image is required']
    },
    thumbnail: {
      type: String,
      default: null
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Author',
      required: false // Optional author field
    },
    tags: [{
      type: String,
      trim: true
    }],
    views: {
      type: Number,
      default: 0
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true
    },
    // SEO Fields
    metaTitle: {
      type: String,
      trim: true,
      maxLength: [120, 'Meta title cannot exceed 120 characters']
    },
    metaDescription: {
      type: String,
      trim: true,
      maxLength: [320, 'Meta description cannot exceed 320 characters']
    },
    metaKeywords: {
      type: String,
      trim: true
    },
    metaSchema: {
      type: String,
      trim: true
    }
  },
  { timestamps: true }
);

// Create slug from title
blogSchema.pre('save', function(next) {
  if (!this.isModified('title')) {
    return next();
  }
  this.slug = this.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  
  // Add a timestamp to ensure uniqueness
  this.slug = `${this.slug}-${Date.now().toString().slice(-6)}`;
  next();
});

// Check if the model already exists before compiling it
const Blog = mongoose.models.Blog || mongoose.model('Blog', blogSchema);

module.exports = Blog;
