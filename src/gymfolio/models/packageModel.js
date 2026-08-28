const mongoose = require('mongoose');

const packageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Package name is required'],
    trim: true,
    maxlength: [100, 'Package name cannot exceed 100 characters']
  },
  price: {
    type: String,
    required: [true, 'Price is required'],
    trim: true
  },
  currency: {
    type: String,
    required: [true, 'Currency is required'],
    default: 'PKR',
    trim: true
  },
  period: {
    type: String,
    required: [true, 'Period is required'],
    trim: true
  },
  features: {
    type: [String],
    required: [true, 'At least one feature is required'],
    validate: {
      validator: function(features) {
        return features && features.length > 0;
      },
      message: 'Package must have at least one feature'
    }
  },
  theme: {
    type: String,
    enum: {
      values: ['light', 'dark'],
      message: 'Theme must be either light or dark'
    },
    default: 'light'
  },
  badge: {
    type: String,
    trim: true,
    maxlength: [50, 'Badge text cannot exceed 50 characters']
  },
  supportingText: {
    type: String,
    trim: true,
    maxlength: [500, 'Supporting text cannot exceed 500 characters']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0,
    min: [0, 'Order cannot be negative']
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Index for performance
packageSchema.index({ isActive: 1, order: 1 });
packageSchema.index({ order: 1 });

// Static method to get active packages sorted by order
packageSchema.statics.getActivePackages = function() {
  return this.find({ isActive: true }).sort({ order: 1, createdAt: 1 });
};

// Static method to get all packages sorted by order
packageSchema.statics.getAllPackagesSorted = function() {
  return this.find({}).sort({ order: 1, createdAt: 1 });
};

// Pre-save middleware to handle order
packageSchema.pre('save', async function(next) {
  if (this.isNew && this.order === 0) {
    // Auto-assign order for new packages
    const lastPackage = await this.constructor.findOne({}).sort({ order: -1 });
    this.order = lastPackage ? lastPackage.order + 1 : 1;
  }
  next();
});

const Package = mongoose.model('Package', packageSchema);

module.exports = Package;
