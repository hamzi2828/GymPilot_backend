// src/controller/customerController.js

const Customer = require('../models/customer');

// Helper function to generate unique customer code
const generateCustomerCode = async (customerType) => {
    const prefixes = {
        'walk-in': 'WLK',
        'online': 'ONL',
        'wholesale': 'WHS',
        'corporate': 'CRP'
    };
    const prefix = prefixes[customerType] || 'WLK';
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');

    // Find the last customer with the same prefix to get the next sequence number
    const lastCustomer = await Customer.findOne({
        customerCode: { $regex: `^${prefix}${year}${month}` }
    }).sort({ customerCode: -1 });

    let sequence = 1;
    if (lastCustomer && lastCustomer.customerCode) {
        const lastSequence = parseInt(lastCustomer.customerCode.slice(-4), 10);
        if (!isNaN(lastSequence)) {
            sequence = lastSequence + 1;
        }
    }

    return `${prefix}${year}${month}${sequence.toString().padStart(4, '0')}`;
};

const customerController = {
    // GET /customers - Get all customers
    getAllCustomers: async (req, res) => {
        try {
            const customers = await Customer.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 });
            return res.status(200).json({
                message: 'Customers fetched successfully',
                data: customers
            });
        } catch (error) {
            console.error('Error fetching customers:', error);
            return res.status(500).json({ message: 'Failed to fetch customers' });
        }
    },

    // GET /customers/:id - Get single customer
    getCustomerById: async (req, res) => {
        try {
            const { id } = req.params;
            const customer = await Customer.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!customer) {
                return res.status(404).json({ message: 'Customer not found' });
            }

            return res.status(200).json({
                message: 'Customer fetched successfully',
                data: customer
            });
        } catch (error) {
            console.error('Error fetching customer:', error);
            return res.status(500).json({ message: 'Failed to fetch customer' });
        }
    },

    // POST /customers - Create new customer
    createCustomer: async (req, res) => {
        try {
            const {
                firstName,
                lastName,
                email,
                phone,
                alternatePhone,
                address,
                sizePreferences,
                stylePreferences,
                notes,
                customerType,
                source
            } = req.body;

            if (!firstName || !firstName.trim()) {
                return res.status(400).json({ message: 'First name is required' });
            }
            if (!lastName || !lastName.trim()) {
                return res.status(400).json({ message: 'Last name is required' });
            }
            if (!phone || !phone.trim()) {
                return res.status(400).json({ message: 'Phone is required' });
            }

            // Validate customerType if provided
            const validCustomerTypes = ['walk-in', 'online', 'wholesale', 'corporate'];
            const finalCustomerType = customerType && validCustomerTypes.includes(customerType) ? customerType : 'walk-in';

            // Check if customer with email already exists (if email provided)
            if (email && email.trim()) {
                const existing = await Customer.findOne({
                    email: email.toLowerCase().trim()
                });

                if (existing) {
                    return res.status(409).json({ message: 'Customer with this email already exists' });
                }
            }

            // Generate unique customer code
            const customerCode = await generateCustomerCode(finalCustomerType);

            // Validate source if provided
            const validSources = ['facebook', 'instagram', 'tiktok', 'word-of-mouth', 'website', 'other', ''];
            const finalSource = source && validSources.includes(source) ? source : '';

            const customer = await Customer.create({
                customerCode,
                customerType: finalCustomerType,
                source: finalSource,
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email?.toLowerCase().trim() || '',
                phone: phone.trim(),
                alternatePhone: alternatePhone?.trim() || '',
                address: address || {},
                sizePreferences: sizePreferences || [],
                stylePreferences: stylePreferences || [],
                notes: notes?.trim() || '',
            });

            return res.status(201).json({
                message: 'Customer created successfully',
                data: customer
            });
        } catch (error) {
            console.error('Error creating customer:', error);
            if (error.code === 11000) {
                return res.status(409).json({ message: 'Customer with this email already exists' });
            }
            return res.status(500).json({ message: 'Failed to create customer' });
        }
    },

    // PUT /customers/:id - Update customer
    updateCustomer: async (req, res) => {
        try {
            const { id } = req.params;
            const {
                firstName,
                lastName,
                email,
                phone,
                alternatePhone,
                address,
                sizePreferences,
                stylePreferences,
                notes,
                isActive,
                customerType,
                source
            } = req.body;

            const customer = await Customer.findById(id);
            if (!customer) {
                return res.status(404).json({ message: 'Customer not found' });
            }

            // If email is being changed, check for duplicates
            if (email && email.toLowerCase().trim() !== customer.email) {
                const existing = await Customer.findOne({
                    email: email.toLowerCase().trim(),
                    _id: { $ne: id }
                });

                if (existing) {
                    return res.status(409).json({ message: 'Customer with this email already exists' });
                }
            }

            // Update fields
            if (firstName !== undefined) customer.firstName = firstName.trim();
            if (lastName !== undefined) customer.lastName = lastName.trim();
            if (email !== undefined) customer.email = email?.toLowerCase().trim() || '';
            if (phone !== undefined) customer.phone = phone?.trim() || '';
            if (alternatePhone !== undefined) customer.alternatePhone = alternatePhone?.trim() || '';
            if (address !== undefined) customer.address = address;
            if (sizePreferences !== undefined) customer.sizePreferences = sizePreferences;
            if (stylePreferences !== undefined) customer.stylePreferences = stylePreferences;
            if (notes !== undefined) customer.notes = notes?.trim() || '';
            if (isActive !== undefined) customer.isActive = isActive;

            // Update customer type if provided and valid
            if (customerType !== undefined) {
                const validCustomerTypes = ['walk-in', 'online', 'wholesale', 'corporate'];
                if (validCustomerTypes.includes(customerType)) {
                    customer.customerType = customerType;
                }
            }

            // Update source if provided and valid
            if (source !== undefined) {
                const validSources = ['facebook', 'instagram', 'tiktok', 'word-of-mouth', 'website', 'other', ''];
                if (validSources.includes(source)) {
                    customer.source = source;
                }
            }

            await customer.save();

            return res.status(200).json({
                message: 'Customer updated successfully',
                data: customer
            });
        } catch (error) {
            console.error('Error updating customer:', error);
            if (error.code === 11000) {
                return res.status(409).json({ message: 'Customer with this email already exists' });
            }
            return res.status(500).json({ message: 'Failed to update customer' });
        }
    },

    // DELETE /customers/:id - Soft delete customer
    deleteCustomer: async (req, res) => {
        try {
            const { id } = req.params;

            const customer = await Customer.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!customer) {
                return res.status(404).json({ message: 'Customer not found' });
            }

            customer.isDeleted = true;
            customer.deletedAt = new Date();
            customer.deletedBy = req.user?.id || req.user?._id || null;
            await customer.save();

            return res.status(200).json({
                message: 'Customer deleted successfully',
                data: customer
            });
        } catch (error) {
            console.error('Error deleting customer:', error);
            return res.status(500).json({ message: 'Failed to delete customer' });
        }
    },

    // PUT /customers/:id/restore - Restore soft-deleted customer
    restoreCustomer: async (req, res) => {
        try {
            const { id } = req.params;

            const customer = await Customer.findOne({ _id: id, isDeleted: true });

            if (!customer) {
                return res.status(404).json({ message: 'Deleted customer not found' });
            }

            customer.isDeleted = false;
            customer.deletedAt = null;
            customer.deletedBy = null;
            await customer.save();

            return res.status(200).json({
                message: 'Customer restored successfully',
                data: customer
            });
        } catch (error) {
            console.error('Error restoring customer:', error);
            return res.status(500).json({ message: 'Failed to restore customer' });
        }
    },

    // PUT /customers/:id/status - Update customer status
    updateCustomerStatus: async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const customer = await Customer.findByIdAndUpdate(
                id,
                { isActive },
                { new: true }
            );

            if (!customer) {
                return res.status(404).json({ message: 'Customer not found' });
            }

            return res.status(200).json({
                message: 'Customer status updated successfully',
                data: customer
            });
        } catch (error) {
            console.error('Error updating customer status:', error);
            return res.status(500).json({ message: 'Failed to update customer status' });
        }
    },

    // GET /customers/stats - Get customer statistics
    getCustomerStats: async (req, res) => {
        try {
            const now = new Date();
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

            const [totalCustomers, activeCustomers, newThisMonth, revenueData] = await Promise.all([
                Customer.countDocuments({ isDeleted: { $ne: true } }),
                Customer.countDocuments({ isDeleted: { $ne: true }, isActive: true }),
                Customer.countDocuments({
                    isDeleted: { $ne: true },
                    createdAt: { $gte: startOfMonth }
                }),
                Customer.aggregate([
                    { $match: { isDeleted: { $ne: true } } },
                    { $group: { _id: null, totalRevenue: { $sum: '$totalSpent' } } }
                ])
            ]);

            const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

            // Get customers by type
            const byType = await Customer.aggregate([
                { $match: { isDeleted: { $ne: true } } },
                { $group: { _id: '$customerType', count: { $sum: 1 } } },
                { $project: { type: '$_id', count: 1, _id: 0 } }
            ]);

            return res.status(200).json({
                message: 'Customer stats fetched successfully',
                data: {
                    totalCustomers,
                    activeCustomers,
                    newThisMonth,
                    totalRevenue,
                    byType
                }
            });
        } catch (error) {
            console.error('Error fetching customer stats:', error);
            return res.status(500).json({ message: 'Failed to fetch customer stats' });
        }
    },

    // GET /customers/search - Search customers
    searchCustomers: async (req, res) => {
        try {
            const { q } = req.query;

            if (!q || q.trim().length < 2) {
                return res.status(400).json({ message: 'Search query must be at least 2 characters' });
            }

            const searchQuery = q.trim();
            const customers = await Customer.find({
                isDeleted: { $ne: true },
                $or: [
                    { firstName: { $regex: searchQuery, $options: 'i' } },
                    { lastName: { $regex: searchQuery, $options: 'i' } },
                    { customerCode: { $regex: searchQuery, $options: 'i' } },
                    { phone: { $regex: searchQuery, $options: 'i' } },
                    { email: { $regex: searchQuery, $options: 'i' } }
                ]
            }).limit(20);

            return res.status(200).json({
                message: 'Search results',
                data: customers
            });
        } catch (error) {
            console.error('Error searching customers:', error);
            return res.status(500).json({ message: 'Failed to search customers' });
        }
    },
};

module.exports = customerController;
