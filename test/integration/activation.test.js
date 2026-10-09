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

/* ------------------------- a claim nobody finished ------------------------- */

// A card order whose activation was claimed `minutesAgo` and never finished.
function claimedOrder(minutesAgo, extra = {}) {
  const doc = seed({ status: 'pending', ...extra });
  doc.payment.status = 'processing';
  delete doc.payment.paidAt;
  delete doc.refund;
  delete doc.cancellation;
  doc.createdAt = new Date(Date.now() - 60 * 60000);
  doc.updatedAt = new Date(Date.now() - minutesAgo * 60000);
  return doc;
}

test('a claim left by a request that died is taken over after ten minutes, and the paid order activates', async () => {
  await h.inGym(gym, async () => {
    const doc = claimedOrder(11);
    await PackageOrder.collection.insertOne(doc);

    await payments.handleWebhook(intentSucceeded(doc));
    const row = await PackageOrder.findById(doc._id).lean();
    assert.equal(row.payment.status, 'paid');
    assert.equal(row.status, 'active');
    assert.equal(row.subscription.isActive, true);
    assert.ok(row.invoice.number, 'an invoice was issued');
    assert.equal(await confirmationsFor(doc.orderNumber), 1);

    // Redelivered: nothing more.
    await payments.handleWebhook(intentSucceeded(doc));
    assert.equal(await confirmationsFor(doc.orderNumber), 1);
  });
});

test('of two callers taking over the same stale claim, one activates', async () => {
  await h.inGym(gym, async () => {
    const doc = claimedOrder(30);
    await PackageOrder.collection.insertOne(doc);
    const [a, b] = await Promise.all([PackageOrder.findById(doc._id), PackageOrder.findById(doc._id)]);
    const results = await Promise.all([payments.activateOnce(a, async () => ({})), payments.activateOnce(b, async () => ({}))]);
    assert.deepEqual(results.map((r) => r.activated).sort(), [false, true]);
    assert.equal(await confirmationsFor(doc.orderNumber), 1);
  });
});

test('a claim somebody still holds is not taken: the event is refused so Stripe sends it again, and the webhook answers 409', async () => {
  const controller = h.src('gymfolio/controller/gymfolioPaymentController');
  const Settings = h.src('models/settings');
  const doc = claimedOrder(1);
  const event = intentSucceeded(doc);
  h.setStripe({ webhooks: { constructEvent: () => event } });
  const errors = [];
  const logError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await h.inGym(gym, async () => {
      await PackageOrder.collection.insertOne(doc);
      await assert.rejects(payments.handleWebhook(event), (error) => error.code === 'ACTIVATION_IN_PROGRESS' && error.status === 409);
      const row = await PackageOrder.findById(doc._id).lean();
      assert.equal(row.payment.status, 'processing');
      assert.equal(row.status, 'pending');
      assert.equal(await confirmationsFor(doc.orderNumber), 0);

      // Over HTTP that is a 409, not a 500 and not an error in the log.
      await Settings.updateOne({}, { $set: { stripe: { enabled: true, publishableKey: 'pk_test_act', secretKey: 'sk_test_act', webhookSecret: 'whsec_act' } } });
      const res = await h.call(controller.handleWebhook, { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') });
      assert.equal(res.statusCode, 409, JSON.stringify(res.body));
      assert.deepEqual(res.body, { received: false, inProgress: true, message: 'This payment is still being recorded. Send the event again later.' });
      assert.equal(errors.length, 0, errors.join('\n'));

      // The holder finishes while the event waits: acknowledged.
      setTimeout(() => {
        h.inGym(gym, () => PackageOrder.updateOne({ _id: doc._id }, { $set: { 'payment.status': 'paid', status: 'active' } })).catch(() => {});
      }, 100);
      const done = await h.call(controller.handleWebhook, { headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') });
      assert.equal(done.statusCode, 200, JSON.stringify(done.body));
      assert.deepEqual(done.body, { received: true });
    });
  } finally {
    console.error = logError;
    h.setStripe(null);
  }
});

test("a bank transfer waiting for its receipt to be checked is never a stale claim, however long it waits", async () => {
  await h.inGym(gym, async () => {
    const doc = claimedOrder(3 * 24 * 60);
    doc.payment.method = 'bank_transfer';
    delete doc.payment.stripePaymentIntentId;
    delete doc.payment.stripeSessionId;
    await PackageOrder.collection.insertOne(doc);
    const order = await PackageOrder.findById(doc._id);
    let prepared = false;
    const result = await payments.activateOnce(order, async () => {
      prepared = true;
      return {};
    });
    assert.equal(result.activated, false);
    assert.equal(prepared, false);
    assert.equal((await PackageOrder.findById(doc._id).lean()).payment.status, 'processing');
  });
});

test('a completed checkout with no order here is acknowledged and logged, not failed for Stripe to resend for days', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  h.setStripe({
    checkout: { sessions: { retrieve: async (id) => ({ id, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: 'pi_elsewhere' }) } }
  });
  try {
    await h.inGym(gym, async () => {
      const result = await payments.handleWebhook({
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_elsewhere', object: 'checkout.session', client_reference_id: 'PKG-OTHER-1', metadata: { type: 'gymfolio_package_subscription', orderNumber: 'PKG-OTHER-1' } } }
      });
      assert.deepEqual(result, { received: true });
      assert.equal(warnings.length, 1, warnings.join('\n'));
      assert.match(warnings[0], /checkout\.session\.completed cs_elsewhere ignored: no order here for it \(order number PKG-OTHER-1\)/);

      // The success page asking about the same session is told plainly, with a 404.
      await assert.rejects(payments.verifyPackagePayment('cs_elsewhere'), (error) => {
        assert.equal(error.name, 'MembershipError');
        assert.deepEqual([error.status, error.code], [404, 'ORDER_NOT_FOUND']);
        assert.match(error.message, /We could not find an order for this payment\. If you have paid, contact the gym with your receipt\./);
        return true;
      });
    });

    // Stripe being unreachable is still a failure, so the event is sent again.
    h.setStripe({
      checkout: {
        sessions: {
          retrieve: async () => {
            throw new Error('Stripe is down');
          }
        }
      }
    });
    await h.inGym(gym, async () => {
      await assert.rejects(
        payments.handleWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_down', metadata: { type: 'gymfolio_package_subscription' } } } }),
        /Stripe is down/
      );
    });
  } finally {
    console.warn = warn;
    h.setStripe(null);
  }
});
