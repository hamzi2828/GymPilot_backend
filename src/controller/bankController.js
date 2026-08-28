// src/controller/bankController.js

const Bank = require('../models/bank');

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload = null;
if (USE_BLOB_STORAGE) {
    try { blobUpload = require('../helper/blobUpload'); } catch { blobUpload = null; }
}

const bankController = {
    // GET /banks - Get all banks
    getAllBanks: async (req, res) => {
        try {
            const banks = await Bank.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 });
            return res.status(200).json({
                message: 'Banks fetched successfully',
                data: banks
            });
        } catch (error) {
            console.error('Error fetching banks:', error);
            return res.status(500).json({ message: 'Failed to fetch banks' });
        }
    },

    // GET /banks/:id - Get single bank
    getBankById: async (req, res) => {
        try {
            const { id } = req.params;
            const bank = await Bank.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!bank) {
                return res.status(404).json({ message: 'Bank not found' });
            }

            return res.status(200).json({
                message: 'Bank fetched successfully',
                data: bank
            });
        } catch (error) {
            console.error('Error fetching bank:', error);
            return res.status(500).json({ message: 'Failed to fetch bank' });
        }
    },

    // POST /banks - Create new bank
    createBank: async (req, res) => {
        try {
            const { name, accountNumber, accountTitle, branch, iban, notes } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({ message: 'Bank name is required' });
            }
            if (!accountNumber || !accountNumber.trim()) {
                return res.status(400).json({ message: 'Account number is required' });
            }
            if (!accountTitle || !accountTitle.trim()) {
                return res.status(400).json({ message: 'Account title is required' });
            }

            const bank = await Bank.create({
                name: name.trim(),
                accountNumber: accountNumber.trim(),
                accountTitle: accountTitle.trim(),
                branch: branch?.trim() || '',
                iban: iban?.trim() || '',
                notes: notes?.trim() || '',
            });

            return res.status(201).json({
                message: 'Bank created successfully',
                data: bank
            });
        } catch (error) {
            console.error('Error creating bank:', error);
            return res.status(500).json({ message: 'Failed to create bank' });
        }
    },

    // PUT /banks/:id - Update bank
    updateBank: async (req, res) => {
        try {
            const { id } = req.params;
            const { name, accountNumber, accountTitle, branch, iban, notes, isActive } = req.body;

            const bank = await Bank.findById(id);
            if (!bank) {
                return res.status(404).json({ message: 'Bank not found' });
            }

            // Update fields
            if (name !== undefined) bank.name = name.trim();
            if (accountNumber !== undefined) bank.accountNumber = accountNumber.trim();
            if (accountTitle !== undefined) bank.accountTitle = accountTitle.trim();
            if (branch !== undefined) bank.branch = branch?.trim() || '';
            if (iban !== undefined) bank.iban = iban?.trim() || '';
            if (notes !== undefined) bank.notes = notes?.trim() || '';
            if (isActive !== undefined) bank.isActive = isActive;

            await bank.save();

            return res.status(200).json({
                message: 'Bank updated successfully',
                data: bank
            });
        } catch (error) {
            console.error('Error updating bank:', error);
            return res.status(500).json({ message: 'Failed to update bank' });
        }
    },

    // DELETE /banks/:id - Soft delete bank
    deleteBank: async (req, res) => {
        try {
            const { id } = req.params;

            const bank = await Bank.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!bank) {
                return res.status(404).json({ message: 'Bank not found' });
            }

            bank.isDeleted = true;
            bank.deletedAt = new Date();
            bank.deletedBy = req.user?.id || req.user?._id || null;
            await bank.save();

            return res.status(200).json({
                message: 'Bank deleted successfully',
                data: bank
            });
        } catch (error) {
            console.error('Error deleting bank:', error);
            return res.status(500).json({ message: 'Failed to delete bank' });
        }
    },

    // PUT /banks/:id/restore - Restore soft-deleted bank
    restoreBank: async (req, res) => {
        try {
            const { id } = req.params;

            const bank = await Bank.findOne({ _id: id, isDeleted: true });

            if (!bank) {
                return res.status(404).json({ message: 'Deleted bank not found' });
            }

            bank.isDeleted = false;
            bank.deletedAt = null;
            bank.deletedBy = null;
            await bank.save();

            return res.status(200).json({
                message: 'Bank restored successfully',
                data: bank
            });
        } catch (error) {
            console.error('Error restoring bank:', error);
            return res.status(500).json({ message: 'Failed to restore bank' });
        }
    },

    // PUT /banks/:id/status - Update bank status
    // POST /banks/:id/qr-code - attach a scannable payment barcode/QR image
    uploadQrCode: async (req, res) => {
        try {
            const file = req.files?.qrCode?.[0];
            if (!file) {
                return res.status(400).json({ success: false, message: 'A qrCode image file is required' });
            }

            const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (!allowed.includes(file.mimetype)) {
                return res.status(400).json({ success: false, message: 'Invalid file type. Upload a PNG, JPG, GIF, WebP or SVG image.' });
            }
            if (file.size > 5 * 1024 * 1024) {
                return res.status(400).json({ success: false, message: 'File too large. Maximum size is 5MB.' });
            }

            const bank = await Bank.findById(req.params.id);
            if (!bank || bank.isDeleted) {
                return res.status(404).json({ success: false, message: 'Bank not found' });
            }

            let qrCodeUrl;
            if (USE_BLOB_STORAGE && blobUpload) {
                qrCodeUrl = await blobUpload.uploadToBlob(file.buffer, file.originalname, file.mimetype, 'banks');
            } else {
                qrCodeUrl = `/uploads/${file.filename}`;
            }

            bank.qrCodeUrl = qrCodeUrl;
            await bank.save();

            return res.status(200).json({ success: true, message: 'Barcode uploaded', data: bank });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to upload barcode', error: error.message });
        }
    },

    // DELETE /banks/:id/qr-code - remove the barcode image reference
    removeQrCode: async (req, res) => {
        try {
            const bank = await Bank.findById(req.params.id);
            if (!bank || bank.isDeleted) {
                return res.status(404).json({ success: false, message: 'Bank not found' });
            }
            bank.qrCodeUrl = '';
            await bank.save();
            return res.status(200).json({ success: true, message: 'Barcode removed', data: bank });
        } catch (error) {
            return res.status(500).json({ success: false, message: 'Failed to remove barcode', error: error.message });
        }
    },

    updateBankStatus: async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const bank = await Bank.findByIdAndUpdate(
                id,
                { isActive },
                { new: true }
            );

            if (!bank) {
                return res.status(404).json({ message: 'Bank not found' });
            }

            return res.status(200).json({
                message: 'Bank status updated successfully',
                data: bank
            });
        } catch (error) {
            console.error('Error updating bank status:', error);
            return res.status(500).json({ message: 'Failed to update bank status' });
        }
    },
};

module.exports = bankController;
