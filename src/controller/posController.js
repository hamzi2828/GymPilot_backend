// POS Controller
const Product = require('../models/product');
const Customer = require('../models/customer');
const POSOrder = require('../models/posOrder');
const Category = require('../models/category');
const { uploadScreenshot } = require('../helper/blobUpload');

const posController = {
  // GET /api/pos/products - Get all POS-eligible products (live or not) for POS
  getProducts: async (req, res) => {
    try {
      const { search, category, limit } = req.query;

      // POS shows products where displayOn is 'pos' or 'both' (or unset → defaults to 'both').
      // Non-live products (draft / out_of_stock) are intentionally included so they can be added to bulk orders.
      const query = {
        displayOn: { $ne: 'website' },
        isDeleted: { $ne: true }
      };

      if (category) {
        query.category = category;
      }

      if (search) {
        const searchWords = search.trim().split(/\s+/).filter(w => w.length > 0);

        if (searchWords.length > 0) {
          const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const wordPatterns = searchWords.map(word => escapeRegex(word));
          const anyWordPattern = wordPatterns.join('|');
          const allWordsPattern = wordPatterns.map(w => `(?=.*${w})`).join('');

          query.$or = [
            { name: { $regex: allWordsPattern, $options: 'i' } },
            { name: { $regex: anyWordPattern, $options: 'i' } },
            { sku: { $regex: escapeRegex(search), $options: 'i' } },
            { barcode: { $regex: escapeRegex(search), $options: 'i' } },
            { slug: { $regex: escapeRegex(search), $options: 'i' } }
          ];
        }
      }

      let productsQuery = Product.find(query).sort({ name: 1 });

      if (limit) {
        productsQuery = productsQuery.limit(parseInt(limit));
      }

      const products = await productsQuery;

      return res.status(200).json({
        success: true,
        data: products,
        message: 'Products fetched successfully'
      });
    } catch (error) {
      console.error('Get POS products error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching products',
        error: error.message
      });
    }
  },

  // GET /api/pos/products/barcode/:barcode - Get product by barcode
  getProductByBarcode: async (req, res) => {
    try {
      const { barcode } = req.params;

      const product = await Product.findOne({
        barcode,
        displayOn: { $ne: 'website' },
        isDeleted: { $ne: true }
      });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: product,
        message: 'Product fetched successfully'
      });
    } catch (error) {
      console.error('Get product by barcode error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching product',
        error: error.message
      });
    }
  },

  // GET /api/pos/categories - Get all categories
  getCategories: async (req, res) => {
    try {
      const categories = await Category.find().select('name').sort({ name: 1 });
      const categoryNames = categories.map(c => c.name);

      return res.status(200).json({
        success: true,
        data: categoryNames,
        message: 'Categories fetched successfully'
      });
    } catch (error) {
      console.error('Get categories error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching categories',
        error: error.message
      });
    }
  },

  // GET /api/pos/customers - Get all customers
  getCustomers: async (req, res) => {
    try {
      const customers = await Customer.find({ isActive: true, isDeleted: { $ne: true } })
        .select('firstName lastName email phone address sizePreferences stylePreferences')
        .sort({ firstName: 1 });

      return res.status(200).json({
        success: true,
        data: customers,
        message: 'Customers fetched successfully'
      });
    } catch (error) {
      console.error('Get customers error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching customers',
        error: error.message
      });
    }
  },

  // GET /api/pos/customers/search - Search customers
  searchCustomers: async (req, res) => {
    try {
      const { q } = req.query;

      if (!q) {
        return posController.getCustomers(req, res);
      }

      const customers = await Customer.find({
        isActive: true,
        isDeleted: { $ne: true },
        $or: [
          { firstName: { $regex: q, $options: 'i' } },
          { lastName: { $regex: q, $options: 'i' } },
          { email: { $regex: q, $options: 'i' } },
          { phone: { $regex: q, $options: 'i' } },
          { customerCode: { $regex: q, $options: 'i' } }
        ]
      })
      .select('firstName lastName email phone address sizePreferences stylePreferences')
      .sort({ firstName: 1 })
      .limit(20);

      return res.status(200).json({
        success: true,
        data: customers,
        message: 'Customers fetched successfully'
      });
    } catch (error) {
      console.error('Search customers error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error searching customers',
        error: error.message
      });
    }
  },

  // GET /api/pos/customers/:id - Get customer by ID
  getCustomerById: async (req, res) => {
    try {
      const { id } = req.params;

      const customer = await Customer.findById(id)
        .select('firstName lastName email phone address sizePreferences stylePreferences');

      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: customer,
        message: 'Customer fetched successfully'
      });
    } catch (error) {
      console.error('Get customer by ID error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching customer',
        error: error.message
      });
    }
  },

  // POST /api/pos/customers - Create or find customer from POS
  createOrFindCustomer: async (req, res) => {
    try {
      const { firstName, lastName, phone, email, source } = req.body;

      if (!firstName || !firstName.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Customer name is required'
        });
      }

      if (!phone || !phone.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Phone number is required'
        });
      }

      // Try to find existing customer by phone number
      let customer = await Customer.findOne({
        phone: phone.trim(),
        isDeleted: { $ne: true }
      });

      if (customer) {
        return res.status(200).json({
          success: true,
          data: customer,
          message: 'Existing customer found',
          isNew: false
        });
      }

      // Generate customer code
      const date = new Date();
      const year = date.getFullYear().toString().slice(-2);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const lastCustomer = await Customer.findOne({
        customerCode: { $regex: `^WLK${year}${month}` }
      }).sort({ customerCode: -1 });

      let sequence = 1;
      if (lastCustomer && lastCustomer.customerCode) {
        const lastSequence = parseInt(lastCustomer.customerCode.slice(-4), 10);
        if (!isNaN(lastSequence)) {
          sequence = lastSequence + 1;
        }
      }
      const customerCode = `WLK${year}${month}${sequence.toString().padStart(4, '0')}`;

      customer = new Customer({
        customerCode,
        firstName: firstName.trim(),
        lastName: lastName?.trim() || '',
        email: email?.toLowerCase().trim() || '',
        phone: phone.trim(),
        customerType: 'walk-in',
        source: source || '',
        isActive: true
      });

      await customer.save();

      return res.status(201).json({
        success: true,
        data: customer,
        message: 'Customer created successfully',
        isNew: true
      });
    } catch (error) {
      console.error('Create/find customer error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error creating customer',
        error: error.message
      });
    }
  },

  // POST /api/pos/orders - Create POS order
  createOrder: async (req, res) => {
    try {
      const {
        items,
        customer,
        customerInfo,
        subtotal,
        tax,
        appliedTaxes,
        discount,
        discountType,
        discountReason,
        total,
        paymentMethod,
        cashAmount,
        cardAmount,
        change,
        bankTransferScreenshot,
        notes,
        isPartialPayment,
        paidAmount: requestedPaidAmount
      } = req.body;

      const cashierId = req.user?._id || req.user?.id;

      if (!cashierId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required - cashier not found'
        });
      }

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Order must have at least one item'
        });
      }

      if (!paymentMethod) {
        return res.status(400).json({
          success: false,
          message: 'Payment method is required'
        });
      }

      let actualPaidAmount = total;
      let actualPendingAmount = 0;
      let actualPaymentStatus = 'completed';
      let actualOrderStatus = 'completed';

      if (isPartialPayment && requestedPaidAmount !== undefined) {
        actualPaidAmount = parseFloat(requestedPaidAmount) || 0;
        actualPendingAmount = Math.max(0, total - actualPaidAmount);

        if (actualPendingAmount > 0) {
          actualPaymentStatus = actualPaidAmount > 0 ? 'partial' : 'pending';
          actualOrderStatus = 'pending';
        }
      }

      // Validate stock availability
      for (const item of items) {
        if (item.isLabour || item.isOutsource) continue;

        const product = await Product.findById(item.product);
        if (!product) {
          return res.status(404).json({
            success: false,
            message: `Product not found: ${item.product}`
          });
        }

        if (product.productType === 'variant' && item.variantId) {
          const variant = product.variants.find(v => v.variantId === item.variantId);
          if (!variant) {
            return res.status(404).json({
              success: false,
              message: `Variant ${item.variantId} not found`
            });
          }
          if (variant.stock < item.quantity) {
            return res.status(400).json({
              success: false,
              message: `Insufficient stock for ${product.name} (${variant.color}/${variant.size})`
            });
          }
        } else {
          if (product.stock < item.quantity) {
            return res.status(400).json({
              success: false,
              message: `Insufficient stock for ${product.name}`
            });
          }
        }
      }

      const orderNumber = await POSOrder.generateOrderNumber();

      const initialPaymentHistory = actualPaidAmount > 0 ? [{
        amount: actualPaidAmount,
        paymentMethod,
        paidAt: new Date(),
        receivedBy: cashierId,
        note: isPartialPayment ? 'Initial partial payment' : 'Full payment',
        bankTransferScreenshot: paymentMethod === 'bank_transfer' ? bankTransferScreenshot : undefined
      }] : [];

      const order = new POSOrder({
        orderNumber,
        customer: customer || undefined,
        customerInfo: customerInfo || undefined,
        items,
        subtotal,
        tax,
        appliedTaxes: appliedTaxes || [],
        discount: discount || 0,
        discountType: discountType || null,
        discountReason: discountReason || '',
        total,
        paymentMethod,
        paymentStatus: actualPaymentStatus,
        orderStatus: actualOrderStatus,
        paidAmount: actualPaidAmount,
        pendingAmount: actualPendingAmount,
        paymentHistory: initialPaymentHistory,
        cashAmount: paymentMethod === 'cash' ? cashAmount : undefined,
        cardAmount: paymentMethod === 'card' ? cardAmount : undefined,
        changeGiven: change,
        bankTransferScreenshot: paymentMethod === 'bank_transfer' ? bankTransferScreenshot : undefined,
        cashier: cashierId,
        notes: notes || 'POS Order',
        completedAt: actualPaymentStatus === 'completed' ? new Date() : undefined
      });

      await order.save();

      // Update product stock
      for (const item of items) {
        if (item.isLabour || item.isOutsource) continue;

        const product = await Product.findById(item.product);
        if (product) {
          if (product.productType === 'variant' && item.variantId) {
            const variant = product.variants.find(v => v.variantId === item.variantId);
            if (variant) {
              variant.stock = Math.max(0, variant.stock - item.quantity);
            }
          } else {
            product.stock = Math.max(0, product.stock - item.quantity);
          }

          if (product.productType === 'variant') {
            product.stock = product.variants.reduce((sum, v) => sum + v.stock, 0);
          }

          if (product.stock === 0) {
            product.status = 'out_of_stock';
          }

          await product.save();
        }
      }

      const populatedOrder = await POSOrder.findById(order._id)
        .populate('customer', 'firstName lastName email phone')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price');

      return res.status(201).json({
        success: true,
        data: populatedOrder,
        message: 'Order created successfully'
      });
    } catch (error) {
      console.error('Create POS order error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error creating order',
        error: error.message
      });
    }
  },

  // GET /api/pos/orders - Get POS orders
  getOrders: async (req, res) => {
    try {
      const { date, startDate, endDate, limit, paymentMethod, orderType } = req.query;

      const query = { isDeleted: { $ne: true } };

      if (startDate && endDate) {
        const rangeStart = new Date(startDate);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(endDate);
        rangeEnd.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: rangeStart, $lte: rangeEnd };
      } else if (date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt = { $gte: startOfDay, $lte: endOfDay };
      }

      if (paymentMethod && paymentMethod !== 'all') {
        query.paymentMethod = paymentMethod;
      }

      if (orderType && orderType !== 'all') {
        query.orderStatus = orderType;
      }

      let ordersQuery = POSOrder.find(query)
        .populate('customer', 'firstName lastName email phone')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .sort({ createdAt: -1 });

      if (limit) {
        ordersQuery = ordersQuery.limit(parseInt(limit));
      }

      const orders = await ordersQuery;
      const total = await POSOrder.countDocuments(query);

      return res.status(200).json({
        success: true,
        data: orders,
        pagination: {
          total,
          page: 1,
          pages: Math.ceil(total / (limit || total)),
          limit: limit ? parseInt(limit) : total
        },
        message: 'Orders fetched successfully'
      });
    } catch (error) {
      console.error('Get POS orders error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching orders',
        error: error.message
      });
    }
  },

  // GET /api/pos/orders/:id - Get order by ID
  getOrderById: async (req, res) => {
    try {
      const { id } = req.params;

      const order = await POSOrder.findOne({ _id: id, isDeleted: { $ne: true } })
        .populate('customer', 'firstName lastName email phone')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price');

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      return res.status(200).json({
        success: true,
        data: order,
        message: 'Order fetched successfully'
      });
    } catch (error) {
      console.error('Get order by ID error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching order',
        error: error.message
      });
    }
  },

  // GET /api/pos/dashboard/stats - Get dashboard statistics
  getDashboardStats: async (req, res) => {
    try {
      const { filter = 'today', startDate, endDate } = req.query;
      const now = new Date();

      let periodStart, periodEnd, comparisonStart, comparisonEnd, periodLabel;

      switch (filter) {
        case 'weekly':
          const dayOfWeek = now.getDay();
          const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
          periodEnd = new Date(periodStart);
          periodEnd.setDate(periodEnd.getDate() + 7);
          comparisonStart = new Date(periodStart);
          comparisonStart.setDate(comparisonStart.getDate() - 7);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'This Week';
          break;

        case 'monthly':
          periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          comparisonStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'This Month';
          break;

        case 'custom':
          if (!startDate || !endDate) {
            return res.status(400).json({
              success: false,
              message: 'Start date and end date are required for custom filter'
            });
          }
          periodStart = new Date(startDate);
          periodStart.setHours(0, 0, 0, 0);
          periodEnd = new Date(endDate);
          periodEnd.setHours(23, 59, 59, 999);
          const duration = periodEnd.getTime() - periodStart.getTime();
          comparisonEnd = new Date(periodStart);
          comparisonStart = new Date(comparisonEnd.getTime() - duration);
          periodLabel = 'Custom Period';
          break;

        case 'today':
        default:
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          periodEnd = new Date(periodStart);
          periodEnd.setDate(periodEnd.getDate() + 1);
          comparisonStart = new Date(periodStart);
          comparisonStart.setDate(comparisonStart.getDate() - 1);
          comparisonEnd = new Date(periodStart);
          periodLabel = 'Today';
          break;
      }

      const periodStats = await POSOrder.aggregate([
        {
          $match: {
            createdAt: { $gte: periodStart, $lt: periodEnd },
            orderStatus: 'completed',
            isDeleted: { $ne: true }
          }
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 },
            totalItems: { $sum: { $size: '$items' } },
            avgOrderValue: { $avg: '$total' },
            totalDiscount: { $sum: '$discount' },
            cashSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$total', 0] } },
            cardSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$total', 0] } }
          }
        }
      ]);

      const comparisonStats = await POSOrder.aggregate([
        {
          $match: {
            createdAt: { $gte: comparisonStart, $lt: comparisonEnd },
            orderStatus: 'completed',
            isDeleted: { $ne: true }
          }
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 }
          }
        }
      ]);

      const topProducts = await POSOrder.aggregate([
        {
          $match: {
            createdAt: { $gte: periodStart, $lt: periodEnd },
            orderStatus: 'completed',
            isDeleted: { $ne: true }
          }
        },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
          }
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product'
          }
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            totalQuantity: 1,
            totalRevenue: 1,
            productName: { $ifNull: ['$product.name', 'Unknown Product'] },
            productImage: '$product.thumbnailUrl'
          }
        }
      ]);

      const recentOrders = await POSOrder.find({
        orderStatus: 'completed',
        createdAt: { $gte: periodStart, $lt: periodEnd },
        isDeleted: { $ne: true }
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('customer', 'firstName lastName')
        .populate('cashier', 'firstName lastName')
        .select('orderNumber total paymentMethod createdAt customer cashier');

      const calcChange = (current, previous) => {
        if (!previous || previous === 0) return current > 0 ? 100 : 0;
        return ((current - previous) / previous * 100).toFixed(1);
      };

      const current = periodStats[0] || { totalSales: 0, totalOrders: 0, totalItems: 0, avgOrderValue: 0, totalDiscount: 0, cashSales: 0, cardSales: 0 };
      const previous = comparisonStats[0] || { totalSales: 0, totalOrders: 0 };

      const getComparisonLabel = () => {
        switch (filter) {
          case 'weekly': return 'vs last week';
          case 'monthly': return 'vs last month';
          case 'custom': return 'vs previous period';
          default: return 'vs yesterday';
        }
      };

      return res.status(200).json({
        success: true,
        data: {
          period: {
            totalSales: current.totalSales || 0,
            totalOrders: current.totalOrders || 0,
            totalItems: current.totalItems || 0,
            avgOrderValue: current.avgOrderValue || 0,
            totalDiscount: current.totalDiscount || 0,
            cashSales: current.cashSales || 0,
            cardSales: current.cardSales || 0,
            salesChange: calcChange(current.totalSales, previous.totalSales),
            ordersChange: calcChange(current.totalOrders, previous.totalOrders)
          },
          periodLabel,
          comparisonLabel: getComparisonLabel(),
          filter,
          dateRange: {
            start: periodStart.toISOString(),
            end: periodEnd.toISOString()
          },
          topProducts,
          recentOrders
        },
        message: 'Dashboard stats fetched successfully'
      });
    } catch (error) {
      console.error('Get dashboard stats error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching dashboard stats',
        error: error.message
      });
    }
  },

  // GET /api/pos/dashboard/sales-chart - Get sales chart data
  getSalesChart: async (req, res) => {
    try {
      const { period = '7days' } = req.query;
      const now = new Date();
      let startDate, groupFormat, dateFormat;

      switch (period) {
        case '30days':
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 30);
          groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
          dateFormat = 'daily';
          break;
        case '12months':
          startDate = new Date(now);
          startDate.setMonth(startDate.getMonth() - 12);
          groupFormat = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
          dateFormat = 'monthly';
          break;
        case '7days':
        default:
          startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 7);
          groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
          dateFormat = 'daily';
          break;
      }

      const salesChart = await POSOrder.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate },
            orderStatus: 'completed',
            isDeleted: { $ne: true }
          }
        },
        {
          $group: {
            _id: groupFormat,
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 },
            cashSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$total', 0] } },
            cardSales: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$total', 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const hourlyChart = await POSOrder.aggregate([
        {
          $match: {
            createdAt: { $gte: todayStart },
            orderStatus: 'completed',
            isDeleted: { $ne: true }
          }
        },
        {
          $group: {
            _id: { $hour: '$createdAt' },
            totalSales: { $sum: '$total' },
            totalOrders: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      const paymentDistribution = await POSOrder.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate },
            orderStatus: 'completed',
            isDeleted: { $ne: true }
          }
        },
        {
          $group: {
            _id: '$paymentMethod',
            totalSales: { $sum: '$total' },
            count: { $sum: 1 }
          }
        }
      ]);

      return res.status(200).json({
        success: true,
        data: {
          salesChart,
          hourlyChart,
          paymentDistribution,
          period,
          dateFormat
        },
        message: 'Sales chart data fetched successfully'
      });
    } catch (error) {
      console.error('Get sales chart error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching sales chart data',
        error: error.message
      });
    }
  },

  // GET /api/pos/orders/pending - Get all pending payment orders
  getPendingOrders: async (req, res) => {
    try {
      const { customerId } = req.query;

      const query = {
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] }
      };

      if (customerId) {
        query.customer = customerId;
      }

      const orders = await POSOrder.find(query)
        .populate('customer', 'firstName lastName email phone')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .sort({ createdAt: -1 });

      const totalPending = orders.reduce((sum, order) => sum + order.pendingAmount, 0);
      const totalPaid = orders.reduce((sum, order) => sum + order.paidAmount, 0);

      return res.status(200).json({
        success: true,
        data: orders,
        summary: {
          totalOrders: orders.length,
          totalPending,
          totalPaid,
          totalAmount: totalPending + totalPaid
        },
        message: 'Pending orders fetched successfully'
      });
    } catch (error) {
      console.error('Get pending orders error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching pending orders',
        error: error.message
      });
    }
  },

  // POST /api/pos/orders/:id/payment - Add payment to an existing order
  addPayment: async (req, res) => {
    try {
      const { id } = req.params;
      const { amount, paymentMethod, note, bankTransferScreenshot } = req.body;
      const userId = req.user?._id || req.user?.id;

      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Payment amount must be greater than 0'
        });
      }

      if (!paymentMethod) {
        return res.status(400).json({
          success: false,
          message: 'Payment method is required'
        });
      }

      const order = await POSOrder.findOne({ _id: id, isDeleted: { $ne: true } });

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      if (order.paymentStatus === 'completed') {
        return res.status(400).json({
          success: false,
          message: 'Order is already fully paid'
        });
      }

      const paymentAmount = parseFloat(amount);

      if (paymentAmount > order.pendingAmount) {
        return res.status(400).json({
          success: false,
          message: `Payment amount (${paymentAmount}) exceeds pending amount (${order.pendingAmount})`
        });
      }

      order.paymentHistory.push({
        amount: paymentAmount,
        paymentMethod,
        paidAt: new Date(),
        receivedBy: userId,
        note: note || 'Additional payment',
        bankTransferScreenshot: paymentMethod === 'bank_transfer' ? bankTransferScreenshot : undefined
      });

      order.paidAmount += paymentAmount;
      order.pendingAmount -= paymentAmount;

      if (order.pendingAmount <= 0) {
        order.paymentStatus = 'completed';
        order.orderStatus = 'completed';
        order.completedAt = new Date();
        order.pendingAmount = 0;
      } else {
        order.paymentStatus = 'partial';
      }

      await order.save();

      const populatedOrder = await POSOrder.findById(order._id)
        .populate('customer', 'firstName lastName email phone')
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .populate('paymentHistory.receivedBy', 'firstName lastName');

      return res.status(200).json({
        success: true,
        data: populatedOrder,
        message: order.paymentStatus === 'completed'
          ? 'Payment completed successfully'
          : 'Payment added successfully'
      });
    } catch (error) {
      console.error('Add payment error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error adding payment',
        error: error.message
      });
    }
  },

  // GET /api/pos/customers/:id/pending - Get pending orders for a customer
  getCustomerPendingOrders: async (req, res) => {
    try {
      const { id } = req.params;

      const orders = await POSOrder.find({
        customer: id,
        isDeleted: { $ne: true },
        paymentStatus: { $in: ['pending', 'partial'] }
      })
        .populate('cashier', 'firstName lastName email')
        .populate('items.product', 'name thumbnailUrl bannerUrls price')
        .sort({ createdAt: -1 });

      const totalPending = orders.reduce((sum, order) => sum + order.pendingAmount, 0);

      return res.status(200).json({
        success: true,
        data: orders,
        summary: {
          totalOrders: orders.length,
          totalPending
        },
        message: 'Customer pending orders fetched successfully'
      });
    } catch (error) {
      console.error('Get customer pending orders error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error fetching customer pending orders',
        error: error.message
      });
    }
  },

  // DELETE /api/pos/orders/:id - Soft delete an order
  deleteOrder: async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user?._id || req.user?.id;

      const order = await POSOrder.findOne({ _id: id, isDeleted: { $ne: true } });

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }

      order.isDeleted = true;
      order.deletedAt = new Date();
      order.deletedBy = userId;
      await order.save();

      return res.status(200).json({
        success: true,
        message: 'Order deleted successfully'
      });
    } catch (error) {
      console.error('Delete order error:', error);
      return res.status(400).json({
        success: false,
        message: 'Error deleting order',
        error: error.message
      });
    }
  },

  // POST /api/pos/upload-screenshot - Upload bank transfer screenshot
  uploadScreenshot: async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }
      const { buffer, originalname, mimetype } = req.file;
      const url = await uploadScreenshot(buffer, `screenshot-${Date.now()}-${originalname}`, mimetype);
      return res.status(200).json({
        success: true,
        data: { url, originalFilename: originalname, uploadedAt: new Date().toISOString() }
      });
    } catch (error) {
      console.error('Screenshot upload error:', error);
      return res.status(400).json({ success: false, message: error.message || 'Failed to upload screenshot' });
    }
  }
};

module.exports = posController;
