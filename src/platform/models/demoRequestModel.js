// src/platform/models/demoRequestModel.js
//
// A gym that asked for a demo, or one that filled in checkout to start a
// trial. Both are the same thing at this stage -- somebody who wants a gym set
// up -- so they are one record with a `kind`, worked from the panel's Demo
// requests page. Platform-wide (it is not a gym's data yet), so it lives in
// the main database with the other platform records.
//
// A checkout also carries what they chose: the plan, the billing cycle, the
// add-ons, and what that came to. The price is worked out on the server, not
// taken from the form, so the record says what we would actually charge.
//
// A 'signup' is a checkout that pays online (controllers/signupController.js):
// the record is made before the buyer goes to Stripe, and the payment's
// webhook turns it into a gym with nobody in the panel involved
// (services/signupProvisioning.js). `signup` says how far that has got.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const DEMO_REQUEST_STATUSES = ['new', 'contacted', 'converted', 'closed'];
const DEMO_REQUEST_KINDS = ['demo', 'trial', 'signup'];
// awaiting_payment -> provisioning -> ready, or failed (Stripe retries, and
// each retry tries again; so does the daily job). A failed signup given up on
// stays failed, with signup.gaveUpAt set.
const SIGNUP_STATES = ['awaiting_payment', 'provisioning', 'ready', 'failed'];

// How far an online signup has got, and what it needs to get further.
const signupSchema = new mongoose.Schema(
  {
    state: { type: String, enum: SIGNUP_STATES, default: 'awaiting_payment' },
    // The buyer's browser clock, the best guess at the gym's timezone.
    timezone: { type: String, default: '', trim: true, maxlength: 64 },
    // The newest Stripe payment page opened for it; an older one is expired
    // when a new one is made, so the buyer cannot pay twice.
    stripeSessionId: { type: String, default: '', trim: true },
    stripeCustomerId: { type: String, default: '', trim: true },
    stripeSubscriptionId: { type: String, default: '', trim: true },
    // When a webhook delivery started building the gym. A claim older than
    // the webhook's own stale window belongs to a delivery that died.
    claimedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    // Why the last attempt failed, for the panel. Cleared on the next one.
    error: { type: String, default: '', maxlength: 2000 },
    // What the success page shows once the gym exists.
    siteUrl: { type: String, default: '', trim: true },
    trialEndsAt: { type: Date, default: null },
    inviteSent: { type: Boolean, default: false },
    // Setting it up again when nothing else will (services/signupProvisioning.js
    // recoverSignup): the daily job, or the success page, retries a signup left
    // being set up or failed. How many times, when first and last, when the
    // admins were told it is still stuck, and when it was given up on -- its
    // Stripe subscription cancelled and the buyer told.
    recoveryAttempts: { type: Number, default: 0, min: 0 },
    recoveryStartedAt: { type: Date, default: null },
    recoveryAt: { type: Date, default: null },
    alertedAt: { type: Date, default: null },
    gaveUpAt: { type: Date, default: null }
  },
  { _id: false }
);

const demoRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Checkout asks for the two halves separately, because that is how the
    // owner's account inside the gym is created; `name` is kept for the
    // demo form, which asks for one. Empty on an ordinary demo request.
    firstName: { type: String, default: '', trim: true, maxlength: 60 },
    lastName: { type: String, default: '', trim: true, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200, index: true },
    phone: { type: String, default: '', trim: true, maxlength: 40 },
    gymName: { type: String, default: '', trim: true, maxlength: 160 },
    gymSize: { type: String, default: '', trim: true, maxlength: 60 },
    country: { type: String, default: '', trim: true, maxlength: 120 },
    message: { type: String, default: '', trim: true, maxlength: 4000 },
    // Which page sent it (the URL), for attribution.
    source: { type: String, default: '', trim: true, maxlength: 500 },

    // 'demo' asked us to show them; 'trial' picked a plan at checkout;
    // 'signup' picked one and went on to pay for it.
    kind: { type: String, enum: DEMO_REQUEST_KINDS, default: 'demo', index: true },
    // The web address they asked for, if they got as far as choosing one.
    preferredSlug: { type: String, default: '', trim: true, lowercase: true, maxlength: 60 },
    plan: {
      slug: { type: String, default: '', trim: true, lowercase: true },
      name: { type: String, default: '', trim: true },
      billingCycle: { type: String, default: 'monthly', trim: true },
      addonSlugs: { type: [String], default: [] },
      addonNames: { type: [String], default: [] },
      amount: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: '', uppercase: true, trim: true },
      trialDays: { type: Number, default: 0, min: 0 }
    },
    // Anything about the selection the panel should know before it turns
    // this into a gym: an add-on left off because it is priced in another
    // currency than the plan, for one.
    warnings: { type: [String], default: [] },

    status: { type: String, enum: DEMO_REQUEST_STATUSES, default: 'new', index: true },
    notes: { type: String, default: '', trim: true, maxlength: 4000 },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SuperAdmin', default: null },
    // The gym it became, set when the panel creates a gym from it (see
    // gymsController.create), so the request links to the gym and a second
    // "Set this gym up" can be warned about.
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', default: null },
    convertedAt: { type: Date, default: null },

    // Only on a 'signup'; absent on everything else.
    signup: { type: signupSchema, default: undefined },

    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 500 }
  },
  {
    timestamps: true,
    collection: 'platform_demo_requests'
  }
);

demoRequestSchema.index({ status: 1, createdAt: -1 });
// A buyer's own open signup, and whoever else is holding a web address.
demoRequestSchema.index({ kind: 1, email: 1, 'signup.state': 1 });
demoRequestSchema.index({ kind: 1, preferredSlug: 1, 'signup.state': 1 });

const DemoRequest = platformModel('DemoRequest', demoRequestSchema);
DemoRequest.STATUSES = DEMO_REQUEST_STATUSES;
DemoRequest.KINDS = DEMO_REQUEST_KINDS;
DemoRequest.SIGNUP_STATES = SIGNUP_STATES;

module.exports = DemoRequest;
