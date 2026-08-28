// packageRegistrationModel.js - Package Registration Model for GymFolio/Gymwear

const mongoose = require('mongoose');

const packageRegistrationSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      trim: true,
      maxlength: [100, 'Username cannot exceed 100 characters']
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      maxlength: [20, 'Phone number cannot exceed 20 characters']
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email address'
      ]
    },
    platform: {
      type: String,
      required: [true, 'Platform is required'],
      enum: {
        values: ['gymwear', 'gymfolio'],
        message: 'Platform must be either gymwear or gymfolio'
      }
    },
    status: {
      type: String,
      enum: ['pending', 'contacted', 'registered', 'rejected'],
      default: 'pending'
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'Notes cannot exceed 1000 characters']
    }
  },
  {
    timestamps: true
  }
);

// Create index for faster queries
packageRegistrationSchema.index({ platform: 1, createdAt: -1 });
packageRegistrationSchema.index({ email: 1 });
packageRegistrationSchema.index({ status: 1 });

const PackageRegistration = mongoose.model('PackageRegistration', packageRegistrationSchema);

module.exports = PackageRegistration;
