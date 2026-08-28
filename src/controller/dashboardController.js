const dashboardService = require('../services/dashboardService');

class DashboardController {
  async getDashboardData(req, res) {
    try {
      const { timeRange = 'week' } = req.query;
      const dashboardData = await dashboardService.getDashboardData(timeRange);
      res.status(200).json(dashboardData);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
  }

  async getDashboardStats(req, res) {
    try {
      const { timeRange = 'week' } = req.query;
      const stats = await dashboardService.getDashboardStats(timeRange);
      res.status(200).json(stats);
    } catch (error) {
      console.error('Error fetching dashboard stats:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    }
  }

  async getRecentOrders(req, res) {
    try {
      const { limit = 10 } = req.query;
      const orders = await dashboardService.getRecentOrders(parseInt(limit));
      res.status(200).json(orders);
    } catch (error) {
      console.error('Error fetching recent orders:', error);
      res.status(500).json({ error: 'Failed to fetch recent orders' });
    }
  }

  async getQuickStats(req, res) {
    try {
      const stats = await dashboardService.getQuickStats();
      res.status(200).json(stats);
    } catch (error) {
      console.error('Error fetching quick stats:', error);
      res.status(500).json({ error: 'Failed to fetch quick stats' });
    }
  }

  async getSalesTrend(req, res) {
    try {
      const { timeRange = 'week', interval = 'day' } = req.query;
      const trend = await dashboardService.getSalesTrend(timeRange, interval);
      res.status(200).json(trend);
    } catch (error) {
      console.error('Error fetching sales trend:', error);
      res.status(500).json({ error: 'Failed to fetch sales trend' });
    }
  }

  async getTopProducts(req, res) {
    try {
      const { limit = 10, timeRange = 'month' } = req.query;
      const products = await dashboardService.getTopProducts(parseInt(limit), timeRange);
      res.status(200).json(products);
    } catch (error) {
      console.error('Error fetching top products:', error);
      res.status(500).json({ error: 'Failed to fetch top products' });
    }
  }

  async getRecentActivity(req, res) {
    try {
      const { limit = 20 } = req.query;
      const activities = await dashboardService.getRecentActivity(parseInt(limit));
      res.status(200).json(activities);
    } catch (error) {
      console.error('Error fetching recent activity:', error);
      res.status(500).json({ error: 'Failed to fetch recent activity' });
    }
  }

  async getCustomerDistribution(req, res) {
    try {
      const distribution = await dashboardService.getCustomerDistribution();
      res.status(200).json(distribution);
    } catch (error) {
      console.error('Error fetching customer distribution:', error);
      res.status(500).json({ error: 'Failed to fetch customer distribution' });
    }
  }

  async getAnalytics(req, res) {
    try {
      const { timeRange = 'month' } = req.query;
      const analytics = await dashboardService.getAnalytics(timeRange);
      res.status(200).json(analytics);
    } catch (error) {
      console.error('Error fetching analytics:', error);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  }

  async generateReport(req, res) {
    try {
      const { timeRange = 'month' } = req.query;
      const report = await dashboardService.generateReport(timeRange);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=dashboard-report-${Date.now()}.pdf`);
      res.send(report);
    } catch (error) {
      console.error('Error generating report:', error);
      res.status(500).json({ error: 'Failed to generate report' });
    }
  }

  async exportData(req, res) {
    try {
      const { format = 'csv', timeRange = 'month' } = req.query;
      const data = await dashboardService.exportData(format, timeRange);

      const contentTypes = {
        csv: 'text/csv',
        excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pdf: 'application/pdf'
      };

      const extensions = {
        csv: 'csv',
        excel: 'xlsx',
        pdf: 'pdf'
      };

      res.setHeader('Content-Type', contentTypes[format] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename=dashboard-export-${Date.now()}.${extensions[format]}`);
      res.send(data);
    } catch (error) {
      console.error('Error exporting data:', error);
      res.status(500).json({ error: 'Failed to export data' });
    }
  }

  async refreshDashboard(req, res) {
    try {
      await dashboardService.refreshDashboardCache();
      res.status(200).json({ message: 'Dashboard refreshed successfully' });
    } catch (error) {
      console.error('Error refreshing dashboard:', error);
      res.status(500).json({ error: 'Failed to refresh dashboard' });
    }
  }

  async getNotifications(req, res) {
    try {
      const { unreadOnly = false } = req.query;
      const userId = req.user?.id;
      const notifications = await dashboardService.getNotifications(userId, unreadOnly === 'true');
      res.status(200).json(notifications);
    } catch (error) {
      console.error('Error fetching notifications:', error);
      res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  }

  async markNotificationAsRead(req, res) {
    try {
      const { notificationId } = req.params;
      const userId = req.user?.id;
      await dashboardService.markNotificationAsRead(notificationId, userId);
      res.status(200).json({ message: 'Notification marked as read' });
    } catch (error) {
      console.error('Error marking notification as read:', error);
      res.status(500).json({ error: 'Failed to mark notification as read' });
    }
  }

  async getMetrics(req, res) {
    try {
      const { metricType } = req.params;
      const { timeRange = 'month' } = req.query;
      const metrics = await dashboardService.getMetrics(metricType, timeRange);
      res.status(200).json(metrics);
    } catch (error) {
      console.error(`Error fetching ${req.params.metricType} metrics:`, error);
      res.status(500).json({ error: 'Failed to fetch metrics' });
    }
  }

  async getRevenueBreakdown(req, res) {
    try {
      const { timeRange = 'month' } = req.query;
      const breakdown = await dashboardService.getRevenueBreakdown(timeRange);
      res.status(200).json(breakdown);
    } catch (error) {
      console.error('Error fetching revenue breakdown:', error);
      res.status(500).json({ error: 'Failed to fetch revenue breakdown' });
    }
  }

  async getInventoryStatus(req, res) {
    try {
      const status = await dashboardService.getInventoryStatus();
      res.status(200).json(status);
    } catch (error) {
      console.error('Error fetching inventory status:', error);
      res.status(500).json({ error: 'Failed to fetch inventory status' });
    }
  }

  async getPerformanceMetrics(req, res) {
    try {
      const { timeRange = 'week' } = req.query;
      const metrics = await dashboardService.getPerformanceMetrics(timeRange);
      res.status(200).json(metrics);
    } catch (error) {
      console.error('Error fetching performance metrics:', error);
      res.status(500).json({ error: 'Failed to fetch performance metrics' });
    }
  }
}

module.exports = new DashboardController();