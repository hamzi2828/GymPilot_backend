// src/models/testimonialModel.js
//
// Member reviews shown in the homepage "Testimonials" section, fully managed
// from the admin panel (create / edit / reorder / toggle).

const mongoose = require('mongoose');

const testimonialSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [80, 'Name cannot exceed 80 characters'],
    },
    // e.g. "Member since 2022", "Competitive lifter", "Yoga regular"
    role: {
      type: String,
      trim: true,
      maxlength: [80, 'Role cannot exceed 80 characters'],
      default: '',
    },
    quote: {
      type: String,
      required: [true, 'Quote is required'],
      trim: true,
      maxlength: [600, 'Quote cannot exceed 600 characters'],
    },
    rating: {
      type: Number,
      default: 5,
      min: [1, 'Rating must be at least 1'],
      max: [5, 'Rating cannot exceed 5'],
    },
    imageUrl: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    order: {
      type: Number,
      default: 0,
      min: [0, 'Order cannot be negative'],
    },
  },
  { timestamps: true }
);

testimonialSchema.index({ isActive: 1, order: 1 });

testimonialSchema.statics.getActive = function () {
  return this.find({ isActive: true }).sort({ order: 1, createdAt: 1 });
};

testimonialSchema.statics.getAllSorted = function () {
  return this.find({}).sort({ order: 1, createdAt: 1 });
};

// New testimonials land at the end of the list unless an order was given.
testimonialSchema.pre('save', async function (next) {
  if (this.isNew && this.order === 0) {
    const last = await this.constructor.findOne({}).sort({ order: -1 });
    this.order = last ? last.order + 1 : 1;
  }
  next();
});

module.exports = mongoose.model('Testimonial', testimonialSchema);
