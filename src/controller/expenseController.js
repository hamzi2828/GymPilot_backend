// src/controller/expenseController.js

const Expense = require('../models/expense');
const { toPublicPath } = require('../helper/upload');

// Check if using Vercel Blob storage
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

const expenseController = {
    // GET /expenses - Get all expenses
    getAllExpenses: async (req, res) => {
        try {
            const expenses = await Expense.find({ isDeleted: { $ne: true } }).sort({ date: -1 });
            return res.status(200).json({
                message: 'Expenses fetched successfully',
                data: expenses
            });
        } catch (error) {
            console.error('Error fetching expenses:', error);
            return res.status(500).json({ message: 'Failed to fetch expenses' });
        }
    },

    // GET /expenses/:id - Get single expense
    getExpenseById: async (req, res) => {
        try {
            const { id } = req.params;
            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            return res.status(200).json({
                message: 'Expense fetched successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error fetching expense:', error);
            return res.status(500).json({ message: 'Failed to fetch expense' });
        }
    },

    // POST /expenses - Create new expense
    createExpense: async (req, res) => {
        try {
            const { title, amount, category, date, paymentMethod, reference, notes } = req.body;

            if (!title || !title.trim()) {
                return res.status(400).json({ message: 'Expense title is required' });
            }
            if (amount === undefined || amount === null || isNaN(amount)) {
                return res.status(400).json({ message: 'Valid amount is required' });
            }
            if (amount < 0) {
                return res.status(400).json({ message: 'Amount cannot be negative' });
            }
            if (!category || !category.trim()) {
                return res.status(400).json({ message: 'Category is required' });
            }

            // Handle receipt file upload
            let receiptUrl = null;
            if (req.file) {
                receiptUrl = toPublicPath(req.file.filename);
            }

            const expense = await Expense.create({
                title: title.trim(),
                amount: Number(amount),
                category: category.trim(),
                date: date ? new Date(date) : new Date(),
                paymentMethod: paymentMethod?.trim() || 'Cash',
                reference: reference?.trim() || '',
                notes: notes?.trim() || '',
                receipt: receiptUrl,
            });

            return res.status(201).json({
                message: 'Expense created successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error creating expense:', error);
            return res.status(500).json({ message: 'Failed to create expense' });
        }
    },

    // PUT /expenses/:id - Update expense
    updateExpense: async (req, res) => {
        try {
            const { id } = req.params;
            const { title, amount, category, date, paymentMethod, reference, notes, isActive, removeReceipt } = req.body;

            const expense = await Expense.findById(id);
            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            // Update fields
            if (title !== undefined) expense.title = title.trim();
            if (amount !== undefined) {
                if (isNaN(amount) || amount < 0) {
                    return res.status(400).json({ message: 'Valid positive amount is required' });
                }
                expense.amount = Number(amount);
            }
            if (category !== undefined) expense.category = category.trim();
            if (date !== undefined) expense.date = new Date(date);
            if (paymentMethod !== undefined) expense.paymentMethod = paymentMethod?.trim() || 'Cash';
            if (reference !== undefined) expense.reference = reference?.trim() || '';
            if (notes !== undefined) expense.notes = notes?.trim() || '';
            if (isActive !== undefined) expense.isActive = isActive;

            // Handle receipt file upload
            if (req.file) {
                expense.receipt = toPublicPath(req.file.filename);
            } else if (removeReceipt === 'true' || removeReceipt === true) {
                expense.receipt = null;
            }

            await expense.save();

            return res.status(200).json({
                message: 'Expense updated successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error updating expense:', error);
            return res.status(500).json({ message: 'Failed to update expense' });
        }
    },

    // DELETE /expenses/:id - Soft delete expense
    deleteExpense: async (req, res) => {
        try {
            const { id } = req.params;

            const expense = await Expense.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            expense.isDeleted = true;
            expense.deletedAt = new Date();
            expense.deletedBy = req.user?.id || req.user?._id || null;
            await expense.save();

            return res.status(200).json({
                message: 'Expense deleted successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error deleting expense:', error);
            return res.status(500).json({ message: 'Failed to delete expense' });
        }
    },

    // PUT /expenses/:id/restore - Restore soft-deleted expense
    restoreExpense: async (req, res) => {
        try {
            const { id } = req.params;

            const expense = await Expense.findOne({ _id: id, isDeleted: true });

            if (!expense) {
                return res.status(404).json({ message: 'Deleted expense not found' });
            }

            expense.isDeleted = false;
            expense.deletedAt = null;
            expense.deletedBy = null;
            await expense.save();

            return res.status(200).json({
                message: 'Expense restored successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error restoring expense:', error);
            return res.status(500).json({ message: 'Failed to restore expense' });
        }
    },

    // PUT /expenses/:id/status - Update expense status
    updateExpenseStatus: async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const expense = await Expense.findByIdAndUpdate(
                id,
                { isActive },
                { new: true }
            );

            if (!expense) {
                return res.status(404).json({ message: 'Expense not found' });
            }

            return res.status(200).json({
                message: 'Expense status updated successfully',
                data: expense
            });
        } catch (error) {
            console.error('Error updating expense status:', error);
            return res.status(500).json({ message: 'Failed to update expense status' });
        }
    },

    // GET /expenses/summary - Get expense summary/statistics
    getExpenseSummary: async (req, res) => {
        try {
            const { startDate, endDate } = req.query;

            let dateFilter = {};
            if (startDate || endDate) {
                dateFilter.date = {};
                if (startDate) dateFilter.date.$gte = new Date(startDate);
                if (endDate) dateFilter.date.$lte = new Date(endDate);
            }

            const expenses = await Expense.find({ ...dateFilter, isActive: true, isDeleted: { $ne: true } });

            const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

            const byCategory = expenses.reduce((acc, exp) => {
                acc[exp.category] = (acc[exp.category] || 0) + exp.amount;
                return acc;
            }, {});

            const byPaymentMethod = expenses.reduce((acc, exp) => {
                acc[exp.paymentMethod] = (acc[exp.paymentMethod] || 0) + exp.amount;
                return acc;
            }, {});

            return res.status(200).json({
                message: 'Expense summary fetched successfully',
                data: {
                    totalExpenses,
                    count: expenses.length,
                    byCategory,
                    byPaymentMethod
                }
            });
        } catch (error) {
            console.error('Error fetching expense summary:', error);
            return res.status(500).json({ message: 'Failed to fetch expense summary' });
        }
    },
};

module.exports = expenseController;
