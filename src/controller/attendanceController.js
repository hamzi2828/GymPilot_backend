// src/controller/attendanceController.js

const Attendance = require('../models/Attendance');
const Employee = require('../models/employee');

const attendanceController = {
    // GET /attendance - Get all attendance records
    getAllAttendances: async (req, res) => {
        try {
            const { startDate, endDate, employeeId } = req.query;

            const filter = { isDeleted: { $ne: true } };
            if (startDate || endDate) {
                filter.date = {};
                if (startDate) filter.date.$gte = new Date(startDate);
                if (endDate) filter.date.$lte = new Date(endDate);
            }
            if (employeeId) filter.employee = employeeId;

            const attendances = await Attendance.find(filter)
                .populate('employee', 'firstName lastName email')
                .sort({ date: -1, createdAt: -1 });

            // Transform data to match frontend expectations
            const transformedData = attendances.map(attendance => ({
                _id: attendance._id,
                employee: {
                    _id: attendance.employee?._id,
                    name: attendance.employee ? `${attendance.employee.firstName || ''} ${attendance.employee.lastName || ''}`.trim() : 'Unknown',
                    email: attendance.employee?.email
                },
                date: attendance.date,
                status: attendance.status,
                notes: attendance.notes,
                createdAt: attendance.createdAt,
                updatedAt: attendance.updatedAt
            }));

            return res.status(200).json({
                message: 'Attendance records fetched successfully',
                data: transformedData
            });
        } catch (error) {
            console.error('Get all attendances error:', error);
            return res.status(500).json({ message: 'Error fetching attendance records', error: error.message });
        }
    },

    // GET /attendance/:id - Get single attendance record
    getAttendanceById: async (req, res) => {
        try {
            const { id } = req.params;

            const attendance = await Attendance.findOne({ _id: id, isDeleted: { $ne: true } })
                .populate('employee', 'firstName lastName email');

            if (!attendance) {
                return res.status(404).json({ message: 'Attendance record not found' });
            }

            const transformedData = {
                _id: attendance._id,
                employee: {
                    _id: attendance.employee?._id,
                    name: attendance.employee ? `${attendance.employee.firstName || ''} ${attendance.employee.lastName || ''}`.trim() : 'Unknown',
                    email: attendance.employee?.email
                },
                date: attendance.date,
                status: attendance.status,
                notes: attendance.notes,
                createdAt: attendance.createdAt,
                updatedAt: attendance.updatedAt
            };

            return res.status(200).json({
                message: 'Attendance record fetched successfully',
                data: transformedData
            });
        } catch (error) {
            console.error('Get attendance by ID error:', error);
            return res.status(500).json({ message: 'Error fetching attendance record', error: error.message });
        }
    },

    // POST /attendance - Create new attendance record
    createAttendance: async (req, res) => {
        try {
            const { employeeId, date, status, notes } = req.body;

            // Validate employee exists
            const employee = await Employee.findOne({ _id: employeeId, isDeleted: { $ne: true } });
            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            // Parse and normalize date to start of day for comparison
            const attendanceDate = new Date(date);
            attendanceDate.setHours(0, 0, 0, 0);

            // Check for duplicate attendance record
            const existing = await Attendance.findOne({
                employee: employeeId,
                date: attendanceDate,
                isDeleted: { $ne: true }
            });
            if (existing) {
                return res.status(409).json({
                    message: `Attendance record already exists for this employee on ${attendanceDate.toDateString()}`
                });
            }

            const attendance = new Attendance({
                employee: employeeId,
                date: attendanceDate,
                status,
                notes
            });

            await attendance.save();

            const populated = await Attendance.findById(attendance._id)
                .populate('employee', 'firstName lastName email');

            const transformedData = {
                _id: populated._id,
                employee: {
                    _id: populated.employee?._id,
                    name: populated.employee ? `${populated.employee.firstName || ''} ${populated.employee.lastName || ''}`.trim() : 'Unknown',
                    email: populated.employee?.email
                },
                date: populated.date,
                status: populated.status,
                notes: populated.notes,
                createdAt: populated.createdAt,
                updatedAt: populated.updatedAt
            };

            return res.status(201).json({
                message: 'Attendance record created successfully',
                data: transformedData
            });
        } catch (error) {
            console.error('Create attendance error:', error);
            return res.status(400).json({ message: 'Error creating attendance record', error: error.message });
        }
    },

    // PUT /attendance/:id - Update attendance record
    updateAttendance: async (req, res) => {
        try {
            const { id } = req.params;
            const { date, status, notes } = req.body;

            const attendance = await Attendance.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!attendance) {
                return res.status(404).json({ message: 'Attendance record not found' });
            }

            if (date !== undefined) {
                const newDate = new Date(date);
                newDate.setHours(0, 0, 0, 0);
                attendance.date = newDate;
            }
            if (status !== undefined) attendance.status = status;
            if (notes !== undefined) attendance.notes = notes;

            await attendance.save();

            const populated = await Attendance.findById(attendance._id)
                .populate('employee', 'firstName lastName email');

            const transformedData = {
                _id: populated._id,
                employee: {
                    _id: populated.employee?._id,
                    name: populated.employee ? `${populated.employee.firstName || ''} ${populated.employee.lastName || ''}`.trim() : 'Unknown',
                    email: populated.employee?.email
                },
                date: populated.date,
                status: populated.status,
                notes: populated.notes,
                createdAt: populated.createdAt,
                updatedAt: populated.updatedAt
            };

            return res.status(200).json({
                message: 'Attendance record updated successfully',
                data: transformedData
            });
        } catch (error) {
            console.error('Update attendance error:', error);
            return res.status(400).json({ message: 'Error updating attendance record', error: error.message });
        }
    },

    // DELETE /attendance/:id - Soft delete attendance record
    deleteAttendance: async (req, res) => {
        try {
            const { id } = req.params;

            const attendance = await Attendance.findOne({ _id: id, isDeleted: { $ne: true } });
            if (!attendance) {
                return res.status(404).json({ message: 'Attendance record not found' });
            }

            attendance.isDeleted = true;
            attendance.deletedAt = new Date();
            attendance.deletedBy = req.user?.id || req.user?._id || null;
            await attendance.save();

            return res.status(200).json({ message: 'Attendance record deleted successfully' });
        } catch (error) {
            console.error('Delete attendance error:', error);
            return res.status(500).json({ message: 'Error deleting attendance record', error: error.message });
        }
    }
};

module.exports = attendanceController;
