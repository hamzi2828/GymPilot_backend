// src/routes/allRoutes.js

const express = require('express');
const router = express.Router();
const userController = require('../controller/userController');
const auth = require('../middleware/auth');
const categoryController = require('../controller/categoryController');
const colorController = require('../controller/colorController');
const sizeController = require('../controller/sizeController');
const productController = require('../controller/productController');
const blogCategoryController = require('../controller/blogCategoryController');
const blogController = require('../controller/blogController');
const authorController = require('../controller/authorController');
const settingsController = require('../controller/settingsController');
const heroSlideController = require('../controller/heroSlideController');
const blogHeroController = require('../controller/blogHeroController');
const productDetailController = require('../controller/productDetailController');
const cartController = require('../controller/cartController');
const wishlistController = require('../controller/wishlistController');
const contactController = require('../controller/contactController');
const reviewController = require('../controller/reviewController');
const orderController = require('../controller/orderController');
const blogCommentController = require('../controller/blogCommentController');
const pageController = require('../controller/pageController');
const returnOrderController = require('../controller/returnOrderController');
const discountController = require('../controller/discountController');
const preorderController = require('../controller/preorderController');
const countryController = require('../controller/countryController');
const shippingController = require('../controller/shippingController');
const guidelineController = require('../controller/guidelineController');
const measurementController = require('../controller/measurementController');
const customOrderController = require('../controller/customOrderController');
const fabricController = require('../controller/fabricController');
const kindController = require('../controller/kindController');
const styleController = require('../controller/styleController');
const shippingOptionController = require('../controller/shippingOptionController');
const sizeGuideController = require('../controller/sizeGuideController');
const optionalAuth = require('../middleware/optionalAuth');
const { uploadSingle, uploadArray, uploadFields, heroUploadFields, toPublicPath } = require('../helper/upload');

// Map each HTTP method to the corresponding controller function
router.post('/user/login', userController.loginUser);
router.post('/user/signup', userController.createUser);
router.post('/user/google-login', userController.googleLoginUser);
router.put('/update/user', auth, userController.updateUser);
router.delete('/user', auth, userController.deleteUser);
router.get('/userDetailForProfile', auth, userController.getUserDetailForProfile);
router.get('/get/allUsers', auth, userController.getAllUsers);

// Google OAuth 2.0 redirect flow
router.get('/auth/google', userController.startGoogleOAuth);
router.get('/auth/google/callback', userController.googleOAuthCallback);

// Admin operations by ID
router.put('/update/status/:id', auth, userController.updateUserStatusById);
router.put('/update/role/:id', auth, userController.updateUserRoleById);
router.delete('/delete/:id', auth, userController.deleteUserById);

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
router.get('/colors', auth, colorController.listColors);
router.post('/colors', auth, colorController.createColor);
router.put('/colors/:id', auth, colorController.updateColor);
router.delete('/colors/:id', auth, colorController.deleteColor);

// Size routes
router.get('/sizes', auth, sizeController.listSizes);
router.post('/sizes', auth, sizeController.createSize);
router.put('/sizes/:id', auth, sizeController.updateSize);
router.delete('/sizes/:id', auth, sizeController.deleteSize);

// Product routes
router.get('/products/random', productController.getRandomProducts); // Public route for random products
router.get('/products/latest', productController.getLatestProducts); // Public route for latest products
router.get('/products/featured', productDetailController.getFeaturedProducts); // Public route - must be before :id
router.get('/products/top-rated', productDetailController.getTopRatedProducts); // Public route - must be before :id
router.get('/products/search', productDetailController.searchProducts); // Public route - must be before :id
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
router.get('/blog-categories', blogCategoryController.getAllCategories);
router.get('/blog-categories/with-count', blogCategoryController.getCategoriesWithCount);
router.get('/blog-categories/:id', blogCategoryController.getCategoryById);
router.post('/blog-categories', auth, uploadFields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'banner', maxCount: 1 }
]), blogCategoryController.createCategory);
router.put('/blog-categories/:id', auth, uploadFields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'banner', maxCount: 1 }
]), blogCategoryController.updateCategory);
router.patch('/blog-categories/:id/toggle-active', auth, blogCategoryController.toggleCategoryActive);
router.patch('/blog-categories/:id/toggle-featured', auth, blogCategoryController.toggleCategoryFeatured);
router.delete('/blog-categories/:id', auth, blogCategoryController.deleteCategory);

// Blog routes
router.get('/blogs', blogController.getAllBlogs);
router.get('/blogs/featured', blogController.getFeaturedBlogs);
router.get('/blogs/featured-categories', blogController.getFeaturedCategoriesWithBlogs);
router.get('/blogs/slug/:slug', blogController.getBlogBySlug);
router.get('/blogs/:id', blogController.getBlogById);
router.post(
  '/blogs',
  auth,
  uploadFields([
    { name: 'image', maxCount: 1 },      // Cover image (required)
    { name: 'thumbnail', maxCount: 1 }   // Thumbnail (optional)
  ]),
  blogController.createBlog
);
router.put(
  '/blogs/:id',
  auth,
  uploadFields([
    { name: 'image', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 }
  ]),
  blogController.updateBlog
);
router.delete('/blogs/:id', auth, blogController.deleteBlog);
router.patch('/blogs/:id/views', blogController.incrementViews);
router.patch('/blogs/:id/featured', auth, blogController.toggleFeatured);
router.patch('/blogs/:id/status', auth, blogController.toggleStatus);
router.get('/categories/:categoryId/blogs', blogController.getBlogsByCategory);

// Author routes
router.get('/authors', authorController.getAllAuthors);
router.get('/authors/dropdown', authorController.getAuthorsForDropdown);
router.get('/authors/:id', authorController.getAuthorById);
router.post('/authors', auth, uploadFields([{ name: 'avatar', maxCount: 1 }]), authorController.createAuthor);
router.put('/authors/:id', auth, uploadFields([{ name: 'avatar', maxCount: 1 }]), authorController.updateAuthor);
router.patch('/authors/:id/toggle-active', auth, authorController.toggleAuthorActive);
router.delete('/authors/:id', auth, authorController.deleteAuthor);

// Blog Hero routes
router.get('/blog-hero/active', blogHeroController.getActiveHero); // Public route
router.get('/blog-hero', auth, blogHeroController.getAllHeroes);
router.get('/blog-hero/:id', auth, blogHeroController.getHeroById);
router.post('/blog-hero', auth, heroUploadFields([{ name: 'backgroundImage', maxCount: 1 }]), blogHeroController.createHero);
router.put('/blog-hero/:id', auth, heroUploadFields([{ name: 'backgroundImage', maxCount: 1 }]), blogHeroController.updateHero);
router.delete('/blog-hero/:id', auth, blogHeroController.deleteHero);
router.patch('/blog-hero/:id/toggle-active', auth, blogHeroController.toggleActiveStatus);
router.post('/blog-hero/upload-image', auth, heroUploadFields([{ name: 'image', maxCount: 1 }]), blogHeroController.uploadImage);

// Settings routes
router.get('/settings/public', settingsController.getPublicSettings); // Public route - no auth
router.get('/settings', auth, settingsController.getSettings);
router.put('/settings', auth, settingsController.updateSettings);
router.post('/settings/logo', auth, uploadFields([{ name: 'logo', maxCount: 1 }]), settingsController.uploadLogo);
router.delete('/settings/logo', auth, settingsController.removeLogo);
router.post('/settings/footer-logo', auth, uploadFields([{ name: 'footerLogo', maxCount: 1 }]), settingsController.uploadFooterLogo);
router.delete('/settings/footer-logo', auth, settingsController.removeFooterLogo);
router.post('/settings/reset', auth, settingsController.resetSettings);

// Hero Slide routes
router.get('/hero-slides/active', heroSlideController.getActiveSlides); // Public route
router.get('/hero-slides', auth, heroSlideController.getAllSlides);
router.get('/hero-slides/:id', auth, heroSlideController.getSlideById);
router.post('/hero-slides', auth, uploadSingle('image'), heroSlideController.createSlide);
router.put('/hero-slides/:id', auth, uploadSingle('image'), heroSlideController.updateSlide);
router.patch('/hero-slides/:id/status', auth, heroSlideController.toggleSlideStatus);
router.patch('/hero-slides/:id/order', auth, heroSlideController.updateSlideOrder);
router.delete('/hero-slides/:id', auth, heroSlideController.deleteSlide);

// Product Detail routes (Public - No authentication required)
router.get('/product-detail/:slug/related', productDetailController.getRelatedProducts);
router.get('/product-detail/:slug/recent-purchases', productDetailController.getRecentPurchases);
router.get('/product-detail/:slug', productDetailController.getProductDetail);
router.get('/products-by-category/:category', productDetailController.getProductsByCategory);
router.get('/product-categories', productDetailController.getProductCategories);

// Cart routes (Authentication required)
router.post('/api/cart', auth, cartController.addToCart);
router.get('/api/cart', auth, cartController.getCart);
router.put('/api/cart/item/:itemId', auth, cartController.updateCartItem);
router.delete('/api/cart/item/:itemId', auth, cartController.removeFromCart);
router.delete('/api/cart', auth, cartController.clearCart);
router.post('/api/cart/merge', auth, cartController.mergeGuestCart);

// Wishlist routes (Authentication required)
router.get('/api/wishlist', auth, wishlistController.getWishlist);
router.post('/api/wishlist', auth, wishlistController.addToWishlist);
router.delete('/api/wishlist/:productId', auth, wishlistController.removeFromWishlist);
router.delete('/api/wishlist', auth, wishlistController.clearWishlist);

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
const storefrontController = require('../controller/storefrontController');
const homeSectionController = require('../controller/homeSectionController');

router.get('/api/public/storefront/products', storefrontController.listProducts);
router.get('/api/public/storefront/nav', storefrontController.getNav);
router.get('/api/public/storefront/products/:slug', storefrontController.getProduct);

// Homepage blocks — public read, authenticated write.
router.get('/api/public/home-sections', homeSectionController.getPublicSections);
router.get('/home-sections', auth, homeSectionController.getAll);
router.patch('/home-sections/reorder', auth, homeSectionController.reorder);
router.get('/home-sections/:id', auth, homeSectionController.getById);
router.post('/home-sections', auth, homeSectionController.create);
router.put('/home-sections/:id', auth, homeSectionController.update);
router.patch('/home-sections/:id/status', auth, homeSectionController.toggleStatus);
router.delete('/home-sections/:id', auth, homeSectionController.remove);

// Generic admin media upload. Home-section tiles, and anything else that needs
// an image URL without owning a model of its own, post here and get back the
// public path to store.
router.post('/api/admin/media', auth, uploadSingle('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file received' });
  }
  res.status(201).json({
    success: true,
    data: {
      url: toPublicPath(req.file.filename),
      originalName: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype,
    },
  });
});

// Newsletter routes
router.post('/api/newsletter/subscribe', newsletterController.subscribe);
router.post('/api/newsletter/unsubscribe', newsletterController.unsubscribe);
router.get('/api/newsletter/stats', auth, newsletterController.getStats);
router.get('/api/newsletter/subscribers', auth, newsletterController.getAllSubscribers);

// Contact routes
router.post('/api/contact/submit', contactController.submitContact); // Public route
router.get('/api/contact', auth, contactController.getAllContacts); // Admin only
router.get('/api/contact/stats', auth, contactController.getContactStats); // Admin only
router.get('/api/contact/:id', auth, contactController.getContactById); // Admin only
router.put('/api/contact/:id/status', auth, contactController.updateContactStatus); // Admin only
router.put('/api/contact/:id/priority', auth, contactController.updateContactPriority); // Admin only
router.post('/api/contact/:id/note', auth, contactController.addAdminNote); // Admin only
router.put('/api/contact/:id/assign', auth, contactController.assignContact); // Admin only
router.put('/api/contact/:id/response-sent', auth, contactController.markResponseSent); // Admin only
router.delete('/api/contact/:id', auth, contactController.deleteContact); // Admin only

// Review routes
router.post('/api/reviews', auth, uploadArray('images', 5), reviewController.createReview);
router.get('/api/reviews/product/:productId', reviewController.getProductReviews);
router.put('/api/reviews/:reviewId', auth, reviewController.updateReview);
router.delete('/api/reviews/:reviewId', auth, reviewController.deleteReview);
router.get('/api/reviews/user', auth, reviewController.getUserReviews);
router.get('/api/reviews/can-review/:productId', auth, reviewController.canReviewProduct);

// Admin Review routes
router.get('/api/admin/reviews', auth, reviewController.getAllReviews);
router.get('/api/admin/reviews/stats', auth, reviewController.getReviewStats);
router.get('/api/admin/reviews/:id', auth, reviewController.getReviewById);
router.put('/api/admin/reviews/:id', auth, reviewController.adminUpdateReview);
router.patch('/api/admin/reviews/:id/verify', auth, reviewController.toggleVerified);
router.delete('/api/admin/reviews/:id', auth, reviewController.adminDeleteReview);

// Order routes (for COD and direct orders)
router.post('/api/orders', optionalAuth, orderController.createOrder);
router.get('/api/orders', auth, orderController.getUserOrders);
router.get('/api/orders/guest/lookup', orderController.lookupGuestOrder); // Public route for guest order tracking
router.get('/api/orders/by-number/:orderNumber', optionalAuth, orderController.getOrderByNumber); // Used by checkout success page; returns owner's or guest orders
router.get('/api/orders/:orderId', auth, orderController.getOrderById);

// Blog Comment routes
router.post('/api/blog-comments', auth, blogCommentController.createComment);
router.get('/api/blog-comments/blog/:blogId', blogCommentController.getBlogComments); // Public
router.get('/api/blog-comments/count/:blogId', blogCommentController.getCommentCount); // Public
router.put('/api/blog-comments/:commentId', auth, blogCommentController.updateComment);
router.delete('/api/blog-comments/:commentId', auth, blogCommentController.deleteComment);
router.post('/api/blog-comments/:commentId/like', auth, blogCommentController.toggleLike);

// Dynamic Pages routes
router.get('/pages/slug/:slug', pageController.getPageBySlug); // Public route
router.get('/pages', auth, pageController.getAllPages); // Admin only
router.get('/pages/:id', auth, pageController.getPageById); // Admin only
router.post('/pages', auth, pageController.createPage); // Admin only
router.put('/pages/:id', auth, pageController.updatePage); // Admin only
router.patch('/pages/:id/status', auth, pageController.togglePageStatus); // Admin only
router.delete('/pages/:id', auth, pageController.deletePage); // Admin only

// Return Order routes
router.post('/api/returns', auth, returnOrderController.createReturnRequest);
router.get('/api/returns', auth, returnOrderController.getUserReturns);
router.get('/api/returns/can-return/:orderId', auth, returnOrderController.canReturnOrder);
router.get('/api/returns/:returnId', auth, returnOrderController.getReturnById);

// Admin Return Order routes
router.get('/api/admin/returns', auth, returnOrderController.getAllReturns);
router.get('/api/admin/returns/stats', auth, returnOrderController.getReturnStats);
router.put('/api/admin/returns/:returnId/status', auth, returnOrderController.updateReturnStatus);

// Discount/Coupon routes
router.post('/api/discounts/apply', optionalAuth, discountController.applyDiscount); // Optional auth for per-user coupon tracking
router.get('/api/discounts', auth, discountController.getAllDiscounts); // Admin only
router.get('/api/discounts/stats', auth, discountController.getDiscountStats); // Admin only
router.get('/api/discounts/generate-code', auth, discountController.generateCode); // Admin only
router.get('/api/discounts/:id', auth, discountController.getDiscountById); // Admin only
router.post('/api/discounts', auth, discountController.createDiscount); // Admin only
router.put('/api/discounts/:id', auth, discountController.updateDiscount); // Admin only
router.patch('/api/discounts/:id/status', auth, discountController.toggleDiscountStatus); // Admin only
router.delete('/api/discounts/:id', auth, discountController.deleteDiscount); // Admin only

// Preorder routes
router.post('/api/preorders', optionalAuth, preorderController.createPreorder); // Optional auth - works for guests and logged-in users
router.get('/api/preorders/check/:productId', preorderController.checkPreorder); // Public
router.get('/api/preorders/user', auth, preorderController.getUserPreorders); // Auth required
router.delete('/api/preorders/:id', auth, preorderController.cancelPreorder); // Auth required

// Admin Preorder routes
router.get('/api/admin/preorders', auth, preorderController.getAllPreorders); // Admin only
router.post('/api/admin/preorders/notify/:productId', auth, preorderController.sendBackInStockNotifications); // Admin only
router.put('/api/admin/products/:productId/preorder', auth, preorderController.toggleProductPreorder); // Admin only
router.delete('/api/admin/preorders/all', auth, preorderController.deleteAllPreorders); // Admin only - delete all preorders
router.delete('/api/admin/preorders/:id', auth, preorderController.adminCancelPreorder); // Admin only

// County and State routes
router.get('/api/counties', countryController.getAllCounties); // Public - for dropdowns
router.get('/api/counties/:id', countryController.getCountyById); // Public
router.get('/api/counties/:id/states', countryController.getStatesByCounty); // Public - get active states
router.post('/api/counties', auth, countryController.createCounty); // Admin only
router.put('/api/counties/:id', auth, countryController.updateCounty); // Admin only
router.delete('/api/counties/:id', auth, countryController.deleteCounty); // Admin only
router.post('/api/counties/:id/states', auth, countryController.addState); // Admin only
router.put('/api/counties/:countyId/states/:stateId', auth, countryController.updateState); // Admin only
router.delete('/api/counties/:countyId/states/:stateId', auth, countryController.deleteState); // Admin only
router.get('/api/counties/:countyId/states/:stateId/cities', countryController.getCitiesByState); // Public - get active cities for a province
router.post('/api/counties/:countyId/states/:stateId/cities', auth, countryController.addCity); // Admin only
router.put('/api/counties/:countyId/states/:stateId/cities/:cityId', auth, countryController.updateCity); // Admin only
router.delete('/api/counties/:countyId/states/:stateId/cities/:cityId', auth, countryController.deleteCity); // Admin only

// Shipping routes
router.get('/api/shipping/public', shippingController.getPublicSettings); // Public - for checkout
router.post('/api/shipping/calculate', shippingController.calculateShipping); // Public - calculate shipping
router.get('/api/shipping', auth, shippingController.getSettings); // Admin only
router.put('/api/shipping', auth, shippingController.updateSettings); // Admin only
router.post('/api/shipping/zones', auth, shippingController.addZone); // Admin only
router.put('/api/shipping/zones/:zoneId', auth, shippingController.updateZone); // Admin only
router.delete('/api/shipping/zones/:zoneId', auth, shippingController.deleteZone); // Admin only

// Guideline routes
router.get('/guidelines/public', guidelineController.listGuidelines); // Public - for frontend
router.get('/guidelines', auth, guidelineController.listGuidelines); // Admin only
router.get('/guidelines/:id', auth, guidelineController.getGuidelineById); // Admin only
router.post('/guidelines', auth, uploadFields([{ name: 'images', maxCount: 10 }]), guidelineController.createGuideline); // Admin only
router.put('/guidelines/:id', auth, uploadFields([{ name: 'images', maxCount: 10 }]), guidelineController.updateGuideline); // Admin only
router.patch('/guidelines/:id/toggle-active', auth, guidelineController.toggleActive); // Admin only
router.delete('/guidelines/:id', auth, guidelineController.deleteGuideline); // Admin only

// Measurement routes
router.get('/measurements/public', measurementController.listMeasurements); // Public - for checkout
router.get('/measurements', auth, measurementController.listMeasurements); // Admin only
router.get('/measurements/:id', auth, measurementController.getMeasurementById); // Admin only
router.post('/measurements', auth, measurementController.createMeasurement); // Admin only
router.put('/measurements/:id', auth, measurementController.updateMeasurement); // Admin only
router.patch('/measurements/:id/toggle-active', auth, measurementController.toggleActive); // Admin only
router.delete('/measurements/:id', auth, measurementController.deleteMeasurement); // Admin only

// Category measurements
router.get('/categories/:categoryId/measurements', measurementController.getCategoryMeasurements); // Public
router.put('/categories/:categoryId/measurements', auth, measurementController.updateCategoryMeasurements); // Admin only

// Custom Order routes
router.post('/custom-orders', optionalAuth, uploadFields([{ name: 'referenceImages', maxCount: 5 }]), customOrderController.createCustomOrder); // Public with optional auth
router.get('/custom-orders/my-orders', auth, customOrderController.getUserCustomOrders); // User's own orders
router.get('/custom-orders', auth, customOrderController.getAllCustomOrders); // Admin only
router.get('/custom-orders/stats', auth, customOrderController.getCustomOrderStats); // Admin only
router.get('/custom-orders/:id', auth, customOrderController.getCustomOrderById); // Admin only
router.put('/custom-orders/:id', auth, customOrderController.updateCustomOrderStatus); // Admin only
router.delete('/custom-orders/:id', auth, customOrderController.deleteCustomOrder); // Admin only

// Fabric routes
router.get('/fabrics', fabricController.listFabrics); // Public - for dropdowns
router.get('/fabrics/:id', auth, fabricController.getFabricById); // Admin only
router.post('/fabrics', auth, uploadFields([{ name: 'image', maxCount: 1 }]), fabricController.createFabric); // Admin only
router.put('/fabrics/:id', auth, uploadFields([{ name: 'image', maxCount: 1 }]), fabricController.updateFabric); // Admin only
router.delete('/fabrics/:id', auth, fabricController.deleteFabric); // Admin only

// Kind routes
router.get('/kinds/public', kindController.listActiveKinds); // Public - for dropdowns
router.get('/kinds', auth, kindController.listKinds); // Admin only
router.get('/kinds/:id', auth, kindController.getKind); // Admin only
router.post('/kinds', auth, kindController.createKind); // Admin only
router.put('/kinds/:id', auth, kindController.updateKind); // Admin only
router.delete('/kinds/:id', auth, kindController.deleteKind); // Admin only

// Style routes
router.get('/styles/public', styleController.listActiveStyles); // Public - for dropdowns
router.get('/styles', auth, styleController.listStyles); // Admin only
router.get('/styles/:id', auth, styleController.getStyle); // Admin only
router.post('/styles', auth, uploadFields([{ name: 'image', maxCount: 1 }]), styleController.createStyle); // Admin only
router.put('/styles/:id', auth, uploadFields([{ name: 'image', maxCount: 1 }]), styleController.updateStyle); // Admin only
router.delete('/styles/:id', auth, styleController.deleteStyle); // Admin only

// Shipping Option routes (Custom Shipping Options for Customize page)
router.get('/shipping-options/public', shippingOptionController.listActiveShippingOptions); // Public - for checkout
router.get('/shipping-options', auth, shippingOptionController.listShippingOptions); // Admin only
router.get('/shipping-options/:id', auth, shippingOptionController.getShippingOption); // Admin only
router.post('/shipping-options', auth, shippingOptionController.createShippingOption); // Admin only
router.put('/shipping-options/:id', auth, shippingOptionController.updateShippingOption); // Admin only
router.delete('/shipping-options/:id', auth, shippingOptionController.deleteShippingOption); // Admin only

// Size Guide routes
router.get('/size-guides/public', sizeGuideController.listActiveSizeGuides); // Public - for frontend
router.get('/size-guides', auth, sizeGuideController.listSizeGuides); // Admin only
router.get('/size-guides/:id', auth, sizeGuideController.getSizeGuideById); // Admin only
router.post('/size-guides', auth, uploadFields([{ name: 'image', maxCount: 1 }]), sizeGuideController.createSizeGuide); // Admin only
router.put('/size-guides/:id', auth, uploadFields([{ name: 'image', maxCount: 1 }]), sizeGuideController.updateSizeGuide); // Admin only
router.patch('/size-guides/:id/toggle-active', auth, sizeGuideController.toggleActive); // Admin only
router.delete('/size-guides/:id', auth, sizeGuideController.deleteSizeGuide); // Admin only

// HR & Workforce - Employee routes
const employeeController = require('../controller/employeeController');
router.get('/employees', auth, employeeController.getAllEmployees);
router.get('/employees/:id', auth, employeeController.getEmployeeById);
router.post('/employees', auth, employeeController.createEmployee);
router.put('/employees/:id', auth, employeeController.updateEmployee);
router.put('/employees/:id/status', auth, employeeController.updateEmployeeStatus);
router.put('/employees/:id/role', auth, employeeController.updateEmployeeRole);
router.delete('/employees/:id', auth, employeeController.deleteEmployee);

// HR & Workforce - Attendance routes
const attendanceController = require('../controller/attendanceController');
router.get('/attendance', auth, attendanceController.getAllAttendances);
router.get('/attendance/:id', auth, attendanceController.getAttendanceById);
router.post('/attendance', auth, attendanceController.createAttendance);
router.put('/attendance/:id', auth, attendanceController.updateAttendance);
router.delete('/attendance/:id', auth, attendanceController.deleteAttendance);

// HR & Workforce - Salary routes
const salaryController = require('../controller/salaryController');
router.get('/salaries', auth, salaryController.getAllSalaries);
router.get('/salaries/:id', auth, salaryController.getSalaryById);
router.post('/salaries', auth, salaryController.createSalary);
router.put('/salaries/:id', auth, salaryController.updateSalary);
router.delete('/salaries/:id', auth, salaryController.deleteSalary);
router.post('/salaries/:id/payments', auth, salaryController.addPayment);
router.delete('/salaries/:id/payments/:paymentId', auth, salaryController.removePayment);

// HR & Workforce - Activity Log routes
const activityLogController = require('../controller/activityLogController');
router.get('/activity-logs', auth, activityLogController.getAllLogs);
router.get('/activity-logs/employee/:employeeId', auth, activityLogController.getLogsByEmployee);
router.get('/activity-logs/summary/:employeeId', auth, activityLogController.getEmployeeSummary);
router.post('/activity-logs', auth, activityLogController.createLog);

// Procurement - Vendor routes
const vendorController = require('../controller/vendorController');
router.get('/vendors', auth, vendorController.getAllVendors);
router.get('/vendors/dashboard', auth, vendorController.getDashboardStats);
router.get('/vendors/:id', auth, vendorController.getVendorById);
router.post('/vendors', auth, vendorController.createVendor);
router.put('/vendors/:id', auth, vendorController.updateVendor);
router.put('/vendors/:id/status', auth, vendorController.updateVendorStatus);
router.put('/vendors/:id/restore', auth, vendorController.restoreVendor);
router.delete('/vendors/:id', auth, vendorController.deleteVendor);

// Procurement - Purchase routes
const purchaseController = require('../controller/purchaseController');
router.get('/purchases', auth, purchaseController.getAllPurchases);
router.get('/purchases/:id', auth, purchaseController.getPurchaseById);
router.post('/purchases', auth, purchaseController.createPurchase);
router.put('/purchases/:id', auth, purchaseController.updatePurchase);
router.put('/purchases/:id/restore', auth, purchaseController.restorePurchase);
router.delete('/purchases/:id', auth, purchaseController.deletePurchase);
router.get('/purchases/:id/payments', auth, purchaseController.getPurchasePayments);
router.post('/purchases/:id/payments', auth, purchaseController.addPayment);

// Procurement - Payment routes
router.get('/payments', auth, purchaseController.getAllPayments);
router.post('/payments', auth, purchaseController.createPayment);
router.delete('/payments/:id', auth, purchaseController.deletePayment);

// Finance - Bank routes
const bankController = require('../controller/bankController');
router.get('/banks', auth, bankController.getAllBanks);
router.get('/banks/:id', auth, bankController.getBankById);
router.post('/banks', auth, bankController.createBank);
router.put('/banks/:id', auth, bankController.updateBank);
router.put('/banks/:id/status', auth, bankController.updateBankStatus);
router.put('/banks/:id/restore', auth, bankController.restoreBank);
router.delete('/banks/:id', auth, bankController.deleteBank);

// Finance - Expense routes
const expenseController = require('../controller/expenseController');
router.get('/expenses', auth, expenseController.getAllExpenses);
router.get('/expenses/summary', auth, expenseController.getExpenseSummary);
router.get('/expenses/:id', auth, expenseController.getExpenseById);
router.post('/expenses', auth, uploadSingle('receipt'), expenseController.createExpense);
router.put('/expenses/:id', auth, uploadSingle('receipt'), expenseController.updateExpense);
router.put('/expenses/:id/status', auth, expenseController.updateExpenseStatus);
router.put('/expenses/:id/restore', auth, expenseController.restoreExpense);
router.delete('/expenses/:id', auth, expenseController.deleteExpense);

// Customer routes
const customerController = require('../controller/customerController');
router.get('/customers', auth, customerController.getAllCustomers);
router.get('/customers/stats', auth, customerController.getCustomerStats);
router.get('/customers/search', auth, customerController.searchCustomers);
router.get('/customers/:id', auth, customerController.getCustomerById);
router.post('/customers', auth, customerController.createCustomer);
router.put('/customers/:id', auth, customerController.updateCustomer);
router.put('/customers/:id/status', auth, customerController.updateCustomerStatus);
router.put('/customers/:id/restore', auth, customerController.restoreCustomer);
router.delete('/customers/:id', auth, customerController.deleteCustomer);

// Reporting routes
const reportController = require('../controller/reportController');
router.get('/reports/sales', auth, reportController.getSalesReport);
router.get('/reports/purchases', auth, reportController.getPurchaseReport);
router.get('/reports/cost-analysis', auth, reportController.getCostAnalysis);
router.get('/reports/receivables', auth, reportController.getReceivablesReport);
router.post('/reports/export', auth, reportController.exportReport);

// POS routes - Point of Sale system
const posRoutes = require('./posRoutes');
router.use('/api/pos', posRoutes);

// Affiliate routes
const affiliateController = require('../controller/affiliateController');

// User-side
router.get('/api/affiliate/me', auth, affiliateController.getMyAffiliate);
router.post('/api/affiliate/apply', auth, affiliateController.applyForAffiliate);
router.put('/api/affiliate/me/payout', auth, affiliateController.updatePayoutDetails);
router.get('/api/affiliate/my-commissions', auth, affiliateController.getMyCommissions);
router.get('/api/affiliate/products', auth, affiliateController.getMyAffiliateProducts);

// Admin-side
router.get('/api/admin/affiliates', auth, affiliateController.adminListAffiliates);
router.get('/api/admin/affiliates/:id', auth, affiliateController.adminGetAffiliate);
router.post('/api/admin/affiliates/:id/approve', auth, affiliateController.adminApprove);
router.post('/api/admin/affiliates/:id/reject', auth, affiliateController.adminReject);
router.put('/api/admin/affiliates/:id', auth, affiliateController.adminUpdateAffiliate);
router.get('/api/admin/affiliate-commissions', auth, affiliateController.adminListCommissions);
router.post('/api/admin/affiliate-commissions/mark-paid', auth, affiliateController.adminMarkPaid);

module.exports = router;
