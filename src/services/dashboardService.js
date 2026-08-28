const Order = require('../models/order');
const User = require('../models/user');
const Product = require('../models/product');

class DashboardService {
  async getDashboardData(timeRange) {
    const [stats, recentOrders, quickStats, salesTrend, topProducts, recentActivity, customerDistribution] = await Promise.all([
      this.getDashboardStats(timeRange),
      this.getRecentOrders(10),
      this.getQuickStats(),
      this.getSalesTrend(timeRange, 'day'),
      this.getTopProducts(10, timeRange),
      this.getRecentActivity(20),
      this.getCustomerDistribution()
    ]);

    return {
      stats,
      recentOrders,
      quickStats,
      salesTrend,
      topProducts,
      recentActivity,
      customerDistribution
    };
  }

  async getDashboardStats(timeRange) {
    const dateFilter = this.getDateFilter(timeRange);

    const [totalOrders, totalUsers, totalProducts, orderStats] = await Promise.all([
      Order.countDocuments(dateFilter),
      User.countDocuments(),
      Product.countDocuments({ status: 'published' }),
      Order.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total' },
            avgOrderValue: { $avg: '$total' },
            ordersToday: {
              $sum: {
                $cond: [
                  { $gte: ['$createdAt', new Date().setHours(0, 0, 0, 0)] },
                  1,
                  0
                ]
              }
            }
          }
        }
      ])
    ]);

    const stats = orderStats[0] || { totalRevenue: 0, avgOrderValue: 0, ordersToday: 0 };

    const conversionRate = await this.calculateConversionRate(timeRange);
    const refundRate = await this.calculateRefundRate(timeRange);

    return {
      totalSales: totalOrders,
      totalUsers,
      totalProducts,
      totalRevenue: stats.totalRevenue,
      ordersToday: stats.ordersToday,
      avgOrderValue: stats.avgOrderValue,
      conversionRate,
      refundRate
    };
  }

  async getRecentOrders(limit) {
    const orders = await Order.find()
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return orders.map(order => ({
      id: order._id.toString(),
      customerId: order.user?._id?.toString() || '',
      customerName: order.user?.name || 'Guest',
      amount: order.total,
      status: order.orderStatus || order.status,
      createdAt: order.createdAt
    }));
  }

  async getQuickStats() {
    const [pendingOrders, lowStockItems, newCustomers, returnedItems] = await Promise.all([
      Order.countDocuments({ orderStatus: 'submitted' }),
      Product.countDocuments({ stock: { $lt: 10 }, status: 'published' }),
      User.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      }),
      Order.countDocuments({ orderStatus: 'refunded' })
    ]);

    const avgFulfillmentTime = await this.calculateAvgFulfillmentTime();

    return {
      pendingOrders,
      lowStockItems,
      newCustomers,
      returnedItems,
      avgFulfillmentTime
    };
  }

  async getSalesTrend(timeRange, interval) {
    const dateFilter = this.getDateFilter(timeRange);
    const groupFormat = this.getGroupFormat(interval);

    const trend = await Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: { $dateToString: { format: groupFormat, date: '$createdAt' } },
          sales: { $sum: '$total' },
          orders: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    return trend.map(item => ({
      date: item._id,
      sales: item.sales,
      orders: item.orders
    }));
  }

  async getTopProducts(limit, timeRange) {
    const dateFilter = this.getDateFilter(timeRange);

    const topProducts = await Order.aggregate([
      { $match: dateFilter },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          sales: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' }
    ]);

    return topProducts.map(item => ({
      id: item._id.toString(),
      name: item.productInfo.name,
      sales: item.sales,
      revenue: item.revenue,
      stock: item.productInfo.stock || 0
    }));
  }

  async getRecentActivity(limit) {
    const activities = [];

    const [recentOrders, recentUsers, recentProducts] = await Promise.all([
      Order.find()
        .populate('user', 'name')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      User.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      Product.find()
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean()
    ]);

    recentOrders.forEach(order => {
      activities.push({
        id: order._id.toString(),
        type: 'order',
        description: `New order #${order._id.toString().slice(-6)} placed`,
        timestamp: order.createdAt,
        userId: order.user?._id?.toString(),
        userName: order.user?.name
      });
    });

    recentUsers.forEach(user => {
      activities.push({
        id: user._id.toString(),
        type: 'user',
        description: `New user registered: ${user.name}`,
        timestamp: user.createdAt,
        userId: user._id.toString(),
        userName: user.name
      });
    });

    recentProducts.forEach(product => {
      activities.push({
        id: product._id.toString(),
        type: 'product',
        description: `Product updated: ${product.name}`,
        timestamp: product.updatedAt
      });
    });

    return activities
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  async getCustomerDistribution() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [newCustomers, returningCustomers, vipCustomers] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      User.countDocuments({
        createdAt: { $lt: thirtyDaysAgo, $gte: ninetyDaysAgo }
      }),
      User.countDocuments({ totalPurchases: { $gte: 10 } })
    ]);

    return {
      new: newCustomers,
      returning: returningCustomers,
      vip: vipCustomers
    };
  }

  async getAnalytics(timeRange) {
    const currentPeriod = this.getDateFilter(timeRange);
    const previousPeriod = this.getPreviousPeriodFilter(timeRange);

    const [current, previous] = await Promise.all([
      this.getPeriodMetrics(currentPeriod),
      this.getPeriodMetrics(previousPeriod)
    ]);

    const topCategories = await this.getTopCategories(timeRange);
    const geographicDistribution = await this.getGeographicDistribution(timeRange);

    return {
      periodComparison: {
        current,
        previous,
        percentageChange: {
          revenue: this.calculatePercentageChange(current.revenue, previous.revenue),
          orders: this.calculatePercentageChange(current.orders, previous.orders),
          customers: this.calculatePercentageChange(current.customers, previous.customers)
        }
      },
      topCategories,
      geographicDistribution
    };
  }

  async generateReport(timeRange) {
    const data = await this.getDashboardData(timeRange);
    return Buffer.from(JSON.stringify(data));
  }

  async exportData(format, timeRange) {
    const data = await this.getDashboardData(timeRange);

    if (format === 'csv') {
      return this.convertToCSV(data);
    } else if (format === 'excel') {
      return this.convertToExcel(data);
    } else {
      return this.convertToPDF(data);
    }
  }

  async refreshDashboardCache() {
    return true;
  }

  async getNotifications(userId, unreadOnly) {
    const filter = { userId };
    if (unreadOnly) {
      filter.read = false;
    }

    return [];
  }

  async markNotificationAsRead(notificationId, userId) {
    return true;
  }

  async getMetrics(metricType, timeRange) {
    const dateFilter = this.getDateFilter(timeRange);
    const previousFilter = this.getPreviousPeriodFilter(timeRange);

    let current = 0;
    let previous = 0;
    let trend = [];

    switch (metricType) {
      case 'revenue':
        const revenueData = await Order.aggregate([
          { $match: dateFilter },
          { $group: { _id: null, total: { $sum: '$total' } } }
        ]);
        current = revenueData[0]?.total || 0;

        const prevRevenueData = await Order.aggregate([
          { $match: previousFilter },
          { $group: { _id: null, total: { $sum: '$total' } } }
        ]);
        previous = prevRevenueData[0]?.total || 0;
        break;

      case 'orders':
        current = await Order.countDocuments(dateFilter);
        previous = await Order.countDocuments(previousFilter);
        break;

      case 'customers':
        current = await User.countDocuments(dateFilter);
        previous = await User.countDocuments(previousFilter);
        break;
    }

    const change = this.calculatePercentageChange(current, previous);

    return {
      current,
      previous,
      change,
      trend
    };
  }

  async getRevenueBreakdown(timeRange) {
    const dateFilter = this.getDateFilter(timeRange);

    const breakdown = await Order.aggregate([
      { $match: dateFilter },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $group: {
          _id: '$productInfo.category',
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          orders: { $sum: 1 }
        }
      },
      { $sort: { revenue: -1 } }
    ]);

    return breakdown;
  }

  async getInventoryStatus() {
    const [totalProducts, outOfStock, lowStock, inStock] = await Promise.all([
      Product.countDocuments({ status: 'published' }),
      Product.countDocuments({ stock: 0, status: 'published' }),
      Product.countDocuments({ stock: { $gt: 0, $lt: 10 }, status: 'published' }),
      Product.countDocuments({ stock: { $gte: 10 }, status: 'published' })
    ]);

    return {
      totalProducts,
      outOfStock,
      lowStock,
      inStock
    };
  }

  async getPerformanceMetrics(timeRange) {
    const dateFilter = this.getDateFilter(timeRange);

    const metrics = await Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$total' },
          avgOrderValue: { $avg: '$total' },
          maxOrderValue: { $max: '$total' },
          minOrderValue: { $min: '$total' }
        }
      }
    ]);

    return metrics[0] || {
      totalOrders: 0,
      totalRevenue: 0,
      avgOrderValue: 0,
      maxOrderValue: 0,
      minOrderValue: 0
    };
  }

  getDateFilter(timeRange) {
    const now = new Date();
    let startDate;

    switch (timeRange) {
      case 'today':
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    return { createdAt: { $gte: startDate } };
  }

  getPreviousPeriodFilter(timeRange) {
    const now = new Date();
    let startDate, endDate;

    switch (timeRange) {
      case 'today':
        endDate = new Date(now.setHours(0, 0, 0, 0));
        startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'week':
        endDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        endDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        endDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        endDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    return { createdAt: { $gte: startDate, $lt: endDate } };
  }

  getGroupFormat(interval) {
    switch (interval) {
      case 'hour':
        return '%Y-%m-%d %H:00';
      case 'day':
        return '%Y-%m-%d';
      case 'week':
        return '%Y-%U';
      case 'month':
        return '%Y-%m';
      default:
        return '%Y-%m-%d';
    }
  }

  calculatePercentageChange(current, previous) {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous) * 100;
  }

  async calculateConversionRate(timeRange) {
    return 2.4;
  }

  async calculateRefundRate(timeRange) {
    const dateFilter = this.getDateFilter(timeRange);
    const [totalOrders, refundedOrders] = await Promise.all([
      Order.countDocuments(dateFilter),
      Order.countDocuments({ ...dateFilter, orderStatus: 'refunded' })
    ]);

    if (totalOrders === 0) return 0;
    return (refundedOrders / totalOrders) * 100;
  }

  async calculateAvgFulfillmentTime() {
    const fulfilledOrders = await Order.find({
      orderStatus: 'completed',
      completedAt: { $exists: true }
    }).lean();

    if (fulfilledOrders.length === 0) return 0;

    const totalTime = fulfilledOrders.reduce((sum, order) => {
      const timeDiff = new Date(order.completedAt) - new Date(order.createdAt);
      return sum + timeDiff;
    }, 0);

    const avgTimeInMs = totalTime / fulfilledOrders.length;
    const avgTimeInDays = avgTimeInMs / (1000 * 60 * 60 * 24);

    return avgTimeInDays;
  }

  async getPeriodMetrics(dateFilter) {
    const [revenue, orders, customers] = await Promise.all([
      Order.aggregate([
        { $match: dateFilter },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]),
      Order.countDocuments(dateFilter),
      User.countDocuments(dateFilter)
    ]);

    return {
      revenue: revenue[0]?.total || 0,
      orders,
      customers
    };
  }

  async getTopCategories(timeRange) {
    const dateFilter = this.getDateFilter(timeRange);

    const categories = await Order.aggregate([
      { $match: dateFilter },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $group: {
          _id: '$productInfo.category',
          sales: { $sum: '$items.quantity' },
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 }
    ]);

    return categories.map(cat => ({
      category: cat._id || 'Uncategorized',
      sales: cat.sales,
      revenue: cat.revenue
    }));
  }

  async getGeographicDistribution(timeRange) {
    const dateFilter = this.getDateFilter(timeRange);

    const distribution = await Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: '$shippingAddress.state',
          orders: { $sum: 1 },
          revenue: { $sum: '$total' }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 }
    ]);

    return distribution.map(item => ({
      region: item._id || 'Unknown',
      orders: item.orders,
      revenue: item.revenue
    }));
  }

  convertToCSV(data) {
    const csvRows = [];
    csvRows.push('Metric,Value');
    csvRows.push(`Total Sales,${data.stats.totalSales}`);
    csvRows.push(`Total Users,${data.stats.totalUsers}`);
    csvRows.push(`Total Products,${data.stats.totalProducts}`);
    csvRows.push(`Total Revenue,${data.stats.totalRevenue}`);
    return Buffer.from(csvRows.join('\n'));
  }

  convertToExcel(data) {
    return Buffer.from(JSON.stringify(data));
  }

  convertToPDF(data) {
    return Buffer.from(JSON.stringify(data));
  }
}

module.exports = new DashboardService();