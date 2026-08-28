// src/gymfolio/routes/gymfolioRoutes.js
// Dedicated routes for Gymfolio (classes, trainers, packages, package orders/registrations, payments)

const express = require('express');
const router = express.Router();

const auth = require('../../middleware/auth');
const requireAdmin = require('../../middleware/requireAdmin');
const optionalAuth = require('../../middleware/optionalAuth');
const { uploadSingle, uploadArray, uploadFields } = require('../../helper/upload');

const gymClassController = require('../controller/gymClassController');
const trainerController = require('../controller/trainerController');
const packageController = require('../controller/packageController');
const packageRegistrationController = require('../controller/packageRegistrationController');
const gymfolioPaymentController = require('../controller/gymfolioPaymentController');

/* -------------------------------- Gym Classes -------------------------------- */
router.get('/gym-classes/active', gymClassController.getActiveClasses);
router.get('/gym-classes/featured', gymClassController.getFeaturedClasses);
router.get('/gym-classes/category/:category', gymClassController.getClassesByCategory);
router.get('/gym-classes/slug/:slug', gymClassController.getClassBySlug);
router.get('/gym-classes/:id', gymClassController.getClassById);
router.get('/gym-classes', auth, gymClassController.getAllClasses);
router.post(
  '/gym-classes',
  auth,
  uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
    { name: 'videoPoster', maxCount: 1 },
  ]),
  gymClassController.createClass
);
router.put(
  '/gym-classes/:id',
  auth,
  uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
    { name: 'videoPoster', maxCount: 1 },
  ]),
  gymClassController.updateClass
);
router.patch('/gym-classes/:id/toggle-active', auth, gymClassController.toggleClassStatus);
router.patch('/gym-classes/:id/toggle-featured', auth, gymClassController.toggleClassFeatured);
router.delete('/gym-classes/:id', auth, gymClassController.deleteClass);

/* ---------------------------------- Trainers --------------------------------- */
router.get('/trainers/active', trainerController.getActiveTrainers);
router.get('/trainers/featured', trainerController.getFeaturedTrainers);
router.get('/trainers/slug/:slug', trainerController.getTrainerBySlug);
router.get('/trainers/:id', trainerController.getTrainerById);
router.get('/trainers', auth, trainerController.getAllTrainers);
router.post(
  '/trainers',
  auth,
  uploadFields([
    { name: 'image', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
  ]),
  trainerController.createTrainer
);
router.put(
  '/trainers/:id',
  auth,
  uploadFields([
    { name: 'image', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
  ]),
  trainerController.updateTrainer
);
router.patch('/trainers/:id/toggle-active', auth, trainerController.toggleTrainerStatus);
router.patch('/trainers/:id/toggle-featured', auth, trainerController.toggleTrainerFeatured);
router.delete('/trainers/:id', auth, trainerController.deleteTrainer);

/* ---------------------------------- Packages --------------------------------- */
router.get('/packages/active', packageController.getActivePackages);
router.get('/packages/:id', packageController.getPackageById);
router.get('/packages', auth, packageController.getAllPackages);
router.post('/packages', auth, packageController.createPackage);
router.put('/packages/:id', auth, packageController.updatePackage);
router.patch('/packages/:id/toggle-active', auth, packageController.togglePackageStatus);
router.patch('/packages/:id/order', auth, packageController.updatePackageOrder);
router.delete('/packages/:id', auth, packageController.deletePackage);

/* ---------------------------- Package Registrations -------------------------- */
router.post('/package-registrations', optionalAuth, packageRegistrationController.createRegistration);
router.get('/package-registrations', auth, packageRegistrationController.getAllRegistrations);
router.get('/package-registrations/stats', auth, packageRegistrationController.getRegistrationStats);
router.get('/package-registrations/:id', auth, packageRegistrationController.getRegistrationById);
router.put('/package-registrations/:id/status', auth, packageRegistrationController.updateRegistrationStatus);
router.delete('/package-registrations/:id', auth, packageRegistrationController.deleteRegistration);

/* ------------------------------ Package Payments ----------------------------- */
router.get('/payments/public-key', gymfolioPaymentController.getPublicKey);
router.post('/payments/checkout', optionalAuth, gymfolioPaymentController.createPackageCheckoutSession);
router.post('/payments/verify', optionalAuth, gymfolioPaymentController.verifyPackagePayment);

// Aliases used by checkoutService on the gymfolio frontend
router.get('/payment/stripe-public-key', gymfolioPaymentController.getPublicKey);
router.post('/payment/create-package-checkout-session', optionalAuth, gymfolioPaymentController.createPackageCheckoutSession);
router.get('/payment/verify/:sessionId', optionalAuth, gymfolioPaymentController.verifyPackagePayment);
router.post('/payment/verify/:sessionId', optionalAuth, gymfolioPaymentController.verifyPackagePayment);
router.post('/payment/webhook', gymfolioPaymentController.handleWebhook);

// Package orders (admin)
router.post('/package-orders/assign', auth, requireAdmin, gymfolioPaymentController.assignPackageToUser);
router.get('/package-orders', auth, gymfolioPaymentController.getAllOrders);
router.get('/package-orders/me', auth, gymfolioPaymentController.getUserOrders);
router.get('/package-orders/:id', auth, gymfolioPaymentController.getOrderById);
router.put('/package-orders/:id/status', auth, gymfolioPaymentController.updateOrderStatus);
router.post('/package-orders/:id/cancel-subscription', auth, gymfolioPaymentController.cancelSubscription);
router.get('/package-orders/:id/subscription-status', auth, gymfolioPaymentController.getSubscriptionStatus);

module.exports = router;
