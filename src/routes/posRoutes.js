// POS Routes
const express = require('express');
const router = express.Router();
const multer = require('multer');
const posController = require('../controller/posController');
const auth = require('../middleware/auth');

const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// All POS routes require authentication
router.use(auth);

// Bank transfer screenshot upload
router.post('/upload-screenshot', screenshotUpload.single('screenshot'), posController.uploadScreenshot);

// Product routes
router.get('/products', posController.getProducts);
router.get('/products/barcode/:barcode', posController.getProductByBarcode);
router.get('/categories', posController.getCategories);

// Customer routes
router.get('/customers', posController.getCustomers);
router.get('/customers/search', posController.searchCustomers);
router.post('/customers', posController.createOrFindCustomer);
router.get('/customers/:id', posController.getCustomerById);

// Order routes
router.post('/orders', posController.createOrder);
router.get('/orders', posController.getOrders);
router.get('/orders/pending', posController.getPendingOrders); // Must be before :id route
router.get('/orders/:id', posController.getOrderById);
router.post('/orders/:id/payment', posController.addPayment); // Add payment to pending order
router.delete('/orders/:id', posController.deleteOrder);

// Customer pending orders
router.get('/customers/:id/pending', posController.getCustomerPendingOrders);

// Dashboard/Stats routes
router.get('/dashboard/stats', posController.getDashboardStats);
router.get('/dashboard/sales-chart', posController.getSalesChart);

module.exports = router;
