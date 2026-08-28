// src/controller/salaryController.js

const Salary = require('../models/salary');
const Employee = require('../models/employee');

const salaryController = {
    // GET /salaries - Get all salary records
    getAllSalaries: async (req, res) => {
        try {
            const { month, year, employeeId } = req.query;

            const filter = { isDeleted: { $ne: true } };
            if (month) filter.month = month;
            if (year) filter.year = parseInt(year);
            if (employeeId) filter.employee = employeeId;

            const salaries = await Salary.find(filter)
                .populate('employee', 'firstName lastName email')
                .sort({ year: -1, createdAt: -1 });

            return res.status(200).json({
                message: 'Salaries fetched successfully',
                data: salaries
            });
        } catch (error) {
            console.error('Get all salaries error:', error);
            return res.status(500).json({ message: 'Error fetching salaries', error: error.message });
        }
    },

    // GET /salaries/:id - Get single salary record
    getSalaryById: async (req, res) => {
        try {
            const { id } = req.params;

            const salary = await Salary.findOne({ _id: id, isDeleted: { $ne: true } })
                .populate('employee', 'firstName lastName email');

            if (!salary) {
                return res.status(404).json({ message: 'Salary record not found' });
            }

            return res.status(200).json({
                message: 'Salary fetched successfully',
                data: salary
            });
        } catch (error) {
            console.error('Get salary by ID error:', error);
            return res.status(500).json({ message: 'Error fetching salary', error: error.message });
        }
    },

    // POST /salaries - Create new salary record
    createSalary: async (req, res) => {
        try {
            const { employeeId, baseSalary, month, year, notes } = req.body;

            // Validate employee exists
            const employee = await Employee.findOne({ _id: employeeId, isDeleted: { $ne: true } });
            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            // Check for duplicate salary record
            const existing = await Salary.findOne({
                employee: employeeId,
                month,
                year,
                isDeleted: { $ne: true }
            });
            if (existing) {
                return res.status(409).json({
                    message: `Salary record already exists for ${month} ${year}`
                });
            }

            const salary = new Salary({
                employee: employeeId,
                baseSalary,
                month,
                year,
                notes,
                payments: [],
                totalPaid: 0,
                remainingBalance: baseSalary,
                status: 'pending'
            });

            await salary.save();

            const populated = await Salary.findById(salary._id)
                .populate('employee', 'firstName lastName email');

            return res.status(201).json({
                message: 'Salary record created successfully',
                data: populated
            });
        } catch (error) {
            console.error('Create salary error:', error);
            return res.status(400).json({ message: 'Error creating salary record', error: error.message });
        }
    },

    // PUT /salaries/:id - Update salary record
    updateSalary: async (req, res) => {
        try {
            const { id } = req.params;
            const { baseSalary, month, year, notes } = req.body;

            const salary = await Salary.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!salary) {
                return res.status(404).json({ message: 'Salary record not found' });
            }

            if (baseSalary !== undefined) salary.baseSalary = baseSalary;
            if (month !== undefined) salary.month = month;
            if (year !== undefined) salary.year = year;
            if (notes !== undefined) salary.notes = notes;

            await salary.save();

            const populated = await Salary.findById(salary._id)
                .populate('employee', 'firstName lastName email');

            return res.status(200).json({
                message: 'Salary record updated successfully',
                data: populated
            });
        } catch (error) {
            console.error('Update salary error:', error);
            return res.status(400).json({ message: 'Error updating salary record', error: error.message });
        }
    },

    // DELETE /salaries/:id - Soft delete salary record
    deleteSalary: async (req, res) => {
        try {
            const { id } = req.params;

            const salary = await Salary.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!salary) {
                return res.status(404).json({ message: 'Salary record not found' });
            }

            salary.isDeleted = true;
            salary.deletedAt = new Date();
            salary.deletedBy = req.user?.id || req.user?._id || null;
            await salary.save();

            return res.status(200).json({ message: 'Salary record deleted successfully' });
        } catch (error) {
            console.error('Delete salary error:', error);
            return res.status(500).json({ message: 'Error deleting salary record', error: error.message });
        }
    },

    // POST /salaries/:id/payments - Add payment to salary
    addPayment: async (req, res) => {
        try {
            const { id } = req.params;
            const { amount, date, paymentMethod, notes } = req.body;

            const salary = await Salary.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!salary) {
                return res.status(404).json({ message: 'Salary record not found' });
            }

            if (!amount || amount <= 0) {
                return res.status(400).json({ message: 'Payment amount must be greater than 0' });
            }

            salary.payments.push({
                amount,
                date: date || new Date(),
                paymentMethod: paymentMethod || 'cash',
                notes
            });

            await salary.save();

            const populated = await Salary.findById(salary._id)
                .populate('employee', 'firstName lastName email');

            return res.status(200).json({
                message: 'Payment added successfully',
                data: populated
            });
        } catch (error) {
            console.error('Add payment error:', error);
            return res.status(400).json({ message: 'Error adding payment', error: error.message });
        }
    },

    // DELETE /salaries/:id/payments/:paymentId - Remove payment from salary
    removePayment: async (req, res) => {
        try {
            const { id, paymentId } = req.params;

            const salary = await Salary.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!salary) {
                return res.status(404).json({ message: 'Salary record not found' });
            }

            const paymentIndex = salary.payments.findIndex(
                p => p._id.toString() === paymentId
            );

            if (paymentIndex === -1) {
                return res.status(404).json({ message: 'Payment not found' });
            }

            salary.payments.splice(paymentIndex, 1);
            await salary.save();

            const populated = await Salary.findById(salary._id)
                .populate('employee', 'firstName lastName email');

            return res.status(200).json({
                message: 'Payment removed successfully',
                data: populated
            });
        } catch (error) {
            console.error('Remove payment error:', error);
            return res.status(500).json({ message: 'Error removing payment', error: error.message });
        }
    }
};

module.exports = salaryController;
