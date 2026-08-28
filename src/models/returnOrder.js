const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  variantId: {
    type: String,
    required: true
  },
  sku: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  price: {
    type: Number,
    required: true
  },
  size: {
    type: String,
    required: true
  },
  color: {
    type: String,
    required: true
  }
});

const returnOrderSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    unique: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  items: [returnItemSchema],
  reason: {
    type: String,
    required: true,
    enum: [
      'defective',
      'wrong_item',
      'not_as_described',
      'size_issue',
      'changed_mind',
      'quality_issue',
      'damaged_in_shipping',
      'other'
    ]
  },
  reasonDescription: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'approved', 'rejected', 'received', 'refunded'],
    default: 'pending'
  },
  refundAmount: {
    type: Number,
    required: true
  },
  adminNotes: {
    type: String,
    default: ''
  },
  approvedAt: {
    type: Date
  },
  rejectedAt: {
    type: Date
  },
  receivedAt: {
    type: Date
  },
  refundedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Generate return number before saving
returnOrderSchema.pre('save', async function(next) {
  if (!this.returnNumber) {
    const count = await this.constructor.countDocuments();
    const timestamp = Date.now().toString().slice(-6);
    this.returnNumber = `RET-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

returnOrderSchema.statics.generateReturnNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString().slice(-6);
  return `RET-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
};

module.exports = mongoose.models.ReturnOrder || mongoose.model('ReturnOrder', returnOrderSchema);
