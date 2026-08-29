// src/accounts/routes/accountsRoutes.js
//
// Mounted at /api/accounts by index.js. Everything sits behind the 'accounts'
// permission tab: reads need 'view', writes need 'manage', so a gym can give
// an accountant the books without giving them the ability to rewrite them.

const express = require('express');
const router = express.Router();

const auth = require('../../middleware/auth');
const requirePermission = require('../../middleware/requirePermission');

const accountsController = require('../controller/accountsController');
const expenseController = require('../controller/expenseController');
const assetController = require('../controller/assetController');

router.use(auth);

// Reports
router.get('/overview', requirePermission('accounts', 'view'), accountsController.overview);
router.get('/sales', requirePermission('accounts', 'view'), accountsController.sales);

// Expenses
router.get('/expenses', requirePermission('accounts', 'view'), expenseController.list);
router.post('/expenses', requirePermission('accounts', 'manage'), expenseController.create);
router.post('/expenses/payroll', requirePermission('accounts', 'manage'), expenseController.postPayroll);
router.put('/expenses/:id', requirePermission('accounts', 'manage'), expenseController.update);
router.delete('/expenses/:id', requirePermission('accounts', 'manage'), expenseController.remove);

// Assets
router.get('/assets', requirePermission('accounts', 'view'), assetController.list);
router.post('/assets', requirePermission('accounts', 'manage'), assetController.create);
router.post('/assets/:id/service', requirePermission('accounts', 'manage'), assetController.logService);
router.put('/assets/:id', requirePermission('accounts', 'manage'), assetController.update);
router.delete('/assets/:id', requirePermission('accounts', 'manage'), assetController.remove);

module.exports = router;
