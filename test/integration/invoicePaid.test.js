// invoice.paid on a running card subscription, against a real MongoDB.
//
// An invoice that took no money is not a renewal: the 0 invoice Stripe
// issues when a freeze moves the billing date (trial_end) -- even when its
// webhook lands before the freeze is recorded here -- or a renewal a coupon
// covered in full. Neither adds a renewal, revenue or a "membership renewed"
// notice; the end date follows its period, but never back over time a real
// renewal has paid for. A payment reported on a refunded order is ignored,
// and the log says which order.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400;

let gym;
let PackageOrder;
let User;
let payments;
let member;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  User = h.src('models/user');
  payments = h.src('services/gymfolioPaymentService');
  gym = await h.createGym('invoice-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    member = await User.create({ firstName: 'Ivy', lastName: 'Invoice', email: 'ivy@invoice.test', role: 'member' });
  });
});

const nowSec = () => Math.floor(Date.now() / 1000);
const atSec = (seconds) => new Date(seconds * 1000);

let seq = 0;
/** A paid monthly card subscription whose first invoice is recorded. */
async function subscription({ endSec, paymentStatus = 'paid', status = 'active' }) {
  seq += 1;
  const subId = `sub_inv_${seq}`;
  const endDate = atSec(endSec);
  const paidAt = new Date(Date.now() - 10 * DAY * 1000);
  return PackageOrder.create({
    orderNumber: `INV-${seq}`,
    userId: member._id,
    packageId: new h.state.mongoose.Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: '50', currency: 'gbp', period: 'month', billing: { mode: 'recurring', interval: 'month', intervalCount: 1 } },
    customerInfo: { fullName: 'Ivy Invoice', email: 'ivy@invoice.test' },
    payment: {
      method: 'stripe',
      amount: 50,
      currency: 'gbp',
      status: paymentStatus,
      paidAt,
      lastPaidAt: paidAt,
      stripeSubscriptionId: subId,
      stripeCustomerId: 'cus_ivy',
      stripeInvoiceId: `in_${subId}_first`
    },
    subscription: { startDate: atSec(endSec - 30 * DAY), endDate, renewalDate: endDate, isActive: status === 'active', autoRenew: true, stripeStatus: 'active' },
    status
  });
}

function invoicePaid(id, order, { amount, reason, start, end }) {
  return {
    type: 'invoice.paid',
    data: {
      object: {
        id,
        object: 'invoice',
        subscription: order.payment.stripeSubscriptionId,
        customer: 'cus_ivy',
        billing_reason: reason,
        amount_paid: amount,
        currency: 'gbp',
        lines: { data: [{ period: { start, end } }] }
      }
    }
  };
}

const stored = (order) => PackageOrder.findById(order._id).lean();
const renewedNotices = (order) =>
  h.calls.notifications.filter((n) => n.name === 'membershipRenewed' && n.args[0] && n.args[0].orderNumber === order.orderNumber).length;

test('the 0 invoice for a moved billing date is not a renewal, even when it lands before the freeze is recorded', async () => {
  await h.inGym(gym, async () => {
    const endSec = nowSec() + 20 * DAY;
    const order = await subscription({ endSec });
    const pushed = endSec + 10 * DAY;

    const event = invoicePaid('in_freeze_zero', order, { amount: 0, reason: 'subscription_update', start: nowSec(), end: pushed });
    await payments.handleWebhook(event);
    await payments.handleWebhook(event); // redelivered

    const row = await stored(order);
    assert.equal(row.subscription.renewals.length, 0, 'no renewal, so no revenue');
    assert.equal(renewedNotices(order), 0, 'the member is not told their membership renewed');
    assert.equal(row.payment.lastPaidAt.getTime(), order.payment.lastPaidAt.getTime(), 'no payment was taken');
    assert.equal(row.payment.paidAt.getTime(), order.payment.paidAt.getTime());
    assert.equal(row.subscription.endDate.getTime(), pushed * 1000, 'the end date is when Stripe next charges');
    assert.equal(row.subscription.renewalDate.getTime(), pushed * 1000);
    assert.equal(row.status, 'active');
  });
});

test('a 0 invoice delivered after a real renewal does not take the renewed time back', async () => {
  await h.inGym(gym, async () => {
    const endSec = nowSec() + 2 * DAY;
    const order = await subscription({ endSec });
    const renewedTo = endSec + 30 * DAY;

    await payments.handleWebhook(invoicePaid('in_cycle', order, { amount: 5000, reason: 'subscription_cycle', start: endSec, end: renewedTo }));
    let row = await stored(order);
    assert.equal(row.subscription.renewals.length, 1);
    assert.equal(row.subscription.renewals[0].amount, 50);
    assert.equal(row.subscription.endDate.getTime(), renewedTo * 1000);
    assert.equal(renewedNotices(order), 1);

    // The 0 invoice of an earlier billing date move, arriving late.
    await payments.handleWebhook(invoicePaid('in_stale_zero', order, { amount: 0, reason: 'subscription_update', start: nowSec() - DAY, end: endSec + 5 * DAY }));
    row = await stored(order);
    assert.equal(row.subscription.endDate.getTime(), renewedTo * 1000);
    assert.equal(row.subscription.renewalDate.getTime(), renewedTo * 1000);
    assert.equal(row.subscription.renewals.length, 1);
    assert.equal(row.payment.stripeInvoiceId, 'in_cycle', 'the last real charge stays the one on record');
    assert.equal(renewedNotices(order), 1);
  });
});

test('a renewal a coupon covered in full keeps the member on to the new period end, but is not counted as a payment', async () => {
  await h.inGym(gym, async () => {
    const endSec = nowSec() + DAY;
    const order = await subscription({ endSec });
    const next = endSec + 30 * DAY;

    await payments.handleWebhook(invoicePaid('in_free_cycle', order, { amount: 0, reason: 'subscription_cycle', start: endSec, end: next }));
    const row = await stored(order);
    assert.equal(row.subscription.endDate.getTime(), next * 1000);
    assert.equal(row.subscription.renewals.length, 0);
    assert.equal(row.payment.lastPaidAt.getTime(), order.payment.lastPaidAt.getTime());
    assert.equal(renewedNotices(order), 0);
  });
});

test('a payment reported on a refunded order is ignored, and the log names the order', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await h.inGym(gym, async () => {
      const endSec = nowSec() + 20 * DAY;
      const order = await subscription({ endSec, paymentStatus: 'refunded', status: 'cancelled' });

      await payments.handleWebhook(invoicePaid('in_after_refund', order, { amount: 5000, reason: 'subscription_cycle', start: endSec, end: endSec + 30 * DAY }));
      await payments.handleWebhook({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_after_refund', object: 'payment_intent', metadata: { orderNumber: order.orderNumber } } }
      });

      const row = await stored(order);
      assert.equal(row.payment.status, 'refunded');
      assert.equal(row.status, 'cancelled');
      assert.equal(row.subscription.isActive, false);
      assert.equal(row.subscription.renewals.length, 0);
      assert.equal(row.subscription.endDate.getTime(), endSec * 1000);
      assert.equal(renewedNotices(order), 0);

      const mine = warnings.filter((line) => line.includes(String(order._id)));
      assert.equal(mine.length, 2, warnings.join('\n'));
      assert.match(mine[0], /invoice\.paid in_after_refund ignored: order .+ is refunded$/);
      assert.match(mine[1], /payment_intent\.succeeded pi_after_refund ignored: order .+ is refunded$/);
    });
  } finally {
    console.warn = warn;
  }
});

/* --------------------------- invoice.payment_failed --------------------------- */

function paymentFailed(invoiceId, order, created) {
  return {
    type: 'invoice.payment_failed',
    created,
    data: { object: { id: invoiceId, object: 'invoice', subscription: order.payment.stripeSubscriptionId, customer: 'cus_ivy' } }
  };
}

const failedNotices = (order) =>
  h.calls.notifications.filter((n) => n.name === 'paymentFailed' && n.args[0] && n.args[0].orderNumber === order.orderNumber).length;

// Notices go out after the handler returns; give them a moment.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a failed attempt redelivered after the payment that settled it leaves the member paid up, not past due', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await h.inGym(gym, async () => {
      const endSec = nowSec() + DAY;
      const order = await subscription({ endSec });
      const failedAt = nowSec() - 120;

      // The renewal fails, then goes through on Stripe's retry.
      await payments.handleWebhook(paymentFailed('in_retry', order, failedAt));
      await settle();
      assert.equal((await stored(order)).status, 'past_due');
      assert.equal(failedNotices(order), 1);

      await payments.handleWebhook(invoicePaid('in_retry', order, { amount: 5000, reason: 'subscription_cycle', start: endSec, end: endSec + 30 * DAY }));
      assert.equal((await stored(order)).status, 'active');

      // Stripe delivers the failed attempt again, after the paid one.
      await payments.handleWebhook(paymentFailed('in_retry', order, failedAt));
      await settle();
      const row = await stored(order);
      assert.equal(row.status, 'active', 'a paid member is not put past due by old news');
      assert.equal(row.payment.lastPaymentError, '');
      assert.equal(failedNotices(order), 1, 'and is not told their card failed a second time');
      assert.ok(warnings.some((line) => /invoice\.payment_failed in_retry ignored: order .+ has been paid since$/.test(line)), warnings.join('\n'));

      // The failure of an earlier invoice, arriving late, is old news too:
      // a payment has been recorded since it happened.
      await payments.handleWebhook(paymentFailed('in_older_never_paid', order, failedAt - 3600));
      assert.equal((await stored(order)).status, 'active');

      // The next renewal failing is news.
      await payments.handleWebhook(paymentFailed('in_next_month', order, nowSec() + 30 * DAY));
      await settle();
      const later = await stored(order);
      assert.equal(later.status, 'past_due');
      assert.equal(later.payment.lastPaymentError, 'Your card could not be charged');
      assert.equal(failedNotices(order), 2);
    });
  } finally {
    console.warn = warn;
  }
});
