const mongoose = require('mongoose');

const heroSlideSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  imageUrl: {
    type: String,
    required: [true, 'Image is required']
  },
  buttonText: {
    type: String,
    trim: true,
    maxlength: [30, 'Button text cannot exceed 30 characters']
  },
  buttonLink: {
    type: String,
    trim: true,
    maxlength: [200, 'Button link cannot exceed 200 characters']
  },
  secondButtonText: {
    type: String,
    trim: true,
    maxlength: [30, 'Second button text cannot exceed 30 characters']
  },
  secondButtonLink: {
    type: String,
    trim: true,
    maxlength: [200, 'Second button link cannot exceed 200 characters']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0,
    min: [0, 'Order cannot be negative']
  },
  ariaLabel: {
    type: String,
    trim: true,
    maxlength: [100, 'Aria label cannot exceed 100 characters']
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Index for performance
heroSlideSchema.index({ isActive: 1, order: 1 });
heroSlideSchema.index({ order: 1 });

// Static method to get active slides sorted by order
heroSlideSchema.statics.getActiveSlides = function() {
  return this.find({ isActive: true }).sort({ order: 1, createdAt: 1 });
};

// Static method to get all slides sorted by order
heroSlideSchema.statics.getAllSlidesSorted = function() {
  return this.find({}).sort({ order: 1, createdAt: 1 });
};

// Pre-save middleware to handle order
heroSlideSchema.pre('save', async function(next) {
  if (this.isNew && this.order === 0) {
    // Auto-assign order for new slides
    const lastSlide = await this.constructor.findOne({}).sort({ order: -1 });
    this.order = lastSlide ? lastSlide.order + 1 : 1;
  }
  next();
});

const HeroSlide = mongoose.model('HeroSlide', heroSlideSchema);

module.exports = HeroSlide;