// src/models/pageModel.js
const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Page title is required'],
      trim: true,
      maxLength: [200, 'Title cannot exceed 200 characters']
    },
    slug: {
      type: String,
      required: [true, 'Page slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      enum: ['privacy-policy', 'faqs', 'terms-and-conditions', 'about-us', 'shipping-policy', 'return-policy', 'login-content', 'size-guide', 'contact-us']
    },
    content: {
      type: String,
      required: [true, 'Page content is required']
    },
    status: {
      type: String,
      enum: ['published', 'draft'],
      default: 'draft'
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
    }
  },
  { timestamps: true }
);

// Check if the model already exists before compiling it
const Page = mongoose.models.Page || mongoose.model('Page', pageSchema);

module.exports = Page;
