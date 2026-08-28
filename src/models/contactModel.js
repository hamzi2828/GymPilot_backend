const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  fullName: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true,
    maxLength: [100, 'Full name cannot exceed 100 characters']
  },
  emailAddress: {
    type: String,
    required: [true, 'Email address is required'],
    trim: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please provide a valid email address'
    ]
  },
  phoneNumber: {
    type: String,
    trim: true,
    maxLength: [20, 'Phone number cannot exceed 20 characters']
  },
  subject: {
    type: String,
    trim: true,
    maxLength: [200, 'Subject cannot exceed 200 characters'],
    default: 'General Inquiry'
  },
  message: {
    type: String,
    required: [true, 'Message is required'],
    trim: true,
    maxLength: [2000, 'Message cannot exceed 2000 characters']
  },
  status: {
    type: String,
    enum: ['new', 'in_progress', 'resolved', 'closed'],
    default: 'new'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  category: {
    type: String,
    enum: ['general', 'support', 'returns', 'wholesale', 'technical', 'feedback'],
    default: 'general'
  },
  source: {
    type: String,
    default: 'contact-form'
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  adminNotes: [{
    note: String,
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  responseEmailSent: {
    type: Boolean,
    default: false
  },
  responseEmailSentAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Index for efficient queries
contactSchema.index({ status: 1, createdAt: -1 });
contactSchema.index({ emailAddress: 1 });
contactSchema.index({ category: 1 });

// Static methods
contactSchema.statics.getContactsByStatus = function(status) {
  return this.find({ status }).sort({ createdAt: -1 });
};

contactSchema.statics.getContactsByCategory = function(category) {
  return this.find({ category }).sort({ createdAt: -1 });
};

contactSchema.statics.getUnreadContacts = function() {
  return this.find({ status: 'new' }).sort({ createdAt: -1 });
};

contactSchema.statics.getContactStats = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);

  const categoryStats = await this.aggregate([
    {
      $group: {
        _id: '$category',
        count: { $sum: 1 }
      }
    }
  ]);

  const total = await this.countDocuments();

  return {
    total,
    byStatus: stats,
    byCategory: categoryStats
  };
};

// Instance methods
contactSchema.methods.markAsRead = function() {
  if (this.status === 'new') {
    this.status = 'in_progress';
  }
  return this.save();
};

contactSchema.methods.addAdminNote = function(note, adminId) {
  this.adminNotes.push({
    note,
    addedBy: adminId,
    addedAt: new Date()
  });
  return this.save();
};

contactSchema.methods.markResponseSent = function() {
  this.responseEmailSent = true;
  this.responseEmailSentAt = new Date();
  return this.save();
};

module.exports = mongoose.model('Contact', contactSchema);