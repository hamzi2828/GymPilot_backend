const express = require('express');
const router = express.Router();
const dashboardController = require('../controller/dashboardController');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/', dashboardController.getDashboardData);

router.get('/stats', dashboardController.getDashboardStats);

router.get('/recent-orders', dashboardController.getRecentOrders);

router.get('/quick-stats', dashboardController.getQuickStats);

router.get('/sales-trend', dashboardController.getSalesTrend);

router.get('/top-products', dashboardController.getTopProducts);

router.get('/recent-activity', dashboardController.getRecentActivity);

router.get('/customer-distribution', dashboardController.getCustomerDistribution);

router.get('/analytics', dashboardController.getAnalytics);

router.get('/report', dashboardController.generateReport);

router.get('/export', dashboardController.exportData);

router.post('/refresh', dashboardController.refreshDashboard);

router.get('/notifications', dashboardController.getNotifications);

router.patch('/notifications/:notificationId/read', dashboardController.markNotificationAsRead);

router.get('/metrics/:metricType', dashboardController.getMetrics);

router.get('/revenue-breakdown', dashboardController.getRevenueBreakdown);

router.get('/inventory-status', dashboardController.getInventoryStatus);

router.get('/performance-metrics', dashboardController.getPerformanceMetrics);

module.exports = router;