// src/models/authorModel.js
const mongoose = require('mongoose');

const authorSchema = new mongoose.Schema(
  {
    name: { 
      type: String, 
      required: [true, 'Author name is required'], 
      trim: true,
      maxLength: [100, 'Name cannot exceed 100 characters']
    },

    email: { 
      type: String, 
      required: [true, 'Email is required'], 
      unique: true, 
      lowercase: true, 
      trim: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    bio: { 
      type: String, 
      default: '', 
      trim: true,
      maxLength: [500, 'Bio cannot exceed 500 characters']
    },
    avatar: { 
      type: String, 
      default: null 
    },
    active: { 
      type: Boolean, 
      default: true 
    },
    blogCount: { 
      type: Number, 
      default: 0 
    }
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Create slug from name
authorSchema.pre('save', function(next) {
  if (!this.isModified('name')) {
    return next();
  }
  
  this.slug = this.name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 50);
  
  next();
});

// Virtual for full avatar URL
authorSchema.virtual('avatarUrl').get(function() {
  if (this.avatar && this.avatar.startsWith('/uploads/')) {
    return this.avatar;
  }
  return this.avatar || null;
});

// Static method to increment blog count
authorSchema.statics.incrementBlogCount = async function(authorId) {
  return this.findByIdAndUpdate(
    authorId,
    { $inc: { blogCount: 1 } },
    { new: true }
  );
};

// Static method to decrement blog count
authorSchema.statics.decrementBlogCount = async function(authorId) {
  return this.findByIdAndUpdate(
    authorId,
    { $inc: { blogCount: -1 } },
    { new: true }
  );
};

// Index for better performance
authorSchema.index({ name: 1, email: 1 });
authorSchema.index({ slug: 1, active: 1 });

const Author = mongoose.model('Author', authorSchema);

module.exports = Author;