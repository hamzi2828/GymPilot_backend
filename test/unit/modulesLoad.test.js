// Every module touched by the payments / attendance / uploads / sign-up /
// daily-job work loads without a database and exports what its callers
// import. `node --check` catches syntax; this catches a renamed export or a
// bad require path, which would otherwise only surface on the first request
// in production.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

function loads(path, wanted = []) {
  const mod = require(path);
  for (const name of wanted) {
    assert.equal(typeof mod[name], 'function', `${path} exports ${name}()`);
  }
  return mod;
}

test('services and helpers load and export their public functions', () => {
  loads('../../src/gymfolio/services/membershipService', [
    'markPaidAndActivate', 'assertNoActiveSubscription', 'consumeSession', 'refund', 'redeemCoupon', 'cancel'
  ]);
  loads('../../src/gymfolio/services/membershipExpiry', ['liveFilter', 'countLiveMembers', 'sweepIfDue']);
  loads('../../src/gymfolio/services/stripeShapes', ['subscriptionIdOf', 'periodOf', 'paymentIntentOf']);
  loads('../../src/gymfolio/services/activationClaim', ['canClaimActivation', 'claimFilter', 'releaseUpdate']);
  loads('../../src/services/gymfolioPaymentService', ['createPackageCheckoutSession', 'verifyPackagePayment', 'handleWebhook', 'activateOnce']);
  loads('../../src/services/campaignService', ['sendBatch', 'resolveAudience']);
  loads('../../src/attendance/services/peopleDirectory', ['membershipFor', 'resolvePerson']);
  loads('../../src/attendance/services/punchService', ['membershipVerdict', 'recordPunch']);
  loads('../../src/attendance/services/timeUtils', ['lastMomentOfLocalDay', 'startOfLocalDay', 'isDateOnly']);
  const blob = loads('../../src/helper/blobUpload', ['uploadToBlob', 'uploadMultipleToBlob', 'inferKind']);
  assert.equal(blob.inferKind('video/mp4'), 'video');
  assert.equal(blob.inferKind('application/pdf'), 'document');
  assert.equal(blob.inferKind('image/png'), 'image');
  assert.equal(blob.inferKind(undefined), 'image');
  const upload = loads('../../src/helper/upload', ['uploadSingle', 'uploadFields', 'ensureUploadsDir']);
  assert.match(upload.NOT_WRITABLE_MESSAGE, /BLOB_READ_WRITE_TOKEN/);
  assert.equal(upload.MAX_HERO_FILE_BYTES, 20 * 1024 * 1024);
  loads('../../src/helper/blobUpload', ['folderFor', 'ownBlobUrl']);
  loads('../../src/platform/services/signupProvisioning', ['completeSignupCheckout', 'signupDecision', 'localeFor', 'provisionInput']);
  loads('../../src/platform/services/platformBilling', ['createSignupCheckoutSession', 'closeSignupCheckoutSession']);
  loads('../../src/platform/jobs', ['scheduleActiveGyms', 'dailyJobPace', 'runWithinBudget', 'orderByLastRun']);
});

test('controllers load with their handlers in place', () => {
  loads('../../src/gymfolio/controller/membershipController', ['refund', 'approve', 'cancel', 'useSession']);
  loads('../../src/gymfolio/controller/gymClassController', ['createClass', 'updateClass', 'toggleClassStatus', 'parseList']);
  loads('../../src/gymfolio/controller/trainerController', ['createTrainer', 'updateTrainer', 'toggleTrainerStatus']);
  loads('../../src/gymfolio/controller/packageController', ['togglePackageStatus']);
  loads('../../src/gymfolio/controller/couponController', ['create', 'update', 'validate']);
  loads('../../src/gymfolio/controller/classBookingController', ['create', 'cancel']);
  loads('../../src/attendance/controller/desktopAppController', ['recent', 'punch']);
  loads('../../src/controller/heroSlideController', ['createSlide', 'updateSlide', 'toggleSlideStatus']);
  loads('../../src/controller/homeSectionController', ['uploadVideo', 'uploadImage']);
  loads('../../src/controller/posController', ['createSale', 'adjustStock', 'refundSale']);
  loads('../../src/controller/dashboardController', ['overview']);
  loads('../../src/controller/reportsController', ['overview', 'export']);
  loads('../../src/controller/messagingController', ['sendCampaign', 'createAnnouncement', 'updateAnnouncement']);
  loads('../../src/accounts/controller/expenseController', ['create', 'update']);
  loads('../../src/accounts/controller/assetController', ['create', 'update']);
  const uploads = loads('../../src/controller/uploadController', ['authorizeBlobUpload', 'handleBlobUpload', 'capabilities', 'planDirectUpload', 'tokenOptionsFor']);
  assert.deepEqual(Object.keys(uploads.KINDS).sort(), ['hero-slide', 'homepage-image', 'homepage-video', 'testimonial']);
  loads('../../src/controller/memberOptionsController', ['options', 'buildFilter', 'readLimit', 'optionView']);
  loads('../../src/controller/adminSearchController', ['search', 'readTerms', 'searchableGroups']);
  loads('../../src/controller/adminNotificationsController', ['list', 'visibleChecks', 'presentItems']);
  loads('../../src/controller/leadController', ['publicEnquiry', 'validatePublicLead', 'leadFromEnquiry']);
  loads('../../src/platform/controllers/billingController', ['subscription', 'planUsage']);
  loads('../../src/platform/controllers/signupController', ['start', 'status', 'selfServeAvailable', 'validateSignup']);
});

test('the platform job-run record is a platform model with one row per job and gym', () => {
  const PlatformJobRun = require('../../src/platform/models/platformJobRunModel');
  assert.equal(PlatformJobRun.modelName, 'PlatformJobRun');
  assert.equal(PlatformJobRun.collection.collectionName, 'platform_job_runs');
  for (const field of ['job', 'gymId', 'gymSlug', 'lastStartedAt', 'lastRunAt', 'lastOutcome', 'lastError', 'lastDurationMs']) {
    assert.ok(PlatformJobRun.schema.path(field), `PlatformJobRun has ${field}`);
  }
  const unique = PlatformJobRun.schema.indexes().find(([fields]) => JSON.stringify(fields) === JSON.stringify({ job: 1, gymId: 1 }));
  assert.ok(unique && unique[1].unique === true, 'one run record per job and gym');
});

test('the gymfolio router mounts, with or without the shared rate limiters', () => {
  const router = require('../../src/gymfolio/routes/gymfolioRoutes');
  assert.equal(typeof router, 'function');
  const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.ok(paths.includes('/package-orders/:id/refund'), 'refund route is mounted');
  assert.ok(paths.includes('/payment/create-package-checkout-session'));
  assert.ok(paths.includes('/coupons/validate'));
});

test('models still register as tenant models and carry the new fields and indexes', async () => {
  const { runWithTenant } = require('../../src/platform/tenantContext');
  const PackageOrder = require('../../src/gymfolio/models/packageOrderModel');
  const HeroSlide = require('../../src/models/heroSlideModel');
  const HomeSection = require('../../src/models/homeSectionModel');
  const AttendanceLog = require('../../src/attendance/models/attendanceLogModel');
  const GymClass = require('../../src/gymfolio/models/gymClassModel');
  const Trainer = require('../../src/gymfolio/models/trainerModel');

  const gym = { _id: '000000000000000000000003', slug: 'unit-gym-models', database: { name: 'gympilot_unit_gym' }, domains: [], locale: { timezone: 'UTC' } };
  await runWithTenant(gym, async () => {
    assert.ok(PackageOrder.schema.path('refund.amount'), 'refund block on the order');
    assert.ok(PackageOrder.schema.path('refund.stripeRefundId'));
    const orderIndexes = PackageOrder.schema.indexes().map(([fields]) => JSON.stringify(fields));
    assert.ok(orderIndexes.includes(JSON.stringify({ 'subscription.endDate': 1 })));
    assert.ok(orderIndexes.includes(JSON.stringify({ status: 1, 'payment.status': 1, 'subscription.endDate': 1 })));
    assert.ok(orderIndexes.includes(JSON.stringify({ 'payment.paidAt': -1 })));
    const sparse = PackageOrder.schema.indexes().find(([fields]) => fields['payment.stripePaymentIntentId'] === 1);
    assert.ok(sparse && sparse[1].sparse === true, 'payment intent index is sparse');
    assert.equal(typeof PackageOrder.generateOrderNumber, 'function');

    // One slug index each, from the field definition, not two.
    for (const Model of [GymClass, Trainer]) {
      const slugIndexes = Model.schema.indexes().filter(([fields]) => fields.slug === 1);
      assert.equal(slugIndexes.length, 1, `${Model.modelName} declares slug once`);
      assert.equal(slugIndexes[0][1].unique, true);
    }

    const ttl = AttendanceLog.schema.indexes().find(([, opts]) => opts && opts.expireAfterSeconds);
    assert.ok(ttl, 'attendance LOG rows expire');
    assert.equal(ttl[1].expireAfterSeconds, 400 * 24 * 60 * 60);

    const slide = new HeroSlide({ title: 't', description: 'd', imageUrl: '/uploads/x.jpg', buttonText: 'Go', buttonLink: '/x' });
    const json = slide.toJSON();
    assert.equal(json.image, '/uploads/x.jpg');
    assert.equal(json.subtitle, 'd');
    assert.equal(json.ctaText, 'Go');
    assert.equal(json.ctaLink, '/x');

    assert.equal(typeof HomeSection.ensureDefaults, 'function');
    assert.equal(typeof HomeSection.resetDefaultsCache, 'function');
  });
});
