// Who may activate a card-paid order, against a real MongoDB.
//
// A refunded order is finished: the money went back and the membership was
// ended. A late or redelivered event for the original payment -- the
// webhook, or the member reopening the success page -- must not hand the
// membership back. An order closed because its checkout expired is another
// matter: if the money then does arrive, the member gets what they paid for.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let PackageOrder;
let payments;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  payments = h.src('services/gymfolioPaymentService');
  gym = await h.createGym('activation-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, () => h.ensureIndexes(PackageOrder));
});

let seq = 0;
function seed(extra = {}) {
  seq += 1;
  const { Types } = h.state.mongoose;
  const now = new Date();
  return {
    _id: new Types.ObjectId(),
    orderNumber: `ACT-${seq}`,
    packageId: new Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: '50', currency: 'gbp', period: 'month', kind: 'membership', billing: { mode: 'one_time' } },
    customerInfo: { fullName: 'Ada Activate', email: `ada${seq}@activation.test` },
    payment: { method: 'stripe', amount: 50, currency: 'gbp', status: 'refunded', paidAt: now, stripePaymentIntentId: `pi_act_${seq}`, stripeSessionId: `cs_act_${seq}` },
    subscription: { startDate: now, endDate: now, isActive: false },
    status: 'cancelled',
    refund: { amount: 50, reason: 'changed mind', at: now, byUserId: null, stripeRefundId: `re_act_${seq}` },
    cancellation: { cancelledAt: now, reason: 'Refunded', source: 'staff', immediate: true },
    ...extra
  };
}

const intentSucceeded = (doc) => ({
  type: 'payment_intent.succeeded',
  data: { object: { id: doc.payment.stripePaymentIntentId, object: 'payment_intent', customer: 'cus_ada', metadata: { orderNumber: doc.orderNumber } } }
});

// Confirmations may go out after the call returns; give them a moment.
async function confirmationsFor(orderNumber) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return h.calls.notifications.filter((n) => n.name === 'membershipConfirmed' && n.args[0] && n.args[0].orderNumber === orderNumber).length;
}

test('a refunded order is not re-activated by a late or redelivered payment_intent.succeeded', async () => {
  await h.inGym(gym, async () => {
    const doc = seed();
    await PackageOrder.collection.insertOne(doc);
    await payments.handleWebhook(intentSucceeded(doc));

    const row = await PackageOrder.findById(doc._id).lean();
    assert.equal(row.payment.status, 'refunded');
    assert.equal(row.status, 'cancelled');
    assert.equal(row.subscription.isActive, false);
    assert.equal(row.refund.stripeRefundId, doc.refund.stripeRefundId);
    assert.equal(row.invoice && row.invoice.number, undefined, 'no invoice issued');
    assert.equal(await confirmationsFor(doc.orderNumber), 0);
  });
});

test('a refunded subscription order is not re-activated by a late invoice.paid for its first invoice', async () => {
  await h.inGym(gym, async () => {
    const doc = seed({
      packageDetails: { name: 'Monthly', price: '50', currency: 'gbp', period: 'month', kind: 'membership', billing: { mode: 'recurring', interval: 'month', intervalCount: 1 } }
    });
    doc.payment.stripeSubscriptionId = `sub_act_${seq}`;
    await PackageOrder.collection.insertOne(doc);
    const start = Math.floor(Date.now() / 1000);
    await payments.handleWebhook({
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_act_${seq}`,
          object: 'invoice',
          subscription: doc.payment.stripeSubscriptionId,
          billing_reason: 'subscription_create',
          amount_paid: 5000,
          currency: 'gbp',
          lines: { data: [{ period: { start, end: start + 30 * 86400 } }] }
        }
      }
    });
    const row = await PackageOrder.findById(doc._id).lean();
    assert.equal(row.payment.status, 'refunded');
    assert.equal(row.status, 'cancelled');
    assert.equal((row.subscription.renewals || []).length, 0);
  });
});

test('a refunded order stays refunded when the member reopens the checkout success page', async () => {
  const doc = seed();
  h.setStripe({
    checkout: {
      sessions: {
        retrieve: async (id) => ({ id, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: doc.payment.stripePaymentIntentId, customer: 'cus_ada' })
      }
    }
  });
  try {
    await h.inGym(gym, async () => {
      await PackageOrder.collection.insertOne(doc);
      const result = await payments.verifyPackagePayment(doc.payment.stripeSessionId);
      assert.equal(result.order.payment.status, 'refunded');
      const row = await PackageOrder.findById(doc._id).lean();
      assert.equal(row.payment.status, 'refunded');
      assert.equal(row.status, 'cancelled');
      assert.equal(await confirmationsFor(doc.orderNumber), 0);
    });
  } finally {
    h.setStripe(null);
  }
});

test('the claim itself refuses an order refunded after the caller read it; a called-off payment is refused too', async () => {
  await h.inGym(gym, async () => {
    const doc = seed();
    await PackageOrder.collection.insertOne(doc);
    // The caller's copy still says pending (it was read before the refund).
    const stale = await PackageOrder.findById(doc._id);
    stale.payment.status = 'pending';
    let prepared = false;
    const result = await payments.activateOnce(stale, async () => {
      prepared = true;
      return {};
    });
    assert.equal(result.activated, false);
    assert.equal(prepared, false);
    assert.equal((await PackageOrder.findById(doc._id).lean()).payment.status, 'refunded');

    const calledOff = seed();
    calledOff.payment.status = 'cancelled';
    delete calledOff.refund;
    await PackageOrder.collection.insertOne(calledOff);
    await payments.handleWebhook(intentSucceeded(calledOff));
    const row = await PackageOrder.findById(calledOff._id).lean();
    assert.equal(row.payment.status, 'cancelled');
    assert.equal(row.status, 'cancelled');
  });
});

test('an order closed because its checkout expired is still activated when the money does arrive', async () => {
  await h.inGym(gym, async () => {
    const doc = seed({ status: 'cancelled' });
    doc.payment.status = 'failed';
    doc.payment.lastPaymentError = 'The checkout expired before payment was completed';
    delete doc.payment.paidAt;
    delete doc.refund;
    delete doc.cancellation;
    await PackageOrder.collection.insertOne(doc);

    await payments.handleWebhook(intentSucceeded(doc));
    const row = await PackageOrder.findById(doc._id).lean();
    assert.equal(row.payment.status, 'paid');
    assert.equal(row.status, 'active');
    assert.equal(row.subscription.isActive, true);
    assert.ok(row.subscription.endDate > new Date(), 'a full term from now');
    assert.equal(await confirmationsFor(doc.orderNumber), 1);

    // Redelivered: activated once, not twice.
    await payments.handleWebhook(intentSucceeded(doc));
    assert.equal(await confirmationsFor(doc.orderNumber), 1);
  });
});
