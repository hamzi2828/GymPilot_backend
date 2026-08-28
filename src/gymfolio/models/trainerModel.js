const mongoose = require('mongoose');

const trainerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Trainer name is required'],
    trim: true,
    maxlength: [100, 'Trainer name cannot exceed 100 characters']
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true
  },
  role: {
    type: String,
    required: [true, 'Role/Title is required'],
    trim: true,
    maxlength: [150, 'Role cannot exceed 150 characters']
  },
  bio: {
    type: String,
    trim: true,
    maxlength: [2000, 'Bio cannot exceed 2000 characters']
  },
  image: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    trim: true
  },
  specialties: {
    type: [String],
    default: []
  },
  certifications: {
    type: [String],
    default: []
  },
  experience: {
    type: Number,
    min: [0, 'Experience cannot be negative']
  },
  social: {
    twitter: { type: String, trim: true },
    instagram: { type: String, trim: true },
    facebook: { type: String, trim: true },
    youtube: { type: String, trim: true },
    linkedin: { type: String, trim: true }
  },
  availability: [{
    day: {
      type: String,
      enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    },
    startTime: String,
    endTime: String
  }],
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
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  totalClasses: {
    type: Number,
    default: 0,
    min: 0
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
trainerSchema.index({ isActive: 1, order: 1 });
trainerSchema.index({ slug: 1 });
trainerSchema.index({ isFeatured: 1 });

// Auto-generate slug from name
trainerSchema.pre('save', function(next) {
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  next();
});

// Auto-assign order for new trainers
trainerSchema.pre('save', async function(next) {
  if (this.isNew && this.order === 0) {
    const lastTrainer = await this.constructor.findOne({}).sort({ order: -1 });
    this.order = lastTrainer ? lastTrainer.order + 1 : 1;
  }
  next();
});

// Static methods
trainerSchema.statics.getActiveTrainers = function() {
  return this.find({ isActive: true }).sort({ order: 1, createdAt: 1 });
};

trainerSchema.statics.getFeaturedTrainers = function(limit = 4) {
  return this.find({ isActive: true, isFeatured: true })
    .sort({ order: 1, createdAt: 1 })
    .limit(limit);
};

const Trainer = mongoose.model('Trainer', trainerSchema);

module.exports = Trainer;
