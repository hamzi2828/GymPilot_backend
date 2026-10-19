// packageOrderModel.js - Package Order Model for Gymfolio Package Subscriptions

const mongoose = require('mongoose');
const { tenantModel } = require('../../platform/modelRegistry');
const { PAYMENT_METHODS } = require('../../services/paymentMethods');

const packageOrderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false // Can be null for guest checkouts
    },
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Package',
      required: true
    },
    packageDetails: {
      name: { type: String, required: true },
      price: { type: String, required: true },
      currency: { type: String, required: true },
      period: { type: String, required: true },
      features: [String],
      // Snapshot of the package's shape at the time of sale (see
      // membershipService.packageSnapshot). Older orders have none of these
      // and are treated as plain memberships.
      kind: { type: String, default: 'membership' },
      durationDays: { type: Number, default: 0 },
      sessions: { type: Number, default: 0 },
      joiningFee: { type: Number, default: 0 },
      billing: {
        mode: { type: String, default: 'one_time' },
        interval: { type: String, default: 'month' },
        intervalCount: { type: Number, default: 1 },
        trialDays: { type: Number, default: 0 }
      }
    },
    // Who the membership is for. The name is required because an order that
    // identifies nobody is not an order. The email is not: a member may be
    // on file with only a phone number, and an order for them is no less
    // real (the member record says who they are).
    //
    // Phone and country are NOT required, deliberately. They come from the
    // public checkout form, which asks for them -- but an admin assigning a
    // membership at the desk has no such form, and when they were required
    // that path wrote the literal string 'N/A' into both to get past
    // validation. That made "no phone number" indistinguishable from a member
    // whose number really is on file, and put 'N/A' on the receipt. An empty
    // field says the same thing honestly, and the admin screens can then
    // prompt for what is actually missing.
    customerInfo: {
      fullName: { type: String, required: true },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
      country: { type: String, default: '' },
      address: String,
      city: String,
      state: String,
      zipCode: String
    },
    payment: {
      // services/paymentMethods.js: the list, and what each is called.
      method: {
        type: String,
        enum: PAYMENT_METHODS,
        default: 'stripe'
      },
      stripeSessionId: String,
      stripePaymentIntentId: String,
      stripeCustomerId: String,
      amount: {
        type: Number,
        required: true
      },
      currency: {
        type: String,
        required: true,
        default: 'pkr'
      },
      status: {
        type: String,
        enum: ['pending', 'processing', 'paid', 'failed', 'refunded', 'cancelled'],
        default: 'pending'
      },
      // The FIRST payment, set once. Renewals are payments of their own in
      // subscription.renewals, and revenue counts each in its own period.
      paidAt: Date,
      // The latest charge -- the first payment until a renewal arrives.
      lastPaidAt: { type: Date, default: null },
      transactionId: String,

      // ---- What the amount is made of (gymfolio/services/orderMoney.js) ----
      // The admission fee and the personal trainer's fee charged on THIS
      // order, inside `amount`; the membership is the rest. joiningFee is 0
      // on a renewal, a package change, or when waived. Orders from before
      // these existed read 0 (scripts/backfillOrderFees.js fills joiningFee
      // in where it was charged).
      joiningFee: { type: Number, default: 0 },
      trainerFee: { type: Number, default: 0 },

      // ---- Paying in parts (membershipService.recordPayment) ----
      // A membership sold at the desk may be paid for over time: it is
      // granted -- status 'paid', so everything that treats paid as active
      // keeps working -- while balanceDue > 0. amountPaid is the money
      // received so far; null on orders from before part payments, which
      // were paid in full.
      amountPaid: { type: Number, default: null },
      balanceDue: { type: Number, default: 0 },
      // When non-empty, these ARE the money received for the order, the
      // first payment included, each on the day it arrived with its own
      // method and its admission / trainer-fee shares (admission first).
      // An order paid in full at once keeps none.
      installments: {
        type: [
          new mongoose.Schema(
            {
              amount: { type: Number, required: true },
              joiningFee: { type: Number, default: 0 },
              trainerFee: { type: Number, default: 0 },
              method: { type: String, default: '' },
              at: { type: Date, required: true },
              by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
              note: { type: String, default: '' },
              // The desk's id for the request that recorded this part, when
              // it sent one: the same id again is this part, not another
              // (membershipService.recordPayment).
              requestId: { type: String }
            },
            { _id: false }
          )
        ],
        default: []
      },

      // ---- Discounts ----
      subtotal: { type: Number, default: null },        // list price (+ joining and trainer fees) before discount
      discountAmount: { type: Number, default: 0 },
      discountNote: { type: String, default: '' },      // e.g. credit for unused days on an upgrade
      couponCode: { type: String, default: '' },
      couponRedeemed: { type: Boolean, default: false },

      // ---- Stripe subscriptions ----
      stripeSubscriptionId: { type: String, default: null, index: true },
      stripeInvoiceId: { type: String, default: null },
      lastPaymentError: { type: String, default: '' },

      // ---- Online gateways other than Stripe (services/payments) ----
      // Which gateway took (or is taking) this order's online payment, when
      // it is not Stripe: 'safepay'. Unset on every other order.
      provider: { type: String, default: undefined },
      // Safepay: every checkout opened for this order (a member may open
      // more than one, and pay the balance of a part-paid order separately),
      // and the one that paid. Card details are never here -- Safepay keeps
      // the card; at most a saved card's token is kept, sealed, on the member.
      safepay: {
        type: new mongoose.Schema(
          {
            // The tracker that paid the order (or, before that, the latest opened).
            tracker: { type: String, default: null },
            fee: { type: Number, default: null },   // Safepay's fee on the paying tracker, major units
            net: { type: Number, default: null },   // what reached the gym, major units
            trackers: {
              type: [
                new mongoose.Schema(
                  {
                    token: { type: String, required: true },
                    // 'order': pays the order and activates it; 'balance':
                    // pays what is still owed on a part-paid order.
                    purpose: { type: String, enum: ['order', 'balance'], default: 'order' },
                    // 'checkout': the member on Safepay's page; 'auto': a
                    // saved card charged by the gym (chargeSavedMethod).
                    kind: { type: String, enum: ['checkout', 'auto'], default: 'checkout' },
                    amount: { type: Number, required: true },        // major units
                    amountMinor: { type: Number, required: true },   // what Safepay was asked for
                    currency: { type: String, default: '' },
                    status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
                    saveCard: { type: Boolean, default: false },
                    autoPayConsent: { type: Boolean, default: false },
                    customerToken: { type: String, default: null },
                    savedMethodId: { type: String, default: null },
                    fee: { type: Number, default: null },
                    net: { type: Number, default: null },
                    error: { type: String, default: '' },
                    createdAt: { type: Date, default: Date.now },
                    paidAt: { type: Date, default: null }
                  },
                  { _id: false }
                )
              ],
              default: []
            }
          },
          { _id: false }
        ),
        default: undefined
      },

      // ---- Bank transfer: the receipt the member sent and what staff did with it ----
      proof: {
        url: { type: String, default: '' },
        note: { type: String, default: '' },
        reference: { type: String, default: '' },
        uploadedAt: { type: Date, default: null },
        reviewedAt: { type: Date, default: null },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        rejectionReason: { type: String, default: '' }
      }
    },
    subscription: {
      startDate: Date,
      endDate: Date,
      isActive: {
        type: Boolean,
        default: false
      },
      autoRenew: {
        type: Boolean,
        default: false
      },
      renewalDate: Date,
      // Set when the member (or Stripe) has said "do not renew": access runs
      // to endDate, then the expiry job closes it.
      cancelAtPeriodEnd: { type: Boolean, default: false },
      stripeStatus: { type: String, default: '' },
      renewals: {
        type: [
          new mongoose.Schema(
            {
              // When the money arrived, what was charged and in what -- each
              // renewal is counted as revenue in its own period.
              at: Date,
              amount: Number,
              currency: String,
              invoiceId: String,
              periodEnd: Date
            },
            { _id: false }
          )
        ],
        default: []
      }
    },
    status: {
      type: String,
      // frozen: paused by the member or staff, end date pushed out (and, on
      // a Stripe subscription, the next charge with it).
      // past_due: a Stripe renewal failed; Stripe is retrying.
      enum: ['pending', 'active', 'expired', 'cancelled', 'suspended', 'frozen', 'past_due'],
      default: 'pending'
    },
    notes: String,

    // ---- Lifecycle ----
    freeze: {
      isFrozen: { type: Boolean, default: false },
      frozenAt: { type: Date, default: null },
      resumeAt: { type: Date, default: null },
      reason: { type: String, default: '' },
      totalFrozenDays: { type: Number, default: 0 },
      // How the current (or last) freeze moved the billing, so resuming
      // undoes the same thing (membershipService.freeze):
      //   'stripe_trial'  the Stripe subscription's next charge was pushed
      //                   back by the frozen days (trial_end)
      //   'local'         only the end date here moved: cash and bank terms,
      //                   or a subscription Stripe will not charge again
      //   ''              a freeze from before this field: Stripe collection
      //                   was paused (pause_collection)
      billing: { type: String, default: '' },
      history: {
        type: [
          new mongoose.Schema(
            {
              from: Date,
              to: Date,
              days: Number,
              reason: String,
              by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
              resumedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
              source: String
            },
            { _id: false }
          )
        ],
        default: []
      }
    },
    cancellation: {
      cancelledAt: { type: Date, default: null },
      reason: { type: String, default: '' },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      source: { type: String, default: '' },  // member | staff | stripe
      immediate: { type: Boolean, default: false },
      resumedAt: { type: Date, default: null }
    },
    // Every change staff made to the terms after the sale -- dates moved, the
    // discount changed (membershipService.editTerms) -- with what they were
    // before and after, who did it and why. Appended, never rewritten.
    termsHistory: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, required: true },
            by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
            from: { type: mongoose.Schema.Types.Mixed, default: {} },
            to: { type: mongoose.Schema.Types.Mixed, default: {} },
            note: { type: String, default: '' }
          },
          { _id: false }
        )
      ],
      default: []
    },
    // Money given back, and by whom. Set once, when payment.status becomes
    // 'refunded'; stripeRefundId is null for cash, bank and terminal refunds,
    // which move by hand and are only recorded here.
    refund: {
      amount: { type: Number, default: null },
      reason: { type: String, default: '' },
      at: { type: Date, default: null },
      byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      stripeRefundId: { type: String, default: null },
      // Only while a refund is under way: when it was claimed, so a second
      // refund of the same order is turned away (membershipService.refund).
      // Gone once the refund is recorded or has failed.
      claimedAt: { type: Date }
    },
    // Session packs: how many are on it and how many have been used.
    sessions: {
      total: { type: Number, default: 0 },
      used: { type: Number, default: 0 },
      exhaustedAt: { type: Date, default: null },
      log: {
        type: [
          new mongoose.Schema(
            { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: String },
            { _id: false }
          )
        ],
        default: []
      }
    },
    // The personal trainer sold with this membership at the desk, what the
    // member pays for them (the same figure as payment.trainerFee), and the
    // trainer's commission on it: `commissionValue` is a percentage of the
    // fee ('percent') or a fixed sum ('amount'); `commissionAmount` is what
    // that comes to, earned on the order's first payment date. null when the
    // order was sold without one.
    trainerAssignment: {
      type: new mongoose.Schema(
        {
          trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer', required: true },
          trainerName: { type: String, default: '' },
          fee: { type: Number, default: 0 },
          commissionType: { type: String, enum: ['percent', 'amount'], default: 'percent' },
          commissionValue: { type: Number, default: 0 },
          commissionAmount: { type: Number, default: 0 }
        },
        { _id: false }
      ),
      default: null
    },
    // The order this one renewed or replaced.
    renewedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageOrder', default: null },
    // Set only by the member import, on a membership that came in already
    // paid: the money was taken in the gym's old system, before it moved
    // here. The membership is as good as any other -- dates, the desk,
    // bookings -- but its first payment is not today's takings: the money
    // reports leave it out (ledger.membershipPaymentStages) and it is given
    // no invoice number (invoiceService.ensureInvoice). Anything paid on it
    // later is ordinary money in.
    imported: { type: Boolean },
    // Issued once the order is paid; see services/invoiceService.js.
    invoice: {
      number: { type: String, default: null, index: true },
      issuedAt: { type: Date, default: null },
      taxRate: { type: Number, default: 0 },
      taxLabel: { type: String, default: 'Tax' },
      taxAmount: { type: Number, default: 0 },
      subtotal: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      currency: { type: String, default: '' }
    },

    // Which expiry notices have already gone out for this membership, as the
    // day-counts they were sent for ([14, 7, 1]).
    //
    // Stored on the order rather than in a separate log because the question
    // being asked is always "has THIS membership had THIS notice", and the
    // answer has to survive the cron running twice -- which it will, because a
    // scheduler that retries on timeout is normal. Appended only after a send
    // actually succeeds, so a mail outage retries rather than silently
    // swallowing the reminder.
    remindersSent: {
      type: [Number],
      default: []
    },

    metadata: {
      type: Map,
      of: String
    }
  },
  {
    timestamps: true
  }
);

// Order numbers: PKG<yy><mm><sequence>, one gap-free sequence per gym per
// month, taken from the Counter collection with a single atomic increment.
//
// The old way -- regex for this month's numbers, sort descending, add one --
// handed the same number to two checkouts that started in the same instant,
// and the unique index then failed one of them. It also broke past 9999
// orders a month: 'PKG260910000' sorts below 'PKG26099999' as a string.
//
// The sequence is now padded to five digits. Older four-digit numbers stay
// valid (they are just strings); the first time a month's counter is used it
// is seeded from the highest number already issued that month, so numbering
// carries on from where the old scheme left off rather than restarting.
const ORDER_PREFIX = 'PKG';
const ORDER_SEQUENCE_WIDTH = 5;

function legacySequenceOf(orderNumber, monthPrefix) {
  const tail = String(orderNumber || '').slice(monthPrefix.length);
  const parsed = parseInt(tail, 10);
  return /^\d+$/.test(tail) && !Number.isNaN(parsed) ? parsed : 0;
}

packageOrderSchema.statics.generateOrderNumber = async function() {
  const Counter = require('./counterModel');
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const monthPrefix = `${ORDER_PREFIX}${year}${month}`;
  const key = `package-order-${year}${month}`;

  // First use this month: start the counter after whatever the old scheme
  // already issued. $setOnInsert makes two first-callers agree on one seed.
  const existing = await Counter.findOne({ key }).select('_id').lean();
  if (!existing) {
    // Numeric maximum, not string maximum: a month holding both four- and
    // five-digit numbers does not sort the way it counts.
    const issued = await this.find({ orderNumber: new RegExp(`^${monthPrefix}\\d+$`) }).select('orderNumber').lean();
    const seed = issued.reduce((max, row) => Math.max(max, legacySequenceOf(row.orderNumber, monthPrefix)), 0);
    await Counter.updateOne({ key }, { $setOnInsert: { key, seq: seed } }, { upsert: true });
  }

  const sequence = await Counter.next(key);
  return `${monthPrefix}${String(sequence).padStart(ORDER_SEQUENCE_WIDTH, '0')}`;
};

// Indexes for better query performance
packageOrderSchema.index({ userId: 1, createdAt: -1 });
packageOrderSchema.index({ 'payment.status': 1 });
packageOrderSchema.index({ status: 1 });
packageOrderSchema.index({ 'payment.stripeSessionId': 1 });
packageOrderSchema.index({ 'customerInfo.email': 1 });
packageOrderSchema.index({ createdAt: -1 });
// What the front desk, the expiry sweep, the dashboard and the reports all
// ask: which orders are live, and which are ending when.
packageOrderSchema.index({ 'subscription.endDate': 1 });
packageOrderSchema.index({ status: 1, 'payment.status': 1, 'subscription.endDate': 1 });
// The webhook's lookup for one-off card payments; sparse because most orders
// (subscriptions, bank transfers, cash) never have one.
packageOrderSchema.index({ 'payment.stripePaymentIntentId': 1 }, { sparse: true });
// The Safepay webhook's lookup: which order a tracker belongs to. Sparse,
// like the one above: only orders paid through Safepay carry any.
packageOrderSchema.index({ 'payment.safepay.trackers.token': 1 }, { sparse: true });
// Revenue over a period is read by when the money arrived: the first payment,
// and each renewal (see accounts/services/ledger.js).
packageOrderSchema.index({ 'payment.paidAt': -1 });
packageOrderSchema.index({ 'subscription.renewals.at': -1 });
packageOrderSchema.index({ 'payment.installments.at': -1 }, { sparse: true });
// Who still owes money: only the few orders with a balance are indexed.
packageOrderSchema.index({ 'payment.balanceDue': 1 }, { partialFilterExpression: { 'payment.balanceDue': { $gt: 0 } } });
// One order per desk request (membershipService.createManualOrder): two
// copies of a sale or renewal sent together both pass the "made already?"
// lookup, and this lets only one of them be written. Only orders that carry
// a request id are indexed.
packageOrderSchema.index(
  { userId: 1, 'metadata.requestId': 1 },
  { unique: true, name: 'one_order_per_desk_request', partialFilterExpression: { 'metadata.requestId': { $type: 'string' } } }
);

// Virtual for subscription duration
packageOrderSchema.virtual('subscriptionDuration').get(function() {
  if (this.subscription.startDate && this.subscription.endDate) {
    const diff = this.subscription.endDate - this.subscription.startDate;
    return Math.ceil(diff / (1000 * 60 * 60 * 24)); // days
  }
  return null;
});

// Method to check if subscription is active
packageOrderSchema.methods.isSubscriptionActive = function() {
  if (!this.subscription.isActive) return false;

  const now = new Date();
  if (this.subscription.endDate && now > this.subscription.endDate) {
    return false;
  }

  return this.payment.status === 'paid' && this.status === 'active';
};

// Method to activate subscription.
//
// Kept for the callers that always used it; the dates now come from the
// membership service so a renewal bought early starts when the current term
// ends, and packs/passes honour their explicit duration.
packageOrderSchema.methods.activateSubscription = async function(options = {}) {
  const service = require('../services/membershipService');
  const now = new Date();
  const start = options.startDate
    ? new Date(options.startDate)
    : await service.startDateFor({
        // By the account alone, as markPaidAndActivate does.
        userId: this.userId,
        kind: (this.packageDetails && this.packageDetails.kind) || 'membership',
        now
      });
  this.subscription.isActive = true;
  this.subscription.startDate = start;
  this.subscription.endDate = options.endDate ? new Date(options.endDate) : service.termEnd(start, this.packageDetails || {});
  this.subscription.renewalDate = this.subscription.endDate;
  this.status = 'active';

  await this.save();
};

const PackageOrder = tenantModel('PackageOrder', packageOrderSchema);

module.exports = PackageOrder;
