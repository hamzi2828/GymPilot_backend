// src/controller/employeeController.js

const Employee = require('../models/employee');

const employeeController = {
    // GET /employees - Get all employees
    getAllEmployees: async (req, res) => {
        try {
            const employees = await Employee.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 });
            return res.status(200).json({
                message: 'Employees fetched successfully',
                data: employees
            });
        } catch (error) {
            console.error('Error fetching employees:', error);
            return res.status(500).json({ message: 'Failed to fetch employees' });
        }
    },

    // GET /employees/:id - Get single employee
    getEmployeeById: async (req, res) => {
        try {
            const { id } = req.params;
            const employee = await Employee.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            return res.status(200).json({
                message: 'Employee fetched successfully',
                data: employee
            });
        } catch (error) {
            console.error('Error fetching employee:', error);
            return res.status(500).json({ message: 'Failed to fetch employee' });
        }
    },

    // POST /employees - Create new employee
    createEmployee: async (req, res) => {
        try {
            const {
                firstName,
                lastName,
                email,
                phone,
                cnic,
                position,
                department,
                role,
                salary,
                hireDate,
                dateOfBirth,
                gender,
                address,
                emergencyContact,
                bankDetails,
                notes
            } = req.body;

            // Validation
            if (!firstName || !firstName.trim()) {
                return res.status(400).json({ message: 'First name is required' });
            }
            if (!lastName || !lastName.trim()) {
                return res.status(400).json({ message: 'Last name is required' });
            }
            if (!email || !email.trim()) {
                return res.status(400).json({ message: 'Email is required' });
            }
            if (salary === undefined || salary === null) {
                return res.status(400).json({ message: 'Salary is required' });
            }

            // Check if employee with email already exists
            const existing = await Employee.findOne({
                email: email.toLowerCase().trim(),
                isDeleted: { $ne: true }
            });

            if (existing) {
                return res.status(409).json({ message: 'Employee with this email already exists' });
            }

            const employee = await Employee.create({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.toLowerCase().trim(),
                phone: phone?.trim() || null,
                cnic: cnic?.trim() || null,
                position: position?.trim() || null,
                department: department?.trim() || null,
                role: role || 'employee',
                salary: Number(salary),
                hireDate: hireDate ? new Date(hireDate) : new Date(),
                dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                gender: gender || null,
                address: address || {},
                emergencyContact: emergencyContact || {},
                bankDetails: bankDetails || {},
                notes: notes?.trim() || null,
            });

            return res.status(201).json({
                message: 'Employee created successfully',
                data: employee
            });
        } catch (error) {
            console.error('Error creating employee:', error);
            if (error.code === 11000) {
                return res.status(409).json({ message: 'Employee with this email already exists' });
            }
            return res.status(500).json({ message: 'Failed to create employee' });
        }
    },

    // PUT /employees/:id - Update employee
    updateEmployee: async (req, res) => {
        try {
            const { id } = req.params;
            const {
                firstName,
                lastName,
                email,
                phone,
                cnic,
                position,
                department,
                role,
                salary,
                hireDate,
                dateOfBirth,
                gender,
                address,
                emergencyContact,
                bankDetails,
                notes,
                isActive
            } = req.body;

            const employee = await Employee.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            // If email is being changed, check for duplicates
            if (email && email.toLowerCase().trim() !== employee.email) {
                const existing = await Employee.findOne({
                    email: email.toLowerCase().trim(),
                    _id: { $ne: id },
                    isDeleted: { $ne: true }
                });

                if (existing) {
                    return res.status(409).json({ message: 'Employee with this email already exists' });
                }
            }

            // Update fields
            if (firstName !== undefined) employee.firstName = firstName.trim();
            if (lastName !== undefined) employee.lastName = lastName.trim();
            if (email !== undefined) employee.email = email.toLowerCase().trim();
            if (phone !== undefined) employee.phone = phone?.trim() || null;
            if (cnic !== undefined) employee.cnic = cnic?.trim() || null;
            if (position !== undefined) employee.position = position?.trim() || null;
            if (department !== undefined) employee.department = department?.trim() || null;
            if (role !== undefined) employee.role = role || 'employee';
            if (salary !== undefined) employee.salary = Number(salary);
            if (hireDate !== undefined) employee.hireDate = hireDate ? new Date(hireDate) : employee.hireDate;
            if (dateOfBirth !== undefined) employee.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
            if (gender !== undefined) employee.gender = gender || null;
            if (address !== undefined) employee.address = address;
            if (emergencyContact !== undefined) employee.emergencyContact = emergencyContact;
            if (bankDetails !== undefined) employee.bankDetails = bankDetails;
            if (notes !== undefined) employee.notes = notes?.trim() || null;
            if (isActive !== undefined) employee.isActive = isActive;

            await employee.save();

            return res.status(200).json({
                message: 'Employee updated successfully',
                data: employee
            });
        } catch (error) {
            console.error('Error updating employee:', error);
            if (error.code === 11000) {
                return res.status(409).json({ message: 'Employee with this email already exists' });
            }
            return res.status(500).json({ message: 'Failed to update employee' });
        }
    },

    // DELETE /employees/:id - Soft delete employee
    deleteEmployee: async (req, res) => {
        try {
            const { id } = req.params;

            const employee = await Employee.findOne({ _id: id, isDeleted: { $ne: true } });

            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            employee.isDeleted = true;
            employee.deletedAt = new Date();
            employee.deletedBy = req.user?.id || req.user?._id || null;
            await employee.save();

            return res.status(200).json({
                message: 'Employee deleted successfully',
                data: employee
            });
        } catch (error) {
            console.error('Error deleting employee:', error);
            return res.status(500).json({ message: 'Failed to delete employee' });
        }
    },

    // PUT /employees/:id/status - Update employee status
    updateEmployeeStatus: async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const employee = await Employee.findOneAndUpdate(
                { _id: id, isDeleted: { $ne: true } },
                { isActive },
                { new: true }
            );

            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            return res.status(200).json({
                message: 'Employee status updated successfully',
                data: employee
            });
        } catch (error) {
            console.error('Error updating employee status:', error);
            return res.status(500).json({ message: 'Failed to update employee status' });
        }
    },

    // PUT /employees/:id/role - Update employee role
    updateEmployeeRole: async (req, res) => {
        try {
            const { id } = req.params;
            const { role } = req.body;

            const validRoles = ['employee', 'manager', 'supervisor', 'admin'];
            if (!role || !validRoles.includes(role)) {
                return res.status(400).json({ message: 'Invalid role. Must be one of: employee, manager, supervisor, admin' });
            }

            const employee = await Employee.findOneAndUpdate(
                { _id: id, isDeleted: { $ne: true } },
                { role },
                { new: true }
            );

            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            return res.status(200).json({
                message: 'Employee role updated successfully',
                data: employee
            });
        } catch (error) {
            console.error('Error updating employee role:', error);
            return res.status(500).json({ message: 'Failed to update employee role' });
        }
    },
};

module.exports = employeeController;
