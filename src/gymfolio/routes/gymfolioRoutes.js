// src/gymfolio/routes/gymfolioRoutes.js
// Dedicated routes for Gymfolio (classes, trainers, packages, package orders/registrations, payments)

const express = require('express');
const router = express.Router();

const auth = require('../../middleware/auth');
const requirePermission = require('../../middleware/requirePermission');
const optionalAuth = require('../../middleware/optionalAuth');
const { tenantFromStripeWebhook, tenantFromSlugParam } = require('../../platform/middleware/tenantFromPayload');
const { uploadSingle, uploadArray, uploadFields } = require('../../helper/upload');
const rateLimit = require('../../middleware/rateLimit');

// Request ceilings on the endpoints the public can hit without signing in:
// opening checkouts and validating coupons are the ones a script would hammer.
// The limiters live in middleware/rateLimit.js; until that file exports them
// the routes fall through unlimited rather than failing to load.
const passThrough = (req, res, next) => next();
const paymentLimiter = rateLimit.paymentLimiter || passThrough;
const publicWriteLimiter = rateLimit.publicWriteLimiter || passThrough;

const gymClassController = require('../controller/gymClassController');
const classBookingController = require('../controller/classBookingController');
const trainerController = require('../controller/trainerController');
const packageController = require('../controller/packageController');
const packageRegistrationController = require('../controller/packageRegistrationController');
const gymfolioPaymentController = require('../controller/gymfolioPaymentController');
const membershipController = require('../controller/membershipController');
const couponController = require('../controller/couponController');

/* -------------------------------- Gym Classes -------------------------------- */
router.get('/gym-classes/active', gymClassController.getActiveClasses);
router.get('/gym-classes/featured', gymClassController.getFeaturedClasses);
router.get('/gym-classes/category/:category', gymClassController.getClassesByCategory);
router.get('/gym-classes/slug/:slug', gymClassController.getClassBySlug);
router.get('/gym-classes/:id', gymClassController.getClassById);
router.get('/gym-classes', auth, requirePermission('classes'), gymClassController.getAllClasses);
router.post(
  '/gym-classes',
  auth, requirePermission('classes'),
  uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
    { name: 'videoPoster', maxCount: 1 },
  ]),
  gymClassController.createClass
);
router.put(
  '/gym-classes/:id',
  auth, requirePermission('classes'),
  uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
    { name: 'videoPoster', maxCount: 1 },
  ]),
  gymClassController.updateClass
);
router.patch('/gym-classes/:id/toggle-active', auth, requirePermission('classes'), gymClassController.toggleClassStatus);
router.patch('/gym-classes/:id/toggle-featured', auth, requirePermission('classes'), gymClassController.toggleClassFeatured);
router.delete('/gym-classes/:id', auth, requirePermission('classes'), gymClassController.deleteClass);

/* ------------------------------ Class Bookings ------------------------------- */
//
// Sessions are computed from each class's weekly template rather than stored,
// so these read routes take a date range and expand it. See
// services/classSessions.js.
//
// optionalAuth on the two public reads: an anonymous visitor gets a working
// timetable, and a signed-in member gets the same thing plus which sessions
// they already hold a place on.
router.get('/timetable', optionalAuth, classBookingController.timetable);
router.get('/gym-classes/:id/sessions', optionalAuth, classBookingController.classSessions);

// A member acting for themselves. `create` reads req.isStaffBooking to decide
// whether a `userId` in the body is honoured; it is unset here, so on this
// route a member can only ever book themselves in.
router.post('/bookings', auth, classBookingController.create);
router.get('/bookings/me', auth, classBookingController.mine);

// Staff routes. The flag below is what unlocks booking or cancelling on behalf
// of somebody else, and it is set ONLY after requirePermission has run -- so it
// cannot be forged by a member posting the same body to the route above.
const asStaff = (req, res, next) => {
  req.isStaffBooking = true;
  next();
};

router.get('/bookings/session', auth, requirePermission('bookings'), classBookingController.session);
router.get('/bookings', auth, requirePermission('bookings'), classBookingController.list);
router.post('/bookings/staff', auth, requirePermission('bookings', 'manage'), asStaff, classBookingController.create);
router.patch('/bookings/:id/status', auth, requirePermission('bookings', 'manage'), classBookingController.setStatus);

// Cancel is deliberately NOT permission-gated: a member cancelling their own
// booking is the common case and must not need a staff permission. The handler
// checks ownership, and the staff variant below grants the wider power.
router.delete('/bookings/staff/:id', auth, requirePermission('bookings', 'manage'), asStaff, classBookingController.cancel);
router.delete('/bookings/:id', auth, classBookingController.cancel);

/* ----------------------------- Timetable changes ---------------------------- */
//
// Cancelled sessions, closed days, stand-in instructors and room changes --
// see controller/classExceptionController.js. Reads are staff-only; the
// public timetable already carries the effect of each change.
const classExceptionController = require('../controller/classExceptionController');
router.get('/class-exceptions', auth, requirePermission('classes'), classExceptionController.list);
router.post('/class-exceptions', auth, requirePermission('classes', 'manage'), classExceptionController.create);
router.delete('/class-exceptions/:id', auth, requirePermission('classes', 'manage'), classExceptionController.remove);

/* ------------------------------ Personal training --------------------------- */
//
// See controller/ptController.js. Same shape as class bookings: a member
// route that only ever acts for the caller, and staff routes behind the
// permission that set req.isStaffBooking.
const ptController = require('../controller/ptController');
router.get('/pt/trainers', ptController.trainers);
router.get('/pt/availability', optionalAuth, ptController.availability);
router.post('/pt/sessions', auth, ptController.create);
router.get('/pt/sessions/me', auth, ptController.mine);
router.get('/pt/sessions', auth, requirePermission('pt'), ptController.list);
router.get('/pt/summary', auth, requirePermission('pt'), ptController.summary);
router.post('/pt/sessions/staff', auth, requirePermission('pt', 'manage'), asStaff, ptController.create);
router.patch('/pt/sessions/:id/status', auth, requirePermission('pt', 'manage'), ptController.setStatus);
router.delete('/pt/sessions/staff/:id', auth, requirePermission('pt', 'manage'), asStaff, ptController.cancel);
router.delete('/pt/sessions/:id', auth, ptController.cancel);

/* ---------------------------------- Trainers --------------------------------- */
router.get('/trainers/active', trainerController.getActiveTrainers);
router.get('/trainers/featured', trainerController.getFeaturedTrainers);
router.get('/trainers/slug/:slug', trainerController.getTrainerBySlug);
router.get('/trainers/:id', trainerController.getTrainerById);
router.get('/trainers', auth, requirePermission('trainers'), trainerController.getAllTrainers);
router.post(
  '/trainers',
  auth, requirePermission('trainers'),
  uploadFields([
    { name: 'image', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
  ]),
  trainerController.createTrainer
);
router.put(
  '/trainers/:id',
  auth, requirePermission('trainers'),
  uploadFields([
    { name: 'image', maxCount: 1 },
    { name: 'gallery', maxCount: 10 },
  ]),
  trainerController.updateTrainer
);
router.patch('/trainers/:id/toggle-active', auth, requirePermission('trainers'), trainerController.toggleTrainerStatus);
router.patch('/trainers/:id/toggle-featured', auth, requirePermission('trainers'), trainerController.toggleTrainerFeatured);
router.delete('/trainers/:id', auth, requirePermission('trainers'), trainerController.deleteTrainer);

/* ---------------------------------- Packages --------------------------------- */
router.get('/packages/active', packageController.getActivePackages);
router.get('/packages/:id', packageController.getPackageById);
router.get('/packages', auth, requirePermission('packages'), packageController.getAllPackages);
router.post('/packages', auth, requirePermission('packages'), packageController.createPackage);
router.put('/packages/:id', auth, requirePermission('packages'), packageController.updatePackage);
router.patch('/packages/:id/toggle-active', auth, requirePermission('packages'), packageController.togglePackageStatus);
router.patch('/packages/:id/order', auth, requirePermission('packages'), packageController.updatePackageOrder);
router.delete('/packages/:id', auth, requirePermission('packages'), packageController.deletePackage);

/* ---------------------------- Package Registrations -------------------------- */
router.post('/package-registrations', publicWriteLimiter, optionalAuth, packageRegistrationController.createRegistration);
router.get('/package-registrations', auth, requirePermission('registrations'), packageRegistrationController.getAllRegistrations);
router.get('/package-registrations/stats', auth, requirePermission('registrations'), packageRegistrationController.getRegistrationStats);
router.get('/package-registrations/:id', auth, requirePermission('registrations'), packageRegistrationController.getRegistrationById);
router.put('/package-registrations/:id/status', auth, requirePermission('registrations'), packageRegistrationController.updateRegistrationStatus);
router.delete('/package-registrations/:id', auth, requirePermission('registrations'), packageRegistrationController.deleteRegistration);

/* --------------------------------- Coupons ---------------------------------- */
// The public check is what the checkout page calls as the member types a
// code; it reveals only whether the code works and what it takes off.
router.post('/coupons/validate', publicWriteLimiter, optionalAuth, couponController.validate);
router.get('/coupons', auth, requirePermission('coupons'), couponController.list);
router.post('/coupons', auth, requirePermission('coupons', 'manage'), couponController.create);
router.put('/coupons/:id', auth, requirePermission('coupons', 'manage'), couponController.update);
router.delete('/coupons/:id', auth, requirePermission('coupons', 'manage'), couponController.remove);

/* ------------------------------ Package Payments ----------------------------- */
// Which ways of paying this gym offers right now (card needs Stripe keys,
// bank transfer needs at least one bank account on file).
router.get('/payment/methods', optionalAuth, gymfolioPaymentController.paymentMethods);
router.get('/payment/banks', membershipController.banks);
router.post('/payment/bank-transfer', paymentLimiter, auth, membershipController.createBankTransfer);
router.get('/membership/rules', membershipController.rules);

router.get('/payments/public-key', gymfolioPaymentController.getPublicKey);
router.post('/payments/checkout', paymentLimiter, optionalAuth, gymfolioPaymentController.createPackageCheckoutSession);
router.post('/payments/verify', optionalAuth, gymfolioPaymentController.verifyPackagePayment);

// Aliases used by checkoutService on the gymfolio frontend
router.get('/payment/stripe-public-key', gymfolioPaymentController.getPublicKey);
router.post('/payment/create-package-checkout-session', paymentLimiter, optionalAuth, gymfolioPaymentController.createPackageCheckoutSession);
router.get('/payment/verify/:sessionId', paymentLimiter, optionalAuth, gymfolioPaymentController.verifyPackagePayment);
router.post('/payment/verify/:sessionId', paymentLimiter, optionalAuth, gymfolioPaymentController.verifyPackagePayment);
// express.raw, because Stripe signs the exact bytes it sent and
// constructEvent() cannot verify a parsed object. index.js skips its JSON
// parser for this exact path so the stream is still unread when we get here.
router.post(
  '/payment/webhook',
  express.raw({ type: 'application/json' }),
  // Stripe calls the API directly, so the gym is read from the event's
  // metadata rather than from the request's origin.
  tenantFromStripeWebhook,
  gymfolioPaymentController.handleWebhook
);
// The per-gym webhook URL: each gym registers
//   https://<api>/api/gymfolio/payment/webhook/<slug>
// in its own Stripe dashboard, with its own signing secret in Settings.
router.post(
  '/payment/webhook/:slug',
  express.raw({ type: 'application/json' }),
  tenantFromSlugParam,
  gymfolioPaymentController.handleWebhook
);

// Package orders (admin)
router.post('/package-orders/assign', auth, requirePermission('package-orders'), gymfolioPaymentController.assignPackageToUser);
router.get('/package-orders', auth, requirePermission('package-orders'), gymfolioPaymentController.getAllOrders);
router.get('/package-orders/me', auth, gymfolioPaymentController.getUserOrders);
// The desk's member lists (controller/membershipListsController.js). Before
// '/package-orders/:id', which would otherwise take the name for an id.
const membershipListsController = require('../controller/membershipListsController');
router.get('/package-orders/dues', auth, requirePermission('package-orders', 'view'), membershipListsController.dues);
router.get('/package-orders/expiring', auth, requirePermission('package-orders', 'view'), membershipListsController.expiring);
router.get('/package-orders/expired', auth, requirePermission('package-orders', 'view'), membershipListsController.expired);
// A read, sent as a POST only because 500 ids do not fit in an address.
router.post('/package-orders/summary', auth, requirePermission('package-orders', 'view'), membershipListsController.summary);
// The fee desk: find a member, and what they hold and owe (controller/feeDeskController.js).
const feeDeskController = require('../controller/feeDeskController');
router.get('/package-orders/desk/members', auth, requirePermission('package-orders', 'view'), feeDeskController.search);
router.get('/package-orders/desk/members/:userId', auth, requirePermission('package-orders', 'view'), feeDeskController.member);
router.get('/package-orders/:id', auth, gymfolioPaymentController.getOrderById);
router.put('/package-orders/:id/status', auth, requirePermission('package-orders'), gymfolioPaymentController.updateOrderStatus);
router.post('/package-orders/:id/cancel-subscription', auth, gymfolioPaymentController.cancelSubscription);
router.get('/package-orders/:id/subscription-status', auth, gymfolioPaymentController.getSubscriptionStatus);

/* --------------------------- Membership lifecycle --------------------------- */
//
// Member-or-staff routes: the handler checks whether the caller owns the
// order or holds the package-orders permission, and applies the member-side
// limits (freeze length, whether cancelling online is allowed) accordingly.
router.post('/package-orders/:id/proof', publicWriteLimiter, auth, uploadSingle('proof'), membershipController.submitProof);
router.post('/package-orders/:id/freeze', auth, membershipController.freeze);
router.post('/package-orders/:id/unfreeze', auth, membershipController.unfreeze);
router.post('/package-orders/:id/cancel', auth, membershipController.cancel);
router.post('/package-orders/:id/resume', auth, membershipController.resume);
router.post('/package-orders/:id/billing-portal', auth, membershipController.billingPortal);
router.get('/package-orders/:id/invoice.pdf', auth, membershipController.invoicePdf);

// Staff only.
router.post('/package-orders/:id/approve', auth, requirePermission('package-orders', 'manage'), membershipController.approve);
router.post('/package-orders/:id/reject', auth, requirePermission('package-orders', 'manage'), membershipController.reject);
router.post('/package-orders/:id/renew', auth, requirePermission('package-orders', 'manage'), membershipController.renew);
router.post('/package-orders/:id/change-package', auth, requirePermission('package-orders', 'manage'), membershipController.changePackage);
router.post('/package-orders/:id/use-session', auth, requirePermission('package-orders', 'manage'), membershipController.useSession);
router.post('/package-orders/:id/refund', auth, requirePermission('package-orders', 'manage'), membershipController.refund);
router.post('/package-orders/:id/payments', auth, requirePermission('package-orders', 'manage'), membershipController.recordPayment);
router.patch('/package-orders/:id/terms', auth, requirePermission('package-orders', 'manage'), membershipController.editTerms);

module.exports = router;
