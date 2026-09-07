const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');

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
  // Personal training: whether members can book them one-to-one, what a
  // session costs when not on a pack, and their cut of each completed
  // session (null = the gym's default in Settings).
  acceptsPt: { type: Boolean, default: true },
  ptRate: { type: Number, default: 0, min: 0 },
  commissionPercent: { type: Number, default: null, min: 0, max: 100 },

  // Short human-readable staff ID the front desk can search by ("TR-004"),
  // used by the attendance app when the fingerprint reader is unavailable.
  // Assigned on demand -- see ensureStaffCode() in peopleDirectory.js.
  staffCode: {
    type: String,
    default: null,
    trim: true
  },

  // The staff account this public trainer profile belongs to, when the
  // trainer is also employed here.
  //
  // Why this exists: a trainer who works at the gym is one human held in two
  // records -- this one, which the website renders, and a User carrying their
  // pay rate and roster. Attendance files their punches against THIS record
  // (resolvePerson checks Trainer first), so before this link existed their
  // hours could never reach the payroll figure on the accounts screen, which
  // only ever looked at User ids. The result was a wage bill that silently
  // omitted the gym's trainers.
  //
  // Optional, and null on every existing row: a trainer who is not on the
  // payroll -- a visiting or self-employed coach -- is left unlinked, and the
  // accounts screen reports how many of those there are rather than pretending
  // the total covers them.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
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
// Partial: staffCode is null until the attendance app first needs one, and a
// plain unique index would reject every trainer after the first.
trainerSchema.index(
  { staffCode: 1 },
  { unique: true, partialFilterExpression: { staffCode: { $type: 'string' } } }
);

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

const Trainer = tenantModel('Trainer', trainerSchema);

module.exports = Trainer;
