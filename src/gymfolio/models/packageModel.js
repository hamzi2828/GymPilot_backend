const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');
const { catalogueCurrency } = require('../../services/currency');

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
  // Always the gym's currency (Settings → General); see catalogueCurrency.
  currency: {
    type: String,
    required: [true, 'Currency is required'],
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
  },

  // ---- What kind of thing this is, and how it is paid for ----------------
  //
  // `price` stays the display string the site has always shown; `priceAmount`
  // is its numeric mirror, kept in step on save, for anything that has to add
  // it up. `period` is still the label ("month", "year"); for recurring
  // packages `billing.interval` is what Stripe actually bills on.
  kind: {
    type: String,
    enum: ['membership', 'session_pack', 'day_pass', 'trial', 'pt_pack'],
    default: 'membership'
  },
  priceAmount: { type: Number, default: null },
  billing: {
    mode: { type: String, enum: ['one_time', 'recurring'], default: 'one_time' },
    interval: { type: String, enum: ['day', 'week', 'month', 'year'], default: 'month' },
    intervalCount: { type: Number, default: 1, min: 1 },
    trialDays: { type: Number, default: 0, min: 0 }
  },
  // Explicit validity in days (packs, passes, trials). 0 = derive from `period`.
  durationDays: { type: Number, default: 0, min: 0 },
  // Sessions on a pack. 0 = not a pack / unlimited.
  sessions: { type: Number, default: 0, min: 0 },
  // Charged once, on top of the first payment.
  joiningFee: { type: Number, default: 0, min: 0 }
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
  // Keep the numeric price in step with the display string.
  const { parseAmount } = require('../../helper/money');
  this.priceAmount = parseAmount(this.price);

  if (this.isNew && this.order === 0) {
    // Auto-assign order for new packages
    const lastPackage = await this.constructor.findOne({}).sort({ order: -1 });
    this.order = lastPackage ? lastPackage.order + 1 : 1;
  }
  next();
});

packageSchema.plugin(catalogueCurrency);

const Package = tenantModel('Package', packageSchema);

module.exports = Package;
