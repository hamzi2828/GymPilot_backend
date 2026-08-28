// src/models/bank.js

const mongoose = require('mongoose');

const bankSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    accountNumber: {
        type: String,
        required: true,
        trim: true
    },
    accountTitle: {
        type: String,
        required: true,
        trim: true
    },
    branch: {
        type: String,
        default: '',
        trim: true
    },
    iban: {
        type: String,
        default: '',
        trim: true
    },
    notes: {
        type: String,
        default: '',
        trim: true
    },
    // Scannable payment barcode / QR image for this account.
    qrCodeUrl: {
        type: String,
        default: '',
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.models.Bank || mongoose.model('Bank', bankSchema);
