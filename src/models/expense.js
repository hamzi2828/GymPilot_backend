// src/models/expense.js

const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    category: {
        type: String,
        required: true,
        trim: true,
        enum: ['Utilities', 'Rent', 'Supplies', 'Maintenance', 'Salaries', 'Marketing', 'Insurance', 'Taxes', 'Transportation', 'Equipment', 'Other'],
        default: 'Other'
    },
    date: {
        type: Date,
        required: true,
        default: Date.now
    },
    paymentMethod: {
        type: String,
        trim: true,
        enum: ['Cash', 'Credit Card', 'Debit Card', 'Bank Transfer', 'Check', 'Other'],
        default: 'Cash'
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
    receipt: {
        type: String,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
