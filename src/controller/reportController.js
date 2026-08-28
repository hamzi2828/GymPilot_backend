// src/controller/reportController.js

const POSOrder = require('../models/posOrder');
const Purchase = require('../models/purchase');
const Expense = require('../models/expense');
const Customer = require('../models/customer');
const mongoose = require('mongoose');

const reportController = {
    // GET /reports/sales - Sales Report
    getSalesReport: async (req, res) => {
        try {
            const { startDate, endDate, groupBy = 'day' } = req.query;

            if (!startDate || !endDate) {
                return res.status(400).json({ message: 'Start date and end date are required' });
            }

            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);

            // Base query for POS orders
            const baseQuery = {
                isDeleted: { $ne: true },
                orderStatus: { $nin: ['cancelled', 'refunded'] },
                createdAt: { $gte: start, $lte: end }
            };

            // Total sales aggregation
            const totals = await POSOrder.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: '$total' },
                        totalOrders: { $sum: 1 },
                        totalPaid: { $sum: '$paidAmount' },
                        totalPending: { $sum: '$pendingAmount' },
                        totalDiscount: { $sum: '$discount' },
                        totalTax: { $sum: '$tax' }
                    }
                }
            ]);

            const summary = totals[0] || {
                totalSales: 0,
                totalOrders: 0,
                totalPaid: 0,
                totalPending: 0,
                totalDiscount: 0,
                totalTax: 0
            };

            // Calculate previous period for comparison
            const periodLength = end.getTime() - start.getTime();
            const previousStart = new Date(start.getTime() - periodLength);
            const previousEnd = new Date(start.getTime() - 1);

            const previousTotals = await POSOrder.aggregate([
                {
                    $match: {
                        ...baseQuery,
                        createdAt: { $gte: previousStart, $lte: previousEnd }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalSales: { $sum: '$total' }
                    }
                }
            ]);

            const previousSales = previousTotals[0]?.totalSales || 0;
            const percentChange = previousSales > 0
                ? ((summary.totalSales - previousSales) / previousSales) * 100
                : 0;

            // Sales by day
            const salesByDay = await POSOrder.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                        },
                        sales: { $sum: '$total' },
                        orders: { $sum: 1 }
                    }
                },
                { $sort: { _id: -1 } },
                {
                    $project: {
                        _id: 0,
                        date: '$_id',
                        sales: 1,
                        orders: 1
                    }
                }
            ]);

            // Sales by payment method
            const salesByPaymentMethod = await POSOrder.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: '$paymentMethod',
                        amount: { $sum: '$total' },
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        method: '$_id',
                        amount: 1,
                        count: 1
                    }
                }
            ]);

            // Top products
            const topProducts = await POSOrder.aggregate([
                { $match: baseQuery },
                { $unwind: '$items' },
                {
                    $group: {
                        _id: '$items.product',
                        name: { $first: { $ifNull: ['$items.labourDescription', '$items.outsourceDescription'] } },
                        quantity: { $sum: '$items.quantity' },
                        revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
                    }
                },
                { $sort: { revenue: -1 } },
                { $limit: 10 },
                {
                    $project: {
                        _id: 0,
                        productId: '$_id',
                        name: { $ifNull: ['$name', 'Product'] },
                        quantity: 1,
                        revenue: 1
                    }
                }
            ]);

            // Top customers
            const topCustomers = await POSOrder.aggregate([
                { $match: { ...baseQuery, customer: { $ne: null } } },
                {
                    $group: {
                        _id: '$customer',
                        orders: { $sum: 1 },
                        totalSpent: { $sum: '$total' }
                    }
                },
                { $sort: { totalSpent: -1 } },
                { $limit: 10 },
                {
                    $lookup: {
                        from: 'customers',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'customerInfo'
                    }
                },
                { $unwind: { path: '$customerInfo', preserveNullAndEmptyArrays: true } },
                {
                    $project: {
                        _id: 0,
                        customerId: '$_id',
                        name: {
                            $concat: [
                                { $ifNull: ['$customerInfo.firstName', ''] },
                                ' ',
                                { $ifNull: ['$customerInfo.lastName', ''] }
                            ]
                        },
                        orders: 1,
                        totalSpent: 1
                    }
                }
            ]);

            // Sales by category (using order type)
            const salesByCategory = await POSOrder.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: '$orderType',
                        sales: { $sum: '$total' },
                        quantity: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        category: { $ifNull: ['$_id', 'standard'] },
                        sales: 1,
                        quantity: 1
                    }
                }
            ]);

            const averageOrderValue = summary.totalOrders > 0
                ? summary.totalSales / summary.totalOrders
                : 0;

            return res.status(200).json({
                message: 'Sales report fetched successfully',
                data: {
                    totalSales: summary.totalSales,
                    totalOrders: summary.totalOrders,
                    averageOrderValue,
                    netSales: summary.totalSales - summary.totalDiscount,
                    percentChange,
                    salesByDay,
                    salesByPaymentMethod,
                    topProducts,
                    topCustomers,
                    salesByCategory
                }
            });
        } catch (error) {
            console.error('Error fetching sales report:', error);
            return res.status(500).json({ message: 'Failed to fetch sales report' });
        }
    },

    // GET /reports/purchases - Purchase Report
    getPurchaseReport: async (req, res) => {
        try {
            const { startDate, endDate, groupBy = 'day' } = req.query;

            if (!startDate || !endDate) {
                return res.status(400).json({ message: 'Start date and end date are required' });
            }

            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);

            const baseQuery = {
                isDeleted: { $ne: true },
                purchaseDate: { $gte: start, $lte: end }
            };

            // Total purchase aggregation
            const totals = await Purchase.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: null,
                        totalPurchases: { $sum: 1 },
                        totalAmount: { $sum: '$total' },
                        totalPaid: { $sum: '$paidAmount' },
                        totalPending: { $sum: '$pendingAmount' }
                    }
                }
            ]);

            const summary = totals[0] || {
                totalPurchases: 0,
                totalAmount: 0,
                totalPaid: 0,
                totalPending: 0
            };

            // Calculate overdue
            const overdueData = await Purchase.aggregate([
                {
                    $match: {
                        ...baseQuery,
                        paymentStatus: { $in: ['pending', 'partial'] },
                        dueDate: { $lt: new Date() }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalOverdue: { $sum: '$pendingAmount' }
                    }
                }
            ]);

            const totalOverdue = overdueData[0]?.totalOverdue || 0;

            // Purchases by day
            const purchasesByDay = await Purchase.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$purchaseDate' }
                        },
                        amount: { $sum: '$total' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: -1 } },
                {
                    $project: {
                        _id: 0,
                        date: '$_id',
                        amount: 1,
                        count: 1
                    }
                }
            ]);

            // Payment status breakdown
            const paymentStatus = await Purchase.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: '$paymentStatus',
                        amount: { $sum: '$total' },
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        status: '$_id',
                        amount: 1,
                        count: 1
                    }
                }
            ]);

            // Purchases by vendor
            const purchasesByVendor = await Purchase.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: '$vendorId',
                        totalPurchases: { $sum: 1 },
                        totalAmount: { $sum: '$total' },
                        paidAmount: { $sum: '$paidAmount' },
                        pendingAmount: { $sum: '$pendingAmount' }
                    }
                },
                {
                    $lookup: {
                        from: 'vendors',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'vendorInfo'
                    }
                },
                { $unwind: { path: '$vendorInfo', preserveNullAndEmptyArrays: true } },
                {
                    $project: {
                        _id: 0,
                        vendorId: '$_id',
                        vendorName: { $ifNull: ['$vendorInfo.name', 'Unknown Vendor'] },
                        totalPurchases: 1,
                        totalAmount: 1,
                        paidAmount: 1,
                        pendingAmount: 1
                    }
                },
                { $sort: { totalAmount: -1 } }
            ]);

            return res.status(200).json({
                message: 'Purchase report fetched successfully',
                data: {
                    totalPurchases: summary.totalPurchases,
                    totalAmount: summary.totalAmount,
                    totalPaid: summary.totalPaid,
                    totalPending: summary.totalPending,
                    totalOverdue,
                    purchasesByDay,
                    paymentStatus,
                    purchasesByVendor
                }
            });
        } catch (error) {
            console.error('Error fetching purchase report:', error);
            return res.status(500).json({ message: 'Failed to fetch purchase report' });
        }
    },

    // GET /reports/cost-analysis - Cost Analysis Report
    getCostAnalysis: async (req, res) => {
        try {
            const { startDate, endDate } = req.query;

            if (!startDate || !endDate) {
                return res.status(400).json({ message: 'Start date and end date are required' });
            }

            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);

            // Get total revenue from POS orders
            const revenueData = await POSOrder.aggregate([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        orderStatus: { $nin: ['cancelled', 'refunded'] },
                        createdAt: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalRevenue: { $sum: '$total' },
                        totalOrders: { $sum: 1 }
                    }
                }
            ]);

            const totalRevenue = revenueData[0]?.totalRevenue || 0;

            // Get total expenses
            const expenseData = await Expense.aggregate([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        date: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalExpenses: { $sum: '$amount' }
                    }
                }
            ]);

            const totalExpenses = expenseData[0]?.totalExpenses || 0;

            // Get purchase costs
            const purchaseData = await Purchase.aggregate([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        purchaseDate: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalPurchaseCost: { $sum: '$total' }
                    }
                }
            ]);

            const totalPurchaseCost = purchaseData[0]?.totalPurchaseCost || 0;

            // Calculate profit
            const totalCost = totalExpenses + totalPurchaseCost;
            const grossProfit = totalRevenue - totalCost;
            const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

            // Expense by category
            const expenseByCategory = await Expense.aggregate([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        date: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: '$category',
                        amount: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { amount: -1 } },
                {
                    $project: {
                        _id: 0,
                        category: '$_id',
                        amount: 1,
                        count: 1,
                        percentage: {
                            $multiply: [
                                { $divide: ['$amount', { $max: [totalExpenses, 1] }] },
                                100
                            ]
                        }
                    }
                }
            ]);

            // Monthly trends
            const monthlyTrends = await POSOrder.aggregate([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        orderStatus: { $nin: ['cancelled', 'refunded'] },
                        createdAt: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m', date: '$createdAt' }
                        },
                        revenue: { $sum: '$total' }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            // Get expense trends for same period
            const expenseTrends = await Expense.aggregate([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        date: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m', date: '$date' }
                        },
                        expenses: { $sum: '$amount' }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            // Merge trends
            const trendMap = new Map();
            monthlyTrends.forEach(t => {
                trendMap.set(t._id, { month: t._id, revenue: t.revenue, expenses: 0, profit: t.revenue });
            });
            expenseTrends.forEach(t => {
                if (trendMap.has(t._id)) {
                    const existing = trendMap.get(t._id);
                    existing.expenses = t.expenses;
                    existing.profit = existing.revenue - t.expenses;
                } else {
                    trendMap.set(t._id, { month: t._id, revenue: 0, expenses: t.expenses, profit: -t.expenses });
                }
            });

            const trends = Array.from(trendMap.values()).sort((a, b) => a.month.localeCompare(b.month));

            // Top expense items
            const topExpenses = await Expense.find({
                isDeleted: { $ne: true },
                date: { $gte: start, $lte: end }
            })
                .sort({ amount: -1 })
                .limit(10)
                .select('title amount category date');

            return res.status(200).json({
                message: 'Cost analysis report fetched successfully',
                data: {
                    totalRevenue,
                    totalExpenses,
                    totalPurchaseCost,
                    totalCost,
                    grossProfit,
                    profitMargin,
                    expenseByCategory,
                    trends,
                    topExpenses
                }
            });
        } catch (error) {
            console.error('Error fetching cost analysis:', error);
            return res.status(500).json({ message: 'Failed to fetch cost analysis report' });
        }
    },

    // GET /reports/receivables - Receivables Report
    getReceivablesReport: async (req, res) => {
        try {
            const { status, sortBy = 'pendingAmount', sortOrder = 'desc' } = req.query;

            // Get all orders with pending payments (both with customer ref and customerInfo)
            const pendingOrders = await POSOrder.aggregate([
                {
                    $match: {
                        isDeleted: { $ne: true },
                        paymentStatus: { $in: ['pending', 'partial'] },
                        $or: [
                            { customer: { $ne: null } },
                            { 'customerInfo.name': { $exists: true, $ne: '' } },
                            { 'customerInfo.phone': { $exists: true, $ne: '' } }
                        ]
                    }
                },
                {
                    $lookup: {
                        from: 'customers',
                        localField: 'customer',
                        foreignField: '_id',
                        as: 'customerData'
                    }
                },
                {
                    $addFields: {
                        resolvedCustomerId: {
                            $cond: {
                                if: { $gt: [{ $size: '$customerData' }, 0] },
                                then: '$customer',
                                else: { $ifNull: ['$customerInfo.phone', '$customerInfo.name'] }
                            }
                        },
                        resolvedCustomerName: {
                            $cond: {
                                if: { $gt: [{ $size: '$customerData' }, 0] },
                                then: { $concat: [{ $arrayElemAt: ['$customerData.firstName', 0] }, ' ', { $arrayElemAt: ['$customerData.lastName', 0] }] },
                                else: { $ifNull: ['$customerInfo.name', 'Walk-in Customer'] }
                            }
                        },
                        resolvedCustomerCode: {
                            $cond: {
                                if: { $gt: [{ $size: '$customerData' }, 0] },
                                then: { $arrayElemAt: ['$customerData.customerCode', 0] },
                                else: ''
                            }
                        },
                        resolvedPhone: {
                            $cond: {
                                if: { $gt: [{ $size: '$customerData' }, 0] },
                                then: { $arrayElemAt: ['$customerData.phone', 0] },
                                else: { $ifNull: ['$customerInfo.phone', ''] }
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: '$resolvedCustomerId',
                        customerName: { $first: '$resolvedCustomerName' },
                        customerCode: { $first: '$resolvedCustomerCode' },
                        phone: { $first: '$resolvedPhone' },
                        totalOrders: { $sum: 1 },
                        totalAmount: { $sum: '$total' },
                        paidAmount: { $sum: '$paidAmount' },
                        pendingAmount: { $sum: '$pendingAmount' },
                        oldestDueDate: { $min: '$createdAt' },
                        lastPaymentDate: { $max: '$completedAt' }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        customerId: '$_id',
                        customerName: 1,
                        customerCode: { $ifNull: ['$customerCode', ''] },
                        phone: { $ifNull: ['$phone', ''] },
                        totalOrders: 1,
                        totalAmount: 1,
                        paidAmount: 1,
                        pendingAmount: 1,
                        oldestDueDate: 1,
                        lastPaymentDate: 1
                    }
                }
            ]);

            const customersWithPending = pendingOrders;

            // Calculate status based on age
            const now = new Date();
            const receivables = customersWithPending.map(r => {
                const daysOverdue = Math.floor((now - new Date(r.oldestDueDate)) / (1000 * 60 * 60 * 24));
                let receivableStatus = 'current';
                if (daysOverdue > 60) {
                    receivableStatus = 'critical';
                } else if (daysOverdue > 30) {
                    receivableStatus = 'overdue';
                }
                return { ...r, status: receivableStatus, daysOverdue };
            });

            // Filter by status if provided
            let filteredReceivables = receivables;
            if (status && status !== 'all') {
                filteredReceivables = receivables.filter(r => r.status === status);
            }

            // Sort
            const sortMultiplier = sortOrder === 'asc' ? 1 : -1;
            filteredReceivables.sort((a, b) => {
                if (sortBy === 'customerName') {
                    return a.customerName.localeCompare(b.customerName) * sortMultiplier;
                } else if (sortBy === 'oldestDueDate') {
                    return (new Date(a.oldestDueDate) - new Date(b.oldestDueDate)) * sortMultiplier;
                }
                return (a.pendingAmount - b.pendingAmount) * sortMultiplier;
            });

            // Calculate totals
            const totalCustomers = receivables.length;
            const totalReceivables = receivables.reduce((sum, r) => sum + r.pendingAmount, 0);
            const currentAmount = receivables
                .filter(r => r.status === 'current')
                .reduce((sum, r) => sum + r.pendingAmount, 0);
            const overdueAmount = receivables
                .filter(r => r.status === 'overdue')
                .reduce((sum, r) => sum + r.pendingAmount, 0);
            const criticalAmount = receivables
                .filter(r => r.status === 'critical')
                .reduce((sum, r) => sum + r.pendingAmount, 0);

            // Aging summary
            const agingBuckets = [
                { bucket: '0-30', min: 0, max: 30 },
                { bucket: '31-60', min: 31, max: 60 },
                { bucket: '61-90', min: 61, max: 90 },
                { bucket: '91-120', min: 91, max: 120 },
                { bucket: '120+', min: 121, max: Infinity }
            ];

            const agingSummary = agingBuckets.map(bucket => {
                const filtered = receivables.filter(r =>
                    r.daysOverdue >= bucket.min && r.daysOverdue <= bucket.max
                );
                return {
                    bucket: bucket.bucket,
                    amount: filtered.reduce((sum, r) => sum + r.pendingAmount, 0),
                    count: filtered.length
                };
            });

            return res.status(200).json({
                message: 'Receivables report fetched successfully',
                data: {
                    totalCustomers,
                    totalReceivables,
                    currentAmount,
                    overdueAmount,
                    criticalAmount,
                    agingSummary,
                    receivables: filteredReceivables
                }
            });
        } catch (error) {
            console.error('Error fetching receivables report:', error);
            return res.status(500).json({ message: 'Failed to fetch receivables report' });
        }
    },

    // POST /reports/export - Export report
    exportReport: async (req, res) => {
        try {
            const { type, startDate, endDate, format = 'csv' } = req.body;

            if (!type) {
                return res.status(400).json({ message: 'Report type is required' });
            }

            // For now, generate CSV content based on report type
            let data = [];
            let filename = '';
            let headers = [];

            if (type === 'sales') {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);

                const orders = await POSOrder.find({
                    isDeleted: { $ne: true },
                    orderStatus: { $nin: ['cancelled', 'refunded'] },
                    createdAt: { $gte: start, $lte: end }
                }).populate('customer', 'firstName lastName');

                headers = ['Order Number', 'Date', 'Customer', 'Total', 'Paid', 'Pending', 'Payment Method', 'Status'];
                data = orders.map(o => [
                    o.orderNumber,
                    new Date(o.createdAt).toLocaleDateString(),
                    o.customer ? `${o.customer.firstName} ${o.customer.lastName}` : 'Walk-in',
                    o.total,
                    o.paidAmount,
                    o.pendingAmount,
                    o.paymentMethod,
                    o.paymentStatus
                ]);
                filename = `sales-report-${startDate}-${endDate}`;
            } else if (type === 'purchases') {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);

                const purchases = await Purchase.find({
                    isDeleted: { $ne: true },
                    purchaseDate: { $gte: start, $lte: end }
                }).populate('vendorId', 'name');

                headers = ['Invoice', 'Date', 'Vendor', 'Total', 'Paid', 'Pending', 'Status'];
                data = purchases.map(p => [
                    p.invoiceNumber,
                    new Date(p.purchaseDate).toLocaleDateString(),
                    p.vendorId?.name || 'Unknown',
                    p.total,
                    p.paidAmount,
                    p.pendingAmount,
                    p.paymentStatus
                ]);
                filename = `purchase-report-${startDate}-${endDate}`;
            } else if (type === 'cost-analysis') {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);

                const expenses = await Expense.find({
                    isDeleted: { $ne: true },
                    date: { $gte: start, $lte: end }
                });

                headers = ['Title', 'Category', 'Amount', 'Date', 'Payment Method'];
                data = expenses.map(e => [
                    e.title,
                    e.category,
                    e.amount,
                    new Date(e.date).toLocaleDateString(),
                    e.paymentMethod
                ]);
                filename = `cost-analysis-${startDate}-${endDate}`;
            } else if (type === 'receivables') {
                const orders = await POSOrder.find({
                    isDeleted: { $ne: true },
                    customer: { $ne: null },
                    paymentStatus: { $in: ['pending', 'partial'] }
                }).populate('customer', 'firstName lastName customerCode phone');

                headers = ['Customer', 'Code', 'Phone', 'Order #', 'Total', 'Paid', 'Pending', 'Date'];
                data = orders.map(o => [
                    o.customer ? `${o.customer.firstName} ${o.customer.lastName}` : '',
                    o.customer?.customerCode || '',
                    o.customer?.phone || '',
                    o.orderNumber,
                    o.total,
                    o.paidAmount,
                    o.pendingAmount,
                    new Date(o.createdAt).toLocaleDateString()
                ]);
                filename = 'receivables-report';
            }

            // Generate CSV
            const csvContent = [
                headers.join(','),
                ...data.map(row => row.map(cell => `"${cell}"`).join(','))
            ].join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
            return res.send(csvContent);
        } catch (error) {
            console.error('Error exporting report:', error);
            return res.status(500).json({ message: 'Failed to export report' });
        }
    }
};

module.exports = reportController;
