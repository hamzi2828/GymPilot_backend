// src/controller/vendorController.js

const Vendor = require('../models/vendor');
const Purchase = require('../models/purchase');
const Payment = require('../models/payment');

const vendorController = {
    // GET /vendors - Get all vendors with ledger stats
    getAllVendors: async (req, res) => {
        try {
            const vendors = await Vendor.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 });

            // Calculate ledger stats for each vendor
            const vendorsWithStats = await Promise.all(vendors.map(async (vendor) => {
                const purchases = await Purchase.find({
                    vendorId: vendor._id,
                    isDeleted: { $ne: true }
                });
                const payments = await Payment.find({
                    vendorId: vendor._id,
                    isDeleted: { $ne: true }
                });

                const totalPurchase = purchases.reduce((sum, p) => sum + p.total, 0);
                const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
                const remainingBalance = totalPurchase - totalPaid;

                // Determine payment status
                let paymentStatus = 'paid';
                let dueDate = null;

                if (remainingBalance > 0) {
                    const pendingPurchases = purchases.filter(p => p.paymentStatus !== 'paid');
                    if (pendingPurchases.length > 0) {
                        const oldestDue = pendingPurchases
                            .filter(p => p.dueDate)
                            .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];

                        if (oldestDue) {
                            dueDate = oldestDue.dueDate;
                            paymentStatus = new Date(oldestDue.dueDate) < new Date() ? 'overdue' : 'partial';
                        } else {
                            paymentStatus = 'partial';
                        }
                    }
                } else if (totalPurchase === 0) {
                    paymentStatus = 'pending';
                }

                return {
                    ...vendor.toObject(),
                    totalPurchase,
                    totalPaid,
                    remainingBalance,
                    paymentStatus,
                    dueDate
                };
            }));

            return res.status(200).json({
                message: 'Vendors fetched successfully',
                data: vendorsWithStats
            });
        } catch (error) {
            console.error('Error fetching vendors:', error);
            return res.status(500).json({ message: 'Failed to fetch vendors' });
        }
    },

    // GET /vendors/dashboard - Get dashboard stats
    getDashboardStats: async (req, res) => {
        try {
            const vendors = await Vendor.find({ isDeleted: { $ne: true } });
            const purchases = await Purchase.find({ isDeleted: { $ne: true } });
            const payments = await Payment.find({ isDeleted: { $ne: true } });

            const totalPurchaseAmount = purchases.reduce((sum, p) => sum + p.total, 0);
            const totalPaidAmount = payments.reduce((sum, p) => sum + p.amount, 0);
            const totalPayable = totalPurchaseAmount - totalPaidAmount;

            // Count by payment status
            const statusCounts = { pending: 0, partial: 0, paid: 0, overdue: 0 };
            let totalOverdue = 0;

            for (const vendor of vendors) {
                const vendorPurchases = purchases.filter(p => p.vendorId.toString() === vendor._id.toString());
                const vendorPayments = payments.filter(p => p.vendorId.toString() === vendor._id.toString());

                const vendorTotal = vendorPurchases.reduce((sum, p) => sum + p.total, 0);
                const vendorPaid = vendorPayments.reduce((sum, p) => sum + p.amount, 0);
                const balance = vendorTotal - vendorPaid;

                if (balance <= 0 && vendorTotal > 0) {
                    statusCounts.paid++;
                } else if (balance > 0) {
                    const hasOverdue = vendorPurchases.some(p =>
                        p.dueDate && new Date(p.dueDate) < new Date() && p.paymentStatus !== 'paid'
                    );
                    if (hasOverdue) {
                        statusCounts.overdue++;
                        totalOverdue += balance;
                    } else if (vendorPaid > 0) {
                        statusCounts.partial++;
                    } else {
                        statusCounts.pending++;
                    }
                } else {
                    statusCounts.pending++;
                }
            }

            return res.status(200).json({
                message: 'Dashboard stats fetched successfully',
                data: {
                    totalVendors: vendors.length,
                    totalPayable,
                    totalOverdue,
                    pendingCount: statusCounts.pending,
                    paidCount: statusCounts.paid,
                    overdueCount: statusCounts.overdue,
                    partialCount: statusCounts.partial
                }
            });
        } catch (error) {
            console.error('Error fetching dashboard stats:', error);
            return res.status(500).json({ message: 'Failed to fetch dashboard stats' });
        }
    },

    // GET /vendors/:id - Get single vendor with ledger
    getVendorById: async (req, res) => {
        try {
            const { id } = req.params;
            const vendor = await Vendor.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!vendor) {
                return res.status(404).json({ message: 'Vendor not found' });
            }

            // Get purchases and payments for ledger
            const purchases = await Purchase.find({
                vendorId: id,
                isDeleted: { $ne: true }
            }).sort({ purchaseDate: 1 });

            const payments = await Payment.find({
                vendorId: id,
                isDeleted: { $ne: true }
            }).sort({ paymentDate: 1 });

            // Calculate totals
            const totalPurchase = purchases.reduce((sum, p) => sum + p.total, 0);
            const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
            const remainingBalance = totalPurchase - totalPaid;

            // Build ledger entries
            const ledgerEntries = [];

            purchases.forEach(p => {
                ledgerEntries.push({
                    _id: p._id.toString(),
                    date: p.purchaseDate,
                    invoiceNumber: p.invoiceNumber,
                    type: 'purchase',
                    debit: p.total,
                    credit: 0,
                    balance: 0, // Will calculate running balance
                    description: `Purchase - ${p.items.length} item(s)`,
                    reference: p.invoiceNumber
                });
            });

            payments.forEach(p => {
                ledgerEntries.push({
                    _id: p._id.toString(),
                    date: p.paymentDate,
                    invoiceNumber: '',
                    type: 'payment',
                    debit: 0,
                    credit: p.amount,
                    balance: 0,
                    description: `Payment via ${p.paymentMethod}`,
                    reference: p.reference || ''
                });
            });

            // Sort by date and calculate running balance
            ledgerEntries.sort((a, b) => new Date(a.date) - new Date(b.date));
            let runningBalance = 0;
            ledgerEntries.forEach(entry => {
                runningBalance += entry.debit - entry.credit;
                entry.balance = runningBalance;
            });

            return res.status(200).json({
                message: 'Vendor fetched successfully',
                data: {
                    ...vendor.toObject(),
                    totalPurchase,
                    totalPaid,
                    remainingBalance,
                    ledger: ledgerEntries,
                    purchases,
                    payments
                }
            });
        } catch (error) {
            console.error('Error fetching vendor:', error);
            return res.status(500).json({ message: 'Failed to fetch vendor' });
        }
    },

    // POST /vendors - Create new vendor
    createVendor: async (req, res) => {
        try {
            const { name, contactPerson, email, phone, address, category, notes } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({ message: 'Vendor name is required' });
            }
            if (!contactPerson || !contactPerson.trim()) {
                return res.status(400).json({ message: 'Contact person is required' });
            }
            if (!email || !email.trim()) {
                return res.status(400).json({ message: 'Email is required' });
            }

            // Check if vendor with email already exists
            const existing = await Vendor.findOne({
                email: email.toLowerCase().trim(),
                isDeleted: { $ne: true }
            });

            if (existing) {
                return res.status(409).json({ message: 'Vendor with this email already exists' });
            }

            const vendor = await Vendor.create({
                name: name.trim(),
                contactPerson: contactPerson.trim(),
                email: email.toLowerCase().trim(),
                phone: phone?.trim() || null,
                address: address || {},
                category: category?.trim() || 'General',
                notes: notes?.trim() || '',
            });

            return res.status(201).json({
                message: 'Vendor created successfully',
                data: vendor
            });
        } catch (error) {
            console.error('Error creating vendor:', error);
            if (error.code === 11000) {
                return res.status(409).json({ message: 'Vendor with this email already exists' });
            }
            return res.status(500).json({ message: 'Failed to create vendor' });
        }
    },

    // PUT /vendors/:id - Update vendor
    updateVendor: async (req, res) => {
        try {
            const { id } = req.params;
            const { name, contactPerson, email, phone, address, category, notes, isActive } = req.body;

            const vendor = await Vendor.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!vendor) {
                return res.status(404).json({ message: 'Vendor not found' });
            }

            // If email is being changed, check for duplicates
            if (email && email.toLowerCase().trim() !== vendor.email) {
                const existing = await Vendor.findOne({
                    email: email.toLowerCase().trim(),
                    _id: { $ne: id },
                    isDeleted: { $ne: true }
                });

                if (existing) {
                    return res.status(409).json({ message: 'Vendor with this email already exists' });
                }
            }

            // Update fields
            if (name !== undefined) vendor.name = name.trim();
            if (contactPerson !== undefined) vendor.contactPerson = contactPerson.trim();
            if (email !== undefined) vendor.email = email.toLowerCase().trim();
            if (phone !== undefined) vendor.phone = phone?.trim() || null;
            if (address !== undefined) vendor.address = address;
            if (category !== undefined) vendor.category = category?.trim() || 'General';
            if (notes !== undefined) vendor.notes = notes?.trim() || '';
            if (isActive !== undefined) vendor.isActive = isActive;

            await vendor.save();

            return res.status(200).json({
                message: 'Vendor updated successfully',
                data: vendor
            });
        } catch (error) {
            console.error('Error updating vendor:', error);
            if (error.code === 11000) {
                return res.status(409).json({ message: 'Vendor with this email already exists' });
            }
            return res.status(500).json({ message: 'Failed to update vendor' });
        }
    },

    // DELETE /vendors/:id - Soft delete vendor
    deleteVendor: async (req, res) => {
        try {
            const { id } = req.params;

            const vendor = await Vendor.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!vendor) {
                return res.status(404).json({ message: 'Vendor not found' });
            }

            vendor.isDeleted = true;
            vendor.deletedAt = new Date();
            vendor.deletedBy = req.user?.id || req.user?._id || null;
            await vendor.save();

            return res.status(200).json({
                message: 'Vendor deleted successfully',
                data: vendor
            });
        } catch (error) {
            console.error('Error deleting vendor:', error);
            return res.status(500).json({ message: 'Failed to delete vendor' });
        }
    },

    // PUT /vendors/:id/restore - Restore soft-deleted vendor
    restoreVendor: async (req, res) => {
        try {
            const { id } = req.params;

            const vendor = await Vendor.findOne({ _id: id, isDeleted: true });

            if (!vendor) {
                return res.status(404).json({ message: 'Deleted vendor not found' });
            }

            vendor.isDeleted = false;
            vendor.deletedAt = null;
            vendor.deletedBy = null;
            await vendor.save();

            return res.status(200).json({
                message: 'Vendor restored successfully',
                data: vendor
            });
        } catch (error) {
            console.error('Error restoring vendor:', error);
            return res.status(500).json({ message: 'Failed to restore vendor' });
        }
    },

    // PUT /vendors/:id/status - Update vendor status
    updateVendorStatus: async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const vendor = await Vendor.findByIdAndUpdate(
                id,
                { isActive },
                { new: true }
            );

            if (!vendor) {
                return res.status(404).json({ message: 'Vendor not found' });
            }

            return res.status(200).json({
                message: 'Vendor status updated successfully',
                data: vendor
            });
        } catch (error) {
            console.error('Error updating vendor status:', error);
            return res.status(500).json({ message: 'Failed to update vendor status' });
        }
    },
};

module.exports = vendorController;
