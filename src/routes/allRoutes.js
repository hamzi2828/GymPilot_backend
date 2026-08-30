// src/routes/allRoutes.js

const express = require('express');
const router = express.Router();
const userController = require('../controller/userController');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const roleController = require('../controller/roleController');
const staffController = require('../controller/staffController');
const categoryController = require('../controller/categoryController');
const productController = require('../controller/productController');
const blogController = require('../controller/blogController');
const settingsController = require('../controller/settingsController');
const heroSlideController = require('../controller/heroSlideController');
const blogHeroController = require('../controller/blogHeroController');
const contactController = require('../controller/contactController');
const orderController = require('../controller/orderController');
const optionalAuth = require('../middleware/optionalAuth');
const { uploadSingle, uploadArray, uploadFields, heroUploadFields, videoUploadSingle, toPublicPath } = require('../helper/upload');

const {
  loginLimiter,
  passwordResetLimiter,
  passwordResetConfirmLimiter,
  signupLimiter
} = require('../middleware/rateLimit');

// Map each HTTP method to the corresponding controller function
router.post('/user/login', loginLimiter, userController.loginUser);
router.post('/user/signup', signupLimiter, userController.createUser);
router.post('/user/google-login', userController.googleLoginUser);

// ---------------------------------------------------------------------------
// Password reset
//
// Two endpoints, because the reset is two steps taken by two different people
// in two different places: a request from whoever is at the sign-in screen,
// and a confirmation from whoever opened the email. Neither needs a token from
// the other, and neither is authenticated -- the emailed token IS the proof.
//
// /change-password is the signed-in equivalent and does need `auth`.
// ---------------------------------------------------------------------------
router.post('/user/forgot-password', passwordResetLimiter, userController.forgotPassword);
router.post('/user/reset-password', passwordResetConfirmLimiter, userController.resetPassword);
router.put('/user/change-password', auth, userController.changePassword);
router.put('/update/user', auth, userController.updateUser);
router.delete('/user', auth, userController.deleteUser);
router.get('/userDetailForProfile', auth, userController.getUserDetailForProfile);
router.get('/get/allUsers', auth, requirePermission('users'), userController.getAllUsers);
router.post('/admin/users', auth, requirePermission('users'), userController.adminCreateUser);

// ---------------------------------------------------------------------------
// Dashboard
//
// Gated on the 'dashboard' tab, which every staff role that can open the panel
// at all already holds -- so this is a permission check, not a barrier.
// ---------------------------------------------------------------------------
const dashboardController = require('../controller/dashboardController');
router.get('/admin/dashboard', auth, requirePermission('dashboard'), dashboardController.overview);

// ---------------------------------------------------------------------------
// Roles and access
//
// /roles/me is the odd one out: it is NOT permission-gated, because every
// signed-in account must be able to ask what it may do. The admin shell calls
// it before it renders anything, and gating it behind a permission would mean
// needing permission to find out you have none.
// ---------------------------------------------------------------------------
router.get('/roles/me', auth, roleController.me);
router.get('/roles/catalog', auth, requirePermission('roles'), roleController.catalog);
router.get('/roles', auth, requirePermission('roles'), roleController.list);
router.post('/roles', auth, requirePermission('roles', 'manage'), roleController.create);
router.put('/roles/:id', auth, requirePermission('roles', 'manage'), roleController.update);
router.delete('/roles/:id', auth, requirePermission('roles', 'manage'), roleController.remove);

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
router.get('/staff', auth, requirePermission('staff'), staffController.list);
router.post('/staff', auth, requirePermission('staff', 'manage'), staffController.create);
router.put('/staff/:id', auth, requirePermission('staff', 'manage'), staffController.update);
router.patch('/staff/:id/status', auth, requirePermission('staff', 'manage'), staffController.setStatus);
router.delete('/staff/:id', auth, requirePermission('staff', 'manage'), staffController.remove);

// Google OAuth 2.0 redirect flow
router.get('/auth/google', userController.startGoogleOAuth);
router.get('/auth/google/callback', userController.googleOAuthCallback);

// Admin operations by ID
router.put('/update/status/:id', auth, requirePermission('users'), userController.updateUserStatusById);
router.put('/update/role/:id', auth, requirePermission('users'), userController.updateUserRoleById);
router.delete('/delete/:id', auth, requirePermission('users'), userController.deleteUserById);

// User Address routes
router.get('/user/addresses', auth, userController.getUserAddresses);
router.post('/user/addresses', auth, userController.addUserAddress);
router.put('/user/addresses/:addressId', auth, userController.updateUserAddress);
router.delete('/user/addresses/:addressId', auth, userController.deleteUserAddress);
router.put('/user/addresses/:addressId/default', auth, userController.setDefaultAddress);

// Category routes
router.get('/categories/featured-with-products', categoryController.listFeaturedCategoriesWithProducts);
router.get('/categories/shop-premium', categoryController.listFeaturedCategoriesOptimized); // Optimized for "Shop Premium Quality" section
router.get('/categories/tree', categoryController.getCategoryTree); // Hierarchical tree structure
router.get('/categories/public', categoryController.listCategories); // Public route for popular categories
router.get('/categories', categoryController.listCategories);
router.post('/categories', auth, uploadFields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'banner', maxCount: 1 }
]), categoryController.createCategory);
router.put('/categories/:id', auth, uploadFields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
  { name: 'sizeChartRegularCm', maxCount: 1 },
  { name: 'sizeChartRegularInch', maxCount: 1 },
  { name: 'sizeChartRelaxedCm', maxCount: 1 },
  { name: 'sizeChartRelaxedInch', maxCount: 1 },
  { name: 'measuringTipImage', maxCount: 1 }
]), categoryController.updateCategory);
router.delete('/categories/:id', auth, categoryController.deleteCategory);

// Color routes

// Size routes

// Product routes
router.get('/products/random', productController.getRandomProducts); // Public route for random products
router.get('/products/latest', productController.getLatestProducts); // Public route for latest products
router.get('/products', productController.listProducts);
router.get('/products/:id', auth, productController.getProductById);
// Accept multipart form-data with fields: thumbnail (1), banners (up to 10), colorThumbnail (multiple), colorBanner (multiple), customSizeGuideImage (1)
router.post(
  '/products',
  auth,
  uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'banners', maxCount: 10 },
    { name: 'colorThumbnail', maxCount: 10 }, // Allow multiple color thumbnails
    { name: 'colorBanner', maxCount: 20 },    // Allow multiple color banners
    { name: 'customSizeGuideImage', maxCount: 1 }, // Custom size guide image
  ]),
  productController.createProduct
);
router.put('/products/:id', auth, uploadFields([
    { name: 'thumbnail', maxCount: 1 },
    { name: 'banners', maxCount: 10 },
    { name: 'colorThumbnail', maxCount: 10 }, // Allow multiple color thumbnails
    { name: 'colorBanner', maxCount: 20 },    // Allow multiple color banners
    { name: 'customSizeGuideImage', maxCount: 1 }, // Custom size guide image
  ]), productController.updateProduct);

router.delete('/products/:id', auth, productController.deleteProduct);

// Blog Category routes

// Blog routes
router.get('/blogs', blogController.getAllBlogs);
router.get('/blogs/featured', blogController.getFeaturedBlogs);
router.get('/blogs/featured-categories', blogController.getFeaturedCategoriesWithBlogs);
router.get('/blogs/slug/:slug', blogController.getBlogBySlug);
router.get('/blogs/:id', blogController.getBlogById);
router.post(
  '/blogs',
  auth, requirePermission('blogs'),
  uploadFields([
    { name: 'image', maxCount: 1 },      // Cover image (required)
    { name: 'thumbnail', maxCount: 1 }   // Thumbnail (optional)
  ]),
  blogController.createBlog
);
router.put(
  '/blogs/:id',
  auth, requirePermission('blogs'),
  uploadFields([
    { name: 'image', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 }
  ]),
  blogController.updateBlog
);
router.delete('/blogs/:id', auth, requirePermission('blogs'), blogController.deleteBlog);
router.patch('/blogs/:id/views', blogController.incrementViews);
router.patch('/blogs/:id/featured', auth, requirePermission('blogs'), blogController.toggleFeatured);
router.patch('/blogs/:id/status', auth, requirePermission('blogs'), blogController.toggleStatus);
router.get('/categories/:categoryId/blogs', blogController.getBlogsByCategory);

// Author routes

// Blog Hero routes
router.get('/blog-hero/active', blogHeroController.getActiveHero); // Public route
router.get('/blog-hero', auth, requirePermission('blog-settings'), blogHeroController.getAllHeroes);
router.get('/blog-hero/:id', auth, requirePermission('blog-settings'), blogHeroController.getHeroById);
router.post('/blog-hero', auth, requirePermission('blog-settings'), heroUploadFields([{ name: 'backgroundImage', maxCount: 1 }]), blogHeroController.createHero);
router.put('/blog-hero/:id', auth, requirePermission('blog-settings'), heroUploadFields([{ name: 'backgroundImage', maxCount: 1 }]), blogHeroController.updateHero);
router.delete('/blog-hero/:id', auth, requirePermission('blog-settings'), blogHeroController.deleteHero);
router.patch('/blog-hero/:id/toggle-active', auth, requirePermission('blog-settings'), blogHeroController.toggleActiveStatus);
router.post('/blog-hero/upload-image', auth, requirePermission('blog-settings'), heroUploadFields([{ name: 'image', maxCount: 1 }]), blogHeroController.uploadImage);

// Settings routes
router.get('/settings/public', settingsController.getPublicSettings); // Public route - no auth
router.get('/settings', auth, requirePermission('settings'), settingsController.getSettings);
router.put('/settings', auth, requirePermission('settings'), settingsController.updateSettings);
router.post('/settings/logo', auth, requirePermission('settings'), uploadFields([{ name: 'logo', maxCount: 1 }]), settingsController.uploadLogo);
router.delete('/settings/logo', auth, requirePermission('settings'), settingsController.removeLogo);
router.post('/settings/footer-logo', auth, requirePermission('settings'), uploadFields([{ name: 'footerLogo', maxCount: 1 }]), settingsController.uploadFooterLogo);
router.delete('/settings/footer-logo', auth, requirePermission('settings'), settingsController.removeFooterLogo);
router.post('/settings/reset', auth, requirePermission('settings'), settingsController.resetSettings);

// Banks (admin-managed payment accounts, each with an optional barcode image)
const bankController = require('../controller/bankController');
router.get('/banks', auth, requirePermission('settings'), bankController.getAllBanks);
router.get('/banks/:id', auth, requirePermission('settings'), bankController.getBankById);
router.post('/banks', auth, requirePermission('settings'), bankController.createBank);
router.put('/banks/:id', auth, requirePermission('settings'), bankController.updateBank);
router.put('/banks/:id/status', auth, requirePermission('settings'), bankController.updateBankStatus);
router.put('/banks/:id/restore', auth, requirePermission('settings'), bankController.restoreBank);
router.delete('/banks/:id', auth, requirePermission('settings'), bankController.deleteBank);
router.post('/banks/:id/qr-code', auth, requirePermission('settings'), uploadFields([{ name: 'qrCode', maxCount: 1 }]), bankController.uploadQrCode);
router.delete('/banks/:id/qr-code', auth, requirePermission('settings'), bankController.removeQrCode);

router.post('/settings/test-smtp', auth, requirePermission('settings'), settingsController.testSmtp);

// Hero Slide routes
router.get('/hero-slides/active', heroSlideController.getActiveSlides); // Public route
router.get('/hero-slides', auth, requirePermission('hero-slides'), heroSlideController.getAllSlides);
router.get('/hero-slides/:id', auth, requirePermission('hero-slides'), heroSlideController.getSlideById);
router.post('/hero-slides', auth, requirePermission('hero-slides'), uploadSingle('image'), heroSlideController.createSlide);
// Must precede '/hero-slides/:id' or Express matches 'reorder' as an id.
router.put('/hero-slides/reorder', auth, requirePermission('hero-slides'), heroSlideController.reorderSlides);
router.put('/hero-slides/:id', auth, requirePermission('hero-slides'), uploadSingle('image'), heroSlideController.updateSlide);
router.patch('/hero-slides/:id/status', auth, requirePermission('hero-slides'), heroSlideController.toggleSlideStatus);
router.patch('/hero-slides/:id/order', auth, requirePermission('hero-slides'), heroSlideController.updateSlideOrder);
router.delete('/hero-slides/:id', auth, requirePermission('hero-slides'), heroSlideController.deleteSlide);

// Product Detail routes (Public - No authentication required)

// Cart routes (Authentication required)

// Wishlist routes (Authentication required)

// Payment and Order Management Routes
const paymentController = require('../controller/paymentController');

router.post('/api/payment/create-checkout-session', optionalAuth, paymentController.createCheckoutSession);
router.post('/api/payment/create-payment-intent', paymentController.createPaymentIntent);
router.post('/api/payment/webhook', express.raw({ type: 'application/json' }), paymentController.handleWebhook);
router.get('/api/payment/verify/:sessionId', optionalAuth, paymentController.verifyPayment);
router.get('/api/payment/stripe-public-key', paymentController.getPublicKey);
router.get('/api/payment/orders', auth, paymentController.getOrders);
router.get('/api/payment/orders/:orderId', auth, paymentController.getOrderById);
router.get('/api/payment/getAllOrders', auth, paymentController.getAllOrders);
router.put('/api/payment/orders/bulk/status', auth, paymentController.bulkUpdateOrderStatus);
router.delete('/api/payment/orders/bulk', auth, paymentController.bulkDeleteOrders);
router.put('/api/payment/orders/:orderId/status', auth, paymentController.updateOrderStatus);
router.delete('/api/payment/orders/:orderId', auth, paymentController.deleteOrder);
router.post('/api/payment/orders/:orderId/refund', auth, paymentController.refundOrder);

const publicProductController = require('../controller/publicProductController');
const newsletterController = require('../controller/newsletterController');
// Public Product Routes - No authentication required
router.get('/api/public/products', publicProductController.getAllPublishedProducts);
router.get('/api/public/products/shop-latest', publicProductController.getShopLatestProducts); // Optimized for "Shop Latest Products" section
router.get('/api/public/products/shop-sale', publicProductController.getShopSaleProducts); // Optimized for sale products section
router.get('/api/public/products/latest', publicProductController.getLatestProducts);
router.get('/api/public/products/random', publicProductController.getRandomProducts);
router.get('/api/public/products/featured', publicProductController.getFeaturedProducts);
router.get('/api/public/products/search', publicProductController.searchProducts);
router.get('/api/public/products/sale', publicProductController.getSaleProducts);
router.get('/api/public/products/category/:category', publicProductController.getProductsByCategory);
router.get('/api/public/products/:slug', publicProductController.getProductBySlug);

// ---------------------------------------------------------------------------
// Storefront (redesigned UI) — richer read-only payloads for the new
// homepage / listing / detail pages. Runs alongside the legacy public routes
// above so existing pages are untouched.
// ---------------------------------------------------------------------------

// Homepage blocks — public read, admin write. Everything below the hero
// banner is driven by these sections (order, visibility, copy, images).
const homeSectionController = require('../controller/homeSectionController');
router.get('/home-sections/public', homeSectionController.getPublicSections);
router.get('/home-sections', auth, requirePermission('homepage'), homeSectionController.getAllSections);
// Must precede '/home-sections/:key' or Express matches 'reorder' as a key.
router.put('/home-sections/reorder', auth, requirePermission('homepage'), homeSectionController.reorderSections);
// Generic admin media upload. Home-section tiles, and anything else that needs
// an image URL without owning a model of its own, post here and get back the
// public path to store.
router.post('/home-sections/upload', auth, requirePermission('homepage'), uploadSingle('image'), homeSectionController.uploadImage);
router.post('/home-sections/upload-video', auth, requirePermission('homepage'), videoUploadSingle('video'), homeSectionController.uploadVideo);
router.put('/home-sections/:key', auth, requirePermission('homepage'), homeSectionController.updateSection);
router.patch('/home-sections/:key/status', auth, requirePermission('homepage'), homeSectionController.toggleSection);

// Testimonials — member reviews rendered by the homepage testimonials section.
const testimonialController = require('../controller/testimonialController');
router.get('/testimonials/active', testimonialController.getActiveTestimonials);
router.get('/testimonials', auth, requirePermission('testimonials'), testimonialController.getAllTestimonials);
// Must precede '/testimonials/:id' or Express matches 'reorder' as an id.
router.put('/testimonials/reorder', auth, requirePermission('testimonials'), testimonialController.reorderTestimonials);
router.post('/testimonials', auth, requirePermission('testimonials'), uploadSingle('image'), testimonialController.createTestimonial);
router.put('/testimonials/:id', auth, requirePermission('testimonials'), uploadSingle('image'), testimonialController.updateTestimonial);
router.patch('/testimonials/:id/status', auth, requirePermission('testimonials'), testimonialController.toggleTestimonialStatus);
router.delete('/testimonials/:id', auth, requirePermission('testimonials'), testimonialController.deleteTestimonial);

// Newsletter routes
router.post('/api/newsletter/subscribe', newsletterController.subscribe);
router.post('/api/newsletter/unsubscribe', newsletterController.unsubscribe);
router.get('/api/newsletter/stats', auth, newsletterController.getStats);
router.get('/api/newsletter/subscribers', auth, newsletterController.getAllSubscribers);

// Contact routes
router.post('/api/contact/submit', contactController.submitContact); // Public route
router.get('/api/contact', auth, requirePermission('contact-queries'), contactController.getAllContacts); // Admin only
router.get('/api/contact/stats', auth, requirePermission('contact-queries'), contactController.getContactStats); // Admin only
router.get('/api/contact/:id', auth, requirePermission('contact-queries'), contactController.getContactById); // Admin only
router.put('/api/contact/:id/status', auth, requirePermission('contact-queries'), contactController.updateContactStatus); // Admin only
router.put('/api/contact/:id/priority', auth, requirePermission('contact-queries'), contactController.updateContactPriority); // Admin only
router.post('/api/contact/:id/note', auth, requirePermission('contact-queries'), contactController.addAdminNote); // Admin only
router.put('/api/contact/:id/assign', auth, requirePermission('contact-queries'), contactController.assignContact); // Admin only
router.put('/api/contact/:id/response-sent', auth, requirePermission('contact-queries'), contactController.markResponseSent); // Admin only
router.delete('/api/contact/:id', auth, requirePermission('contact-queries'), contactController.deleteContact); // Admin only

// Review routes

// Admin Review routes

// Order routes (for COD and direct orders)
router.post('/api/orders', optionalAuth, orderController.createOrder);
router.get('/api/orders', auth, orderController.getUserOrders);
router.get('/api/orders/guest/lookup', orderController.lookupGuestOrder); // Public route for guest order tracking
router.get('/api/orders/by-number/:orderNumber', optionalAuth, orderController.getOrderByNumber); // Used by checkout success page; returns owner's or guest orders
router.get('/api/orders/:orderId', auth, orderController.getOrderById);

// Blog Comment routes

// Dynamic Pages routes

// Return Order routes

// Admin Return Order routes

// Discount/Coupon routes

// Preorder routes

// Admin Preorder routes

// County and State routes

// Shipping routes

// Guideline routes

// Measurement routes

// Category measurements

// Custom Order routes

// Fabric routes

// Kind routes

// Style routes

// Shipping Option routes (Custom Shipping Options for Customize page)

// Size Guide routes

// HR & Workforce - Employee routes

// HR & Workforce - Attendance routes

// HR & Workforce - Salary routes

// HR & Workforce - Activity Log routes

// Procurement - Vendor routes

// Procurement - Purchase routes

// Procurement - Payment routes

// Finance - Bank routes

// Finance - Expense routes

// Customer routes

// Reporting routes

// POS routes - Point of Sale system

// Affiliate routes

// User-side

// Admin-side

module.exports = router;
