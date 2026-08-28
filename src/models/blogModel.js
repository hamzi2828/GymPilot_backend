// src/models/blogModel.js
const mongoose = require('mongoose');

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
