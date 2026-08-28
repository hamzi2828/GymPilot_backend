// src/controller/activityLogController.js

const mongoose = require('mongoose');
const ActivityLog = require('../models/activityLog');
const Employee = require('../models/employee');

const activityLogController = {
    // POST /activity-logs - Create activity log
    createLog: async (req, res) => {
        try {
            const { employeeId, action, module, description, metadata } = req.body;

            if (!employeeId || !action || !module) {
                return res.status(400).json({ message: 'employeeId, action, and module are required' });
            }

            // Verify employee exists
            const employee = await Employee.findOne({ _id: employeeId, isDeleted: { $ne: true } });
            if (!employee) {
                return res.status(404).json({ message: 'Employee not found' });
            }

            const log = await ActivityLog.create({
                employee: employeeId,
                action,
                module,
                description: description || null,
                metadata: metadata || {},
                ipAddress: req.ip || req.connection?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });

            return res.status(201).json({
                message: 'Activity logged successfully',
                data: log
            });
        } catch (error) {
            console.error('Error creating activity log:', error);
            return res.status(500).json({ message: 'Failed to create activity log' });
        }
    },

    // GET /activity-logs - Get all activity logs (with filters)
    getAllLogs: async (req, res) => {
        try {
            const { employeeId, module, action, startDate, endDate, limit = 100 } = req.query;

            const filter = {};

            if (employeeId) {
                filter.employee = employeeId;
            }

            if (module) {
                filter.module = module;
            }

            if (action) {
                filter.action = action;
            }

            if (startDate || endDate) {
                filter.createdAt = {};
                if (startDate) {
                    filter.createdAt.$gte = new Date(startDate);
                }
                if (endDate) {
                    filter.createdAt.$lte = new Date(endDate);
                }
            }

            const logs = await ActivityLog.find(filter)
                .populate('employee', 'firstName lastName email position')
                .sort({ createdAt: -1 })
                .limit(parseInt(limit));

            return res.status(200).json({
                message: 'Activity logs fetched successfully',
                data: logs
            });
        } catch (error) {
            console.error('Error fetching activity logs:', error);
            return res.status(500).json({ message: 'Failed to fetch activity logs' });
        }
    },

    // GET /activity-logs/employee/:employeeId - Get logs for specific employee
    getLogsByEmployee: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const { limit = 50, page = 1 } = req.query;

            const skip = (parseInt(page) - 1) * parseInt(limit);

            const logs = await ActivityLog.find({ employee: employeeId })
                .populate('employee', 'firstName lastName email position')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit));

            const total = await ActivityLog.countDocuments({ employee: employeeId });

            // Get summary by module
            const summary = await ActivityLog.aggregate([
                { $match: { employee: new mongoose.Types.ObjectId(employeeId) } },
                { $group: { _id: '$module', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]);

            return res.status(200).json({
                message: 'Activity logs fetched successfully',
                data: logs,
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit)),
                summary
            });
        } catch (error) {
            console.error('Error fetching employee activity logs:', error);
            return res.status(500).json({ message: 'Failed to fetch activity logs' });
        }
    },

    // GET /activity-logs/summary/:employeeId - Get activity summary for employee
    getEmployeeSummary: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const { days = 30 } = req.query;

            const startDate = new Date();
            startDate.setDate(startDate.getDate() - parseInt(days));

            const summary = await ActivityLog.aggregate([
                {
                    $match: {
                        employee: new mongoose.Types.ObjectId(employeeId),
                        createdAt: { $gte: startDate }
                    }
                },
                {
                    $group: {
                        _id: '$module',
                        count: { $sum: 1 },
                        lastAccess: { $max: '$createdAt' }
                    }
                },
                { $sort: { count: -1 } }
            ]);

            const totalActivities = summary.reduce((acc, item) => acc + item.count, 0);

            return res.status(200).json({
                message: 'Activity summary fetched successfully',
                data: {
                    summary,
                    totalActivities,
                    period: `Last ${days} days`
                }
            });
        } catch (error) {
            console.error('Error fetching activity summary:', error);
            return res.status(500).json({ message: 'Failed to fetch activity summary' });
        }
    },
};

module.exports = activityLogController;
