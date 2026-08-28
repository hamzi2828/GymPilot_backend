// src/models/blogCommentModel.js
const mongoose = require('mongoose');

const blogCommentSchema = new mongoose.Schema(
  {
    blogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Blog',
      required: [true, 'Blog ID is required']
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required']
    },
    content: {
      type: String,
      required: [true, 'Comment content is required'],
      trim: true,
      maxLength: [2000, 'Comment cannot exceed 2000 characters']
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BlogComment',
      default: null
    },
    likes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    isEdited: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['active', 'hidden', 'deleted'],
      default: 'active'
    }
  },
  { timestamps: true }
);

// Index for faster queries
blogCommentSchema.index({ blogId: 1, createdAt: -1 });
blogCommentSchema.index({ parentId: 1 });

const BlogComment = mongoose.models.BlogComment || mongoose.model('BlogComment', blogCommentSchema);

module.exports = BlogComment;
