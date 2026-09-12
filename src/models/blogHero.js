const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const blogHeroSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    subtitle: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    backgroundImage: {
      type: String,
      required: true,
      trim: true,
    },
    // The buttons are optional: a hero can be a headline over a photo. An
    // empty text hides that button on the site; the defaults give a new hero
    // one sensible call to action.
    primaryButtonText: {
      type: String,
      default: 'Read the blog',
      trim: true,
      maxlength: 50,
    },
    primaryButtonLink: {
      type: String,
      default: '/blogs',
      trim: true,
    },
    secondaryButtonText: {
      type: String,
      default: '',
      trim: true,
      maxlength: 50,
    },
    secondaryButtonLink: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    sortOrder: {
      type: Number,
      default: 0,
    }
  },
  {
    timestamps: true,
    collection: 'blog_heroes'
  }
);

// Index for faster queries
blogHeroSchema.index({ isActive: 1 });
blogHeroSchema.index({ sortOrder: 1 });

// Pre-save middleware to ensure only one active hero at a time
blogHeroSchema.pre('save', async function(next) {
  if (this.isActive && this.isModified('isActive')) {
    // Deactivate all other heroes when this one is set to active
    await this.constructor.updateMany(
      { _id: { $ne: this._id } },
      { isActive: false }
    );
  }
  next();
});

// Static method to get active hero
blogHeroSchema.statics.getActiveHero = async function() {
  const hero = await this.findOne({ isActive: true }).lean();
  return hero;
};

// Static method to get all heroes sorted by order
blogHeroSchema.statics.getAllHeroes = async function() {
  const heroes = await this.find({})
    .sort({ sortOrder: 1, createdAt: -1 })
    .lean();
  return heroes;
};

// Instance method to toggle active status
blogHeroSchema.methods.toggleActive = async function() {
  if (!this.isActive) {
    // If activating this hero, deactivate all others first
    await this.constructor.updateMany(
      { _id: { $ne: this._id } },
      { isActive: false }
    );
  }
  this.isActive = !this.isActive;
  return await this.save();
};

module.exports = tenantModel('BlogHero', blogHeroSchema);