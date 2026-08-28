const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
  day: {
    type: String,
    required: true,
    enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  instructor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trainer'
  },
  instructorName: {
    type: String,
    trim: true
  }
}, { _id: false });

const gymClassSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Class name is required'],
    trim: true,
    maxlength: [100, 'Class name cannot exceed 100 characters']
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    trim: true,
    maxlength: [5000, 'Description cannot exceed 5000 characters']
  },
  shortDescription: {
    type: String,
    trim: true,
    maxlength: [500, 'Short description cannot exceed 500 characters']
  },
  thumbnail: {
    type: String,
    trim: true
  },
  videoUrl: {
    type: String,
    trim: true
  },
  videoPoster: {
    type: String,
    trim: true
  },
  gallery: {
    type: [String],
    default: []
  },
  schedule: {
    type: [scheduleSchema],
    default: []
  },
  duration: {
    type: Number,
    min: [1, 'Duration must be at least 1 minute'],
    max: [300, 'Duration cannot exceed 300 minutes']
  },
  difficulty: {
    type: String,
    enum: {
      values: ['Beginner', 'Intermediate', 'Advanced', 'All Levels'],
      message: 'Difficulty must be Beginner, Intermediate, Advanced, or All Levels'
    },
    default: 'All Levels'
  },
  capacity: {
    type: Number,
    min: [1, 'Capacity must be at least 1'],
    default: 20
  },
  features: {
    type: [String],
    default: []
  },
  requirements: {
    type: [String],
    default: []
  },
  category: {
    type: String,
    trim: true,
    enum: ['Yoga', 'Cardio', 'Strength', 'Boxing', 'HIIT', 'Dance', 'Martial Arts', 'Other'],
    default: 'Other'
  },
  tags: {
    type: [String],
    default: []
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    default: 0,
    min: [0, 'Order cannot be negative']
  },
  enrolledCount: {
    type: Number,
    default: 0,
    min: 0
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  reviewsCount: {
    type: Number,
    default: 0,
    min: 0
  },
  price: {
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    default: 'PKR',
    trim: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
gymClassSchema.index({ isActive: 1, order: 1 });
gymClassSchema.index({ slug: 1 });
gymClassSchema.index({ isFeatured: 1 });
gymClassSchema.index({ category: 1 });
gymClassSchema.index({ difficulty: 1 });

// Auto-generate slug from name
gymClassSchema.pre('save', function(next) {
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  next();
});

// Auto-assign order for new classes
gymClassSchema.pre('save', async function(next) {
  if (this.isNew && this.order === 0) {
    const lastClass = await this.constructor.findOne({}).sort({ order: -1 });
    this.order = lastClass ? lastClass.order + 1 : 1;
  }
  next();
});

// Virtual for availability text
gymClassSchema.virtual('availabilityText').get(function() {
  if (!this.schedule || this.schedule.length === 0) {
    return 'Schedule not available';
  }
  const days = this.schedule.map(s => s.day).join(', ');
  return days;
});

// Static methods
gymClassSchema.statics.getActiveClasses = function() {
  return this.find({ isActive: true })
    .populate('schedule.instructor', 'name role image')
    .sort({ order: 1, createdAt: 1 });
};

gymClassSchema.statics.getFeaturedClasses = function(limit = 4) {
  return this.find({ isActive: true, isFeatured: true })
    .populate('schedule.instructor', 'name role image')
    .sort({ order: 1, createdAt: 1 })
    .limit(limit);
};

gymClassSchema.statics.getClassesByCategory = function(category) {
  return this.find({ isActive: true, category })
    .populate('schedule.instructor', 'name role image')
    .sort({ order: 1, createdAt: 1 });
};

const GymClass = mongoose.model('GymClass', gymClassSchema);

module.exports = GymClass;
