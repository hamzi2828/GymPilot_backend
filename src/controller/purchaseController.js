// src/controller/purchaseController.js

const Purchase = require('../models/purchase');
const Payment = require('../models/payment');
const Vendor = require('../models/vendor');

const purchaseController = {
    // GET /purchases - Get all purchases
    getAllPurchases: async (req, res) => {
        try {
            const { vendorId, status, startDate, endDate } = req.query;

            const query = { isDeleted: { $ne: true } };

            if (vendorId) {
                query.vendorId = vendorId;
            }

            if (status) {
                query.paymentStatus = status;
            }

            if (startDate || endDate) {
                query.purchaseDate = {};
                if (startDate) {
                    query.purchaseDate.$gte = new Date(startDate);
                }
                if (endDate) {
                    query.purchaseDate.$lte = new Date(endDate);
                }
            }

            const purchases = await Purchase.find(query)
                .populate('vendorId', 'name email phone')
                .sort({ purchaseDate: -1, createdAt: -1 });

            // Map vendorId to vendor for consistency with frontend
            const purchasesWithVendor = purchases.map(p => ({
                ...p.toObject(),
                vendor: p.vendorId
            }));

            return res.status(200).json({
                message: 'Purchases fetched successfully',
                data: purchasesWithVendor
            });
        } catch (error) {
            console.error('Error fetching purchases:', error);
            return res.status(500).json({ message: 'Failed to fetch purchases' });
        }
    },

    // GET /purchases/:id - Get single purchase with payments
    getPurchaseById: async (req, res) => {
        try {
            const { id } = req.params;

            const purchase = await Purchase.findOne({ _id: id, isDeleted: { $ne: true } })
                .populate('vendorId', 'name email phone contactPerson');

            if (!purchase) {
                return res.status(404).json({ message: 'Purchase not found' });
            }

            // Get payments for this purchase
            const payments = await Payment.find({
                purchaseId: id,
                isDeleted: { $ne: true }
            }).sort({ paymentDate: -1 });

            return res.status(200).json({
                message: 'Purchase fetched successfully',
                data: {
                    ...purchase.toObject(),
                    vendor: purchase.vendorId,
                    payments
                }
            });
        } catch (error) {
            console.error('Error fetching purchase:', error);
            return res.status(500).json({ message: 'Failed to fetch purchase' });
        }
    },

    // POST /purchases - Create new purchase
    createPurchase: async (req, res) => {
        try {
            const { vendorId, invoiceNumber, purchaseDate, dueDate, items, tax, discount, notes } = req.body;

            if (!vendorId) {
                return res.status(400).json({ message: 'Vendor is required' });
            }

            if (!items || items.length === 0) {
                return res.status(400).json({ message: 'At least one item is required' });
            }

            // Check vendor exists
            const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: { $ne: true } });
            if (!vendor) {
                return res.status(404).json({ message: 'Vendor not found' });
            }

            // Process items and calculate totals
            const processedItems = items.map(item => ({
                description: item.description?.trim() || '',
                quantity: item.quantity || 1,
                unitPrice: item.unitPrice || 0,
                total: (item.quantity || 1) * (item.unitPrice || 0)
            }));

            const subtotal = processedItems.reduce((sum, item) => sum + item.total, 0);
            const taxAmount = (subtotal * (tax || 0)) / 100;
            const total = subtotal + taxAmount - (discount || 0);

            const purchase = await Purchase.create({
                vendorId,
                invoiceNumber: invoiceNumber?.trim() || `PO-${Date.now()}`,
                purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
                dueDate: dueDate ? new Date(dueDate) : null,
                items: processedItems,
                subtotal,
                tax: tax || 0,
                discount: discount || 0,
                total,
                paidAmount: 0,
                pendingAmount: total,
                paymentStatus: 'pending',
                notes: notes?.trim() || ''
            });

            return res.status(201).json({
                message: 'Purchase created successfully',
                data: purchase
            });
        } catch (error) {
            console.error('Error creating purchase:', error);
            return res.status(500).json({ message: 'Failed to create purchase' });
        }
    },

    // PUT /purchases/:id - Update purchase
    updatePurchase: async (req, res) => {
        try {
            const { id } = req.params;
            const { invoiceNumber, purchaseDate, dueDate, items, tax, discount, notes } = req.body;

            const purchase = await Purchase.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!purchase) {
                return res.status(404).json({ message: 'Purchase not found' });
            }

            // Check if purchase has payments - don't allow editing items if so
            const paymentsCount = await Payment.countDocuments({
                purchaseId: id,
                isDeleted: { $ne: true }
            });

            if (paymentsCount > 0 && items) {
                return res.status(400).json({
                    message: 'Cannot modify items for a purchase that has payments'
                });
            }

            // Update fields
            if (invoiceNumber !== undefined) purchase.invoiceNumber = invoiceNumber.trim();
            if (purchaseDate !== undefined) purchase.purchaseDate = new Date(purchaseDate);
            if (dueDate !== undefined) purchase.dueDate = dueDate ? new Date(dueDate) : null;
            if (notes !== undefined) purchase.notes = notes?.trim() || '';

            if (items && paymentsCount === 0) {
                purchase.items = items.map(item => ({
                    description: item.description?.trim() || '',
                    quantity: item.quantity || 1,
                    unitPrice: item.unitPrice || 0,
                    total: (item.quantity || 1) * (item.unitPrice || 0)
                }));
            }

            if (tax !== undefined) purchase.tax = tax;
            if (discount !== undefined) purchase.discount = discount;

            // Save will recalculate totals via pre-save hook
            await purchase.save();

            return res.status(200).json({
                message: 'Purchase updated successfully',
                data: purchase
            });
        } catch (error) {
            console.error('Error updating purchase:', error);
            return res.status(500).json({ message: 'Failed to update purchase' });
        }
    },

    // DELETE /purchases/:id - Soft delete purchase
    deletePurchase: async (req, res) => {
        try {
            const { id } = req.params;

            const purchase = await Purchase.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!purchase) {
                return res.status(404).json({ message: 'Purchase not found' });
            }

            // Also soft delete associated payments
            await Payment.updateMany(
                { purchaseId: id },
                {
                    isDeleted: true,
                    deletedAt: new Date(),
                    deletedBy: req.user?.id || req.user?._id || null
                }
            );

            purchase.isDeleted = true;
            purchase.deletedAt = new Date();
            purchase.deletedBy = req.user?.id || req.user?._id || null;
            await purchase.save();

            return res.status(200).json({
                message: 'Purchase deleted successfully',
                data: purchase
            });
        } catch (error) {
            console.error('Error deleting purchase:', error);
            return res.status(500).json({ message: 'Failed to delete purchase' });
        }
    },

    // PUT /purchases/:id/restore - Restore soft-deleted purchase
    restorePurchase: async (req, res) => {
        try {
            const { id } = req.params;

            const purchase = await Purchase.findOne({ _id: id, isDeleted: true });

            if (!purchase) {
                return res.status(404).json({ message: 'Deleted purchase not found' });
            }

            // Also restore associated payments
            await Payment.updateMany(
                { purchaseId: id },
                { isDeleted: false, deletedAt: null, deletedBy: null }
            );

            purchase.isDeleted = false;
            purchase.deletedAt = null;
            purchase.deletedBy = null;
            await purchase.save();

            return res.status(200).json({
                message: 'Purchase restored successfully',
                data: purchase
            });
        } catch (error) {
            console.error('Error restoring purchase:', error);
            return res.status(500).json({ message: 'Failed to restore purchase' });
        }
    },

    // POST /purchases/:id/payments - Add payment to purchase
    addPayment: async (req, res) => {
        try {
            const { id } = req.params;
            const { amount, paymentMethod, paymentDate, reference, notes } = req.body;

            const purchase = await Purchase.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!purchase) {
                return res.status(404).json({ message: 'Purchase not found' });
            }

            if (!amount || amount <= 0) {
                return res.status(400).json({ message: 'Valid payment amount is required' });
            }

            if (!paymentMethod) {
                return res.status(400).json({ message: 'Payment method is required' });
            }

            // Create payment
            const payment = await Payment.create({
                vendorId: purchase.vendorId,
                purchaseId: id,
                amount,
                paymentMethod,
                paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
                reference: reference?.trim() || '',
                notes: notes?.trim() || ''
            });

            // Update purchase paid amount
            purchase.paidAmount += amount;
            await purchase.save();

            return res.status(201).json({
                message: 'Payment added successfully',
                data: payment
            });
        } catch (error) {
            console.error('Error adding payment:', error);
            return res.status(500).json({ message: 'Failed to add payment' });
        }
    },

    // GET /purchases/:id/payments - Get payments for a purchase
    getPurchasePayments: async (req, res) => {
        try {
            const { id } = req.params;

            const payments = await Payment.find({
                purchaseId: id,
                isDeleted: { $ne: true }
            }).sort({ paymentDate: -1 });

            return res.status(200).json({
                message: 'Payments fetched successfully',
                data: payments
            });
        } catch (error) {
            console.error('Error fetching payments:', error);
            return res.status(500).json({ message: 'Failed to fetch payments' });
        }
    },

    // POST /payments - Create general payment (not tied to specific purchase)
    createPayment: async (req, res) => {
        try {
            const { vendorId, purchaseId, amount, paymentMethod, paymentDate, reference, notes } = req.body;

            if (!vendorId) {
                return res.status(400).json({ message: 'Vendor is required' });
            }

            if (!amount || amount <= 0) {
                return res.status(400).json({ message: 'Valid payment amount is required' });
            }

            if (!paymentMethod) {
                return res.status(400).json({ message: 'Payment method is required' });
            }

            // Verify vendor exists
            const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: { $ne: true } });
            if (!vendor) {
                return res.status(404).json({ message: 'Vendor not found' });
            }

            // If purchaseId provided, update that purchase's paid amount
            if (purchaseId) {
                const purchase = await Purchase.findOne({ _id: purchaseId, isDeleted: { $ne: true } });
                if (purchase) {
                    purchase.paidAmount += amount;
                    await purchase.save();
                }
            }

            const payment = await Payment.create({
                vendorId,
                purchaseId: purchaseId || null,
                amount,
                paymentMethod,
                paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
                reference: reference?.trim() || '',
                notes: notes?.trim() || ''
            });

            return res.status(201).json({
                message: 'Payment created successfully',
                data: payment
            });
        } catch (error) {
            console.error('Error creating payment:', error);
            return res.status(500).json({ message: 'Failed to create payment' });
        }
    },

    // GET /payments - Get all payments
    getAllPayments: async (req, res) => {
        try {
            const { vendorId } = req.query;

            const query = { isDeleted: { $ne: true } };
            if (vendorId) {
                query.vendorId = vendorId;
            }

            const payments = await Payment.find(query)
                .populate('vendorId', 'name')
                .populate('purchaseId', 'invoiceNumber')
                .sort({ paymentDate: -1 });

            return res.status(200).json({
                message: 'Payments fetched successfully',
                data: payments
            });
        } catch (error) {
            console.error('Error fetching payments:', error);
            return res.status(500).json({ message: 'Failed to fetch payments' });
        }
    },

    // DELETE /payments/:id - Delete payment
    deletePayment: async (req, res) => {
        try {
            const { id } = req.params;

            const payment = await Payment.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!payment) {
                return res.status(404).json({ message: 'Payment not found' });
            }

            // Update associated purchase's paid amount
            if (payment.purchaseId) {
                const purchase = await Purchase.findById(payment.purchaseId);
                if (purchase) {
                    purchase.paidAmount = Math.max(0, purchase.paidAmount - payment.amount);
                    await purchase.save();
                }
            }

            payment.isDeleted = true;
            payment.deletedAt = new Date();
            payment.deletedBy = req.user?.id || req.user?._id || null;
            await payment.save();

            return res.status(200).json({
                message: 'Payment deleted successfully',
                data: payment
            });
        } catch (error) {
            console.error('Error deleting payment:', error);
            return res.status(500).json({ message: 'Failed to delete payment' });
        }
    }
};

module.exports = purchaseController;
