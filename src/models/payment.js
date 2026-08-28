// src/models/payment.js

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
    vendorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vendor',
        required: true,
        index: true
    },
    purchaseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Purchase',
        default: null,
        index: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'bank', 'cheque', 'other'],
        required: true
    },
    paymentDate: {
        type: Date,
        required: true,
        default: Date.now
    },
    reference: {
        type: String,
        default: '',
        trim: true
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
paymentSchema.virtual('vendor', {
    ref: 'Vendor',
    localField: 'vendorId',
    foreignField: '_id',
    justOne: true
});

// Virtual for purchase population
paymentSchema.virtual('purchase', {
    ref: 'Purchase',
    localField: 'purchaseId',
    foreignField: '_id',
    justOne: true
});

// Ensure virtuals are included in JSON
paymentSchema.set('toJSON', { virtuals: true });
paymentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
