// src/models/purchase.js

const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema({
    description: {
        type: String,
        required: true,
        trim: true
    },
    quantity: {
        type: Number,
        required: true,
        min: 1
    },
    unitPrice: {
        type: Number,
        required: true,
        min: 0
    },
    total: {
        type: Number,
        required: true,
        min: 0
    }
}, { _id: false });

const purchaseSchema = new mongoose.Schema({
    vendorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vendor',
        required: true,
        index: true
    },
    invoiceNumber: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    purchaseDate: {
        type: Date,
        required: true,
        default: Date.now
    },
    dueDate: {
        type: Date,
        default: null
    },
    items: [purchaseItemSchema],
    subtotal: {
        type: Number,
        required: true,
        min: 0
    },
    tax: {
        type: Number,
        default: 0,
        min: 0
    },
    discount: {
        type: Number,
        default: 0,
        min: 0
    },
    total: {
        type: Number,
        required: true,
        min: 0
    },
    paidAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    pendingAmount: {
        type: Number,
        required: true,
        min: 0
    },
    paymentStatus: {
        type: String,
        enum: ['pending', 'partial', 'paid', 'overdue'],
        default: 'pending',
        index: true
    },
    notes: {
        type: String,
        default: '',
        trim: true
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Virtual for vendor population
purchaseSchema.virtual('vendor', {
    ref: 'Vendor',
    localField: 'vendorId',
    foreignField: '_id',
    justOne: true
});

// Ensure virtuals are included in JSON
purchaseSchema.set('toJSON', { virtuals: true });
purchaseSchema.set('toObject', { virtuals: true });

// Pre-save hook to calculate totals
purchaseSchema.pre('save', function(next) {
    // Calculate item totals
    this.items.forEach(item => {
        item.total = item.quantity * item.unitPrice;
    });

    // Calculate subtotal
    this.subtotal = this.items.reduce((sum, item) => sum + item.total, 0);

    // Calculate total with tax and discount
    const taxAmount = (this.subtotal * this.tax) / 100;
    this.total = this.subtotal + taxAmount - this.discount;

    // Calculate pending amount
    this.pendingAmount = this.total - this.paidAmount;

    // Update payment status
    if (this.paidAmount <= 0) {
        this.paymentStatus = this.dueDate && new Date(this.dueDate) < new Date() ? 'overdue' : 'pending';
    } else if (this.paidAmount >= this.total) {
        this.paymentStatus = 'paid';
    } else {
        this.paymentStatus = this.dueDate && new Date(this.dueDate) < new Date() ? 'overdue' : 'partial';
    }

    next();
});

module.exports = mongoose.models.Purchase || mongoose.model('Purchase', purchaseSchema);
