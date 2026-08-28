// POS Order Model
const mongoose = require('mongoose');

const posOrderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: false
  },
  isLabour: {
    type: Boolean,
    default: false
  },
  labourDescription: {
    type: String,
    required: false
  },
  isOutsource: {
    type: Boolean,
    default: false
  },
  outsourceDescription: {
    type: String,
    required: false
  },
  costPrice: {
    type: Number,
    required: false
  },
  variantId: {
    type: String,
    required: false
  },
  sku: {
    type: String,
    required: false,
    default: ''
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
    required: false
  },
  color: {
    type: String,
    required: false
  },
  discount: {
    type: Number,
    default: 0
  }
});

const posOrderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: false
  },
  // Store customer info at time of order for invoice display
  customerInfo: {
    name: { type: String },
    phone: { type: String },
    vehicleName: { type: String }
  },
  items: [posOrderItemSchema],
  subtotal: {
    type: Number,
    required: true
  },
  tax: {
    type: Number,
    required: true,
    default: 0
  },
  appliedTaxes: [{
    taxId: { type: String },
    name: { type: String },
    rate: { type: Number },
    amount: { type: Number }
  }],
  discount: {
    type: Number,
    default: 0
  },
  discountType: {
    type: String,
    enum: ['fixed', 'percentage', null],
    default: null
  },
  discountReason: {
    type: String,
    default: ''
  },
  total: {
    type: Number,
    required: true
  },
  paymentMethod: {
    type: String,
    required: true,
    enum: ['cash', 'card', 'split', 'bank_transfer'],
    default: 'cash'
  },
  cashAmount: {
    type: Number,
    required: false
  },
  cardAmount: {
    type: Number,
    required: false
  },
  changeGiven: {
    type: Number,
    required: false
  },
  bankTransferScreenshot: {
    type: String,  // URL of the uploaded screenshot
    required: false
  },
  // Partial Payment Fields
  paidAmount: {
    type: Number,
    default: 0
  },
  pendingAmount: {
    type: Number,
    default: 0
  },
  // Payment History for tracking multiple partial payments
  paymentHistory: [{
    amount: {
      type: Number,
      required: true
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'bank_transfer'],
      required: true
    },
    paidAt: {
      type: Date,
      default: Date.now
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    note: {
      type: String
    },
    bankTransferScreenshot: {
      type: String
    }
  }],
  cashier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  orderStatus: {
    type: String,
    enum: ['completed', 'pending', 'refunded', 'cancelled'],
    default: 'completed',
    index: true
  },
  paymentStatus: {
    type: String,
    enum: ['completed', 'pending', 'partial', 'refunded'],
    default: 'completed'
  },
  notes: {
    type: String
  },
  completedAt: {
    type: Date,
    default: Date.now
  },
  refundedAt: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Index for fast queries
posOrderSchema.index({ createdAt: -1 });
posOrderSchema.index({ cashier: 1, createdAt: -1 });
posOrderSchema.index({ paymentStatus: 1, customer: 1 }); // For pending payments lookup
posOrderSchema.index({ customer: 1, paymentStatus: 1 }); // For customer pending payments

posOrderSchema.statics.generateOrderNumber = async function() {
  const count = await this.countDocuments();
  const timestamp = Date.now().toString().slice(-6);
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  return `POS-${date}-${timestamp}-${(count + 1).toString().padStart(4, '0')}`;
};

posOrderSchema.pre('save', async function(next) {
  if (!this.orderNumber) {
    this.orderNumber = await this.constructor.generateOrderNumber();
  }
  next();
});

module.exports = mongoose.models.POSOrder || mongoose.model('POSOrder', posOrderSchema);
