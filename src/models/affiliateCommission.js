// src/models/affiliateCommission.js
const mongoose = require('mongoose');

const affiliateCommissionSchema = new mongoose.Schema({
    affiliateUser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    code: { type: String, required: true, index: true },
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        required: true,
        unique: true
    },
    orderNumber: { type: String, required: true },
    orderSubtotal: { type: Number, required: true },
    commissionPercent: { type: Number, required: true },
    commissionAmount: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'approved', 'paid', 'reversed'],
        default: 'pending',
        index: true
    },
    paidAt: { type: Date, default: null },
    reversedAt: { type: Date, default: null },
    notes: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.models.AffiliateCommission
    || mongoose.model('AffiliateCommission', affiliateCommissionSchema);
