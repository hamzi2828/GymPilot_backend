// invoice.paid on a subscription already running, without a database or
// Stripe: an invoice that took no money (the 0 invoice a freeze's billing
// date move makes, or a renewal covered in full) is not a renewal and only
// moves the end date later; a charged one still is; and a payment reported
// on a refunded or called-off order is ignored and said so in the log.
// Model statics and the notifications are stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const PackageOrder = require('../../src/gymfolio/models/packageOrderModel');
const User = require('../../src/models/user');
const notify = require('../../src/services/gymNotifications');
const payments = require('../../src/services/gymfolioPaymentService');

const DAY = 86400;

function stub(target, methods) {
  const saved = {};
  for (const [name, fn] of Object.entries(methods)) {
    saved[name] = target[name];
    target[name] = fn;
  }
  return () => {
    for (const [name, fn] of Object.entries(saved)) target[name] = fn;
  };
}

function inGym(fn) {
  return runWithTenant({ _id: 'unit-invoice-gym', slug: 'invoice-gym', database: { name: 'gympilot_unit_invoice_gym' }, domains: [] }, fn);
}

/**
 * Runs `fn` against one stored order: every lookup finds it, and every write
 * and notice is recorded rather than made. Tenant models are stubbed per
 * gym, so all of it happens inside the gym's context.
 */
async function withOrder(order, fn) {
  const seen = { writes: [], notices: [], warnings: [] };
  await inGym(async () => {
    const restore = [
      stub(PackageOrder, {
        findOne: async () => order,
        findOneAndUpdate: async (filter, update) => {
          seen.writes.push({ op: 'findOneAndUpdate', filter, update });
          return { ...order, subscription: { ...order.subscription, renewals: [{}] } };
        },
        updateOne: async (filter, update) => {
          seen.writes.push({ op: 'updateOne', filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }),
      stub(User, { findById: () => ({ select: () => ({ lean: async () => ({ email: 'sam@invoice.test' }) }) }) }),
      stub(notify, {
        membershipRenewed: async (...args) => {
          seen.notices.push({ name: 'membershipRenewed', args });
        },
        membershipConfirmed: async (...args) => {
          seen.notices.push({ name: 'membershipConfirmed', args });
        }
      }),
      stub(console, { warn: (...args) => seen.warnings.push(args.join(' ')) })
    ];
    try {
      await fn(seen);
    } finally {
      for (const undo of restore.reverse()) undo();
    }
  });
  return seen;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function paidOrder({ endSec, paymentStatus = 'paid', status = 'active' } = {}) {
  return {
    _id: 'order-1',
    orderNumber: 'PKG-INV-1',
    userId: 'user-1',
    payment: { status: paymentStatus, method: 'stripe', currency: 'gbp', stripeSubscriptionId: 'sub_1', stripeInvoiceId: 'in_first' },
    subscription: { endDate: new Date(endSec * 1000), renewals: [] },
    status
  };
}

function invoicePaid(id, { amount, reason, start, end }) {
  return {
    type: 'invoice.paid',
    data: {
      object: {
        id,
        object: 'invoice',
        subscription: 'sub_1',
        customer: 'cus_1',
        billing_reason: reason,
        amount_paid: amount,
        currency: 'gbp',
        lines: { data: [{ period: { start, end } }] }
      }
    }
  };
}

test('an invoice for nothing is not a renewal: no renewal entry, no notice, only the end date follows -- and only later', async () => {
  for (const reason of ['subscription_update', 'subscription_cycle']) {
    const endSec = nowSec() + 20 * DAY;
    const pushed = endSec + 10 * DAY;
    const order = paidOrder({ endSec });
    const seen = await withOrder(order, () =>
      payments.handleWebhook(invoicePaid(`in_zero_${reason}`, { amount: 0, reason, start: nowSec(), end: pushed }))
    );

    assert.equal(seen.writes.length, 1, reason);
    const [write] = seen.writes;
    assert.equal(write.op, 'updateOne', 'no renewal is pushed');
    const periodEnd = new Date(pushed * 1000);
    assert.deepEqual(write.filter, {
      _id: 'order-1',
      'payment.status': 'paid',
      $or: [{ 'subscription.endDate': null }, { 'subscription.endDate': { $lt: periodEnd } }]
    });
    assert.deepEqual(write.update, { $set: { 'subscription.endDate': periodEnd, 'subscription.renewalDate': periodEnd } });
    assert.equal(seen.notices.length, 0, 'the member is not told their membership renewed');
    assert.equal(seen.warnings.length, 0);
  }
});

test('an invoice for nothing without a period changes nothing at all', async () => {
  const order = paidOrder({ endSec: nowSec() + 20 * DAY });
  const event = invoicePaid('in_zero_no_period', { amount: 0, reason: 'subscription_update' });
  event.data.object.lines = { data: [] };
  const seen = await withOrder(order, () => payments.handleWebhook(event));
  assert.equal(seen.writes.length, 0);
  assert.equal(seen.notices.length, 0);
});

test('a charged invoice is still a renewal, whatever its billing reason', async () => {
  for (const reason of ['subscription_cycle', 'subscription_update']) {
    const endSec = nowSec() + 2 * DAY;
    const order = paidOrder({ endSec });
    const seen = await withOrder(order, () =>
      payments.handleWebhook(invoicePaid(`in_paid_${reason}`, { amount: 5000, reason, start: endSec, end: endSec + 30 * DAY }))
    );
    assert.equal(seen.writes.length, 1, reason);
    const [write] = seen.writes;
    assert.equal(write.op, 'findOneAndUpdate');
    assert.equal(write.update.$push['subscription.renewals'].amount, 50);
    assert.equal(write.update.$push['subscription.renewals'].invoiceId, `in_paid_${reason}`);
    assert.ok(write.update.$set['payment.lastPaidAt'] instanceof Date);
    assert.equal(seen.notices.filter((n) => n.name === 'membershipRenewed').length, 1);
  }
});

test('a renewal in a three-decimal currency is recorded as what was charged, not ten times it', async () => {
  const endSec = nowSec() + 2 * DAY;
  const order = paidOrder({ endSec });
  order.payment.currency = 'kwd';
  // 12.500 KWD, as Stripe reports it: 12500 fils.
  const event = invoicePaid('in_paid_kwd', { amount: 12500, reason: 'subscription_cycle', start: endSec, end: endSec + 30 * DAY });
  event.data.object.currency = 'kwd';
  const seen = await withOrder(order, () => payments.handleWebhook(event));
  assert.equal(seen.writes.length, 1);
  assert.equal(seen.writes[0].update.$push['subscription.renewals'].amount, 12.5);
  assert.equal(seen.writes[0].update.$push['subscription.renewals'].currency, 'KWD');
});

test('the first invoice, and one already recorded, change nothing', async () => {
  const endSec = nowSec() + 20 * DAY;
  const order = paidOrder({ endSec });
  const seen = await withOrder(order, async () => {
    await payments.handleWebhook(invoicePaid('in_first', { amount: 0, reason: 'subscription_update', start: nowSec(), end: endSec + DAY }));
    await payments.handleWebhook(invoicePaid('in_create', { amount: 5000, reason: 'subscription_create', start: nowSec(), end: endSec + DAY }));
  });
  assert.equal(seen.writes.length, 0);
  assert.equal(seen.notices.length, 0);
});

test('a payment reported on a refunded or called-off order is ignored, and the log names the order', async () => {
  for (const paymentStatus of ['refunded', 'cancelled']) {
    const endSec = nowSec() + 20 * DAY;
    const order = paidOrder({ endSec, paymentStatus, status: 'cancelled' });
    const seen = await withOrder(order, async () => {
      await payments.handleWebhook(invoicePaid('in_late', { amount: 5000, reason: 'subscription_cycle', start: endSec, end: endSec + 30 * DAY }));
      await payments.handleWebhook({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_late', object: 'payment_intent', metadata: { orderNumber: order.orderNumber } } }
      });
    });
    assert.equal(seen.writes.length, 0, paymentStatus);
    assert.equal(seen.notices.length, 0);
    assert.equal(seen.warnings.length, 2);
    assert.match(seen.warnings[0], /invoice\.paid in_late ignored: order order-1 \(PKG-INV-1\) is /);
    assert.match(seen.warnings[1], /payment_intent\.succeeded pi_late ignored: order order-1 /);
    for (const line of seen.warnings) assert.ok(line.endsWith(paymentStatus), line);
  }
});

test('an order simply already paid, or being activated, is not logged as ignored', async () => {
  for (const paymentStatus of ['paid', 'processing']) {
    const order = paidOrder({ endSec: nowSec() + 20 * DAY, paymentStatus });
    order.updatedAt = new Date();
    let rereads = 0;
    const seen = await withOrder(order, async () => {
      // Being activated by another caller: the event waits a moment for it,
      // finds it done, and is acknowledged.
      const restore = stub(PackageOrder, {
        findById: () => ({
          select: () => ({
            lean: async () => {
              rereads += 1;
              return { payment: { status: 'paid', method: 'stripe' } };
            }
          })
        })
      });
      try {
        await payments.handleWebhook({
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_again', object: 'payment_intent', metadata: { orderNumber: order.orderNumber } } }
        });
      } finally {
        restore();
      }
    });
    assert.equal(seen.warnings.length, 0, paymentStatus);
    assert.equal(seen.writes.length, 0);
    assert.equal(rereads, paymentStatus === 'processing' ? 1 : 0, paymentStatus);
  }
});

/* --------------------------- invoice.payment_failed --------------------------- */

function paymentFailed(invoiceId, created) {
  const event = { type: 'invoice.payment_failed', data: { object: { id: invoiceId, object: 'invoice', subscription: 'sub_1', customer: 'cus_1' } } };
  if (created) event.created = created;
  return event;
}

test('a failed charge puts the order past due only when it is news: not once that invoice, or a later payment, is recorded', async () => {
  const created = nowSec();
  const order = paidOrder({ endSec: nowSec() + 2 * DAY });
  const notices = [];
  const seen = await withOrder(order, async () => {
    const restore = stub(notify, { paymentFailed: async (...args) => notices.push(args) });
    try {
      await payments.handleWebhook(paymentFailed('in_renewal', created));
    } finally {
      restore();
    }
  });

  assert.equal(seen.writes.length, 1);
  const [write] = seen.writes;
  assert.equal(write.op, 'findOneAndUpdate', 'one conditional write, not a save of the copy that was read');
  assert.deepEqual(write.filter, {
    _id: 'order-1',
    'payment.status': 'paid',
    // Not an invoice already recorded as paid...
    'payment.stripeInvoiceId': { $ne: 'in_renewal' },
    'subscription.renewals.invoiceId': { $ne: 'in_renewal' },
    // ...and no payment recorded since Stripe created the event.
    $or: [{ 'payment.lastPaidAt': null }, { 'payment.lastPaidAt': { $lt: new Date(created * 1000) } }]
  });
  assert.deepEqual(write.update, { $set: { status: 'past_due', 'payment.lastPaymentError': 'Your card could not be charged' } });
  assert.equal(notices.length, 1, 'the member is told');
  assert.equal(seen.warnings.length, 0);
  assert.deepEqual(write.filter, payments.pastDueFilter('order-1', 'in_renewal', created));
});

test('a failed charge the order has been paid past is ignored: no status change, no email, and the log says why', async () => {
  const order = paidOrder({ endSec: nowSec() + 30 * DAY });
  const notices = [];
  const seen = { writes: [], warnings: [] };
  await inGym(async () => {
    const restore = [
      stub(PackageOrder, {
        findOne: async () => order,
        // The write finds nothing: the paid event got there first.
        findOneAndUpdate: async (filter, update) => {
          seen.writes.push({ filter, update });
          return null;
        }
      }),
      stub(notify, { paymentFailed: async (...args) => notices.push(args) }),
      stub(console, { warn: (...args) => seen.warnings.push(args.join(' ')) })
    ];
    try {
      await payments.handleWebhook(paymentFailed('in_first', nowSec() - 3600));
    } finally {
      for (const undo of restore.reverse()) undo();
    }
  });
  assert.equal(seen.writes.length, 1);
  assert.equal(notices.length, 0, 'a paid member is not told their card failed');
  assert.equal(seen.warnings.length, 1);
  assert.match(seen.warnings[0], /invoice\.payment_failed in_first ignored: order order-1 \(PKG-INV-1\) has been paid since/);
});

test('without an event time only the invoice is checked, and an order not paid for is left alone', async () => {
  assert.deepEqual(payments.pastDueFilter('o1', 'in_x'), {
    _id: 'o1',
    'payment.status': 'paid',
    'payment.stripeInvoiceId': { $ne: 'in_x' },
    'subscription.renewals.invoiceId': { $ne: 'in_x' }
  });
  for (const paymentStatus of ['refunded', 'pending', 'processing']) {
    const order = paidOrder({ endSec: nowSec() + 2 * DAY, paymentStatus });
    const seen = await withOrder(order, () => payments.handleWebhook(paymentFailed('in_renewal', nowSec())));
    assert.equal(seen.writes.length, 0, paymentStatus);
  }
});
