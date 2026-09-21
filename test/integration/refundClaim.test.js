// Refunding a paid order against a real MongoDB, through
// membershipService.refund and its claim (refund.claimedAt): a Stripe
// failure releases the claim and the retry reuses the same idempotency key;
// a full refund has its own key; a fresh claim turns a second refund away
// (409) while a stale one is taken over; a missing payment intent releases
// the claim; and five refunds sent together reach Stripe once.
const assert = require('node:assert/strict');
const h = require('./helpers/harness');
let gym, PackageOrder, svc;
const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  svc = h.src('gymfolio/services/membershipService');
  gym = await h.createGym('claim-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, () => h.ensureIndexes(PackageOrder));
});
function seed(n, extra = {}) {
  const { Types } = h.state.mongoose; const now = new Date();
  return { _id: new Types.ObjectId(), orderNumber: `CL-${n}`, packageId: new Types.ObjectId(),
    packageDetails: { name: 'M', price: '100', currency: 'gbp', period: 'month' },
    customerInfo: { fullName: 'X', email: `x${n}@t.test` },
    payment: { method: 'stripe', amount: 100, currency: 'gbp', status: 'paid', paidAt: now, stripePaymentIntentId: 'pi_x' },
    subscription: { startDate: now, endDate: new Date(now.getTime() + 30 * 864e5), isActive: true },
    status: 'active', refund: { amount: null, reason: '', at: null, byUserId: null, stripeRefundId: null }, ...extra };
}
test('stripe failure releases the claim; retry uses the same idempotency key and succeeds', async () => {
  const calls = []; let fail = true;
  h.setStripe({ refunds: { create: async (params, opts) => { calls.push({ params, opts }); if (fail) { fail = false; throw new Error('stripe down'); } return { id: 're_ok', amount: params.amount, currency: 'gbp' }; } } });
  try {
    await h.inGym(gym, async () => {
      const doc = seed(1); await PackageOrder.collection.insertOne(doc);
      await assert.rejects(svc.refund(await PackageOrder.findById(doc._id), { amount: 40 }), /stripe down/);
      let stored = await PackageOrder.findById(doc._id).lean();
      assert.equal(stored.payment.status, 'paid'); assert.equal(stored.refund.claimedAt, undefined, 'claim released');
      const order = await PackageOrder.findById(doc._id);
      await svc.refund(order, { amount: 40 });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].opts.idempotencyKey, `refund-${doc._id}-4000`);
      assert.equal(calls[1].opts.idempotencyKey, calls[0].opts.idempotencyKey);
      stored = await PackageOrder.findById(doc._id).lean();
      assert.equal(stored.payment.status, 'refunded'); assert.equal(stored.status, 'cancelled');
      assert.equal(stored.subscription.isActive, false);
      assert.equal(stored.refund.amount, 40); assert.equal(stored.refund.stripeRefundId, 're_ok');
      assert.ok(stored.refund.at instanceof Date); assert.equal('claimedAt' in stored.refund, false, JSON.stringify(stored.refund));
      assert.equal(stored.cancellation.immediate, true);
      // in-memory doc the controller answers with
      assert.equal(order.payment.status, 'refunded'); assert.equal(order.refund.stripeRefundId, 're_ok'); assert.equal(order.refund.amount, 40);
      await assert.rejects(svc.refund(await PackageOrder.findById(doc._id)), /already been refunded/);
    });
  } finally { h.setStripe(null); }
});
test('full refund key; fresh claim refused with 409; stale claim taken over', async () => {
  const calls = [];
  h.setStripe({ refunds: { create: async (params, opts) => { calls.push(opts.idempotencyKey); return { id: 're_f', amount: 10000, currency: 'gbp' }; } } });
  try {
    await h.inGym(gym, async () => {
      const fresh = seed(2, {}); fresh.refund.claimedAt = new Date(); await PackageOrder.collection.insertOne(fresh);
      await assert.rejects(svc.refund(await PackageOrder.findById(fresh._id)), (e) => e.status === 409 && /already being refunded/.test(e.message));
      assert.equal(calls.length, 0);
      const stale = seed(3, {}); stale.refund.claimedAt = new Date(Date.now() - 20 * 60000); await PackageOrder.collection.insertOne(stale);
      await svc.refund(await PackageOrder.findById(stale._id));
      assert.deepEqual(calls, [`refund-${stale._id}-full`]);
      const stored = await PackageOrder.findById(stale._id).lean();
      assert.equal(stored.payment.status, 'refunded'); assert.equal(stored.refund.amount, 100);
      const noRefundField = seed(4); delete noRefundField.refund; await PackageOrder.collection.insertOne(noRefundField);
      await svc.refund(await PackageOrder.findById(noRefundField._id), { amount: 5 });
      assert.equal((await PackageOrder.findById(noRefundField._id).lean()).payment.status, 'refunded');
      // a missing payment intent (MembershipError inside the claim) releases it too
      const noPi = seed(5); delete noPi.payment.stripePaymentIntentId; await PackageOrder.collection.insertOne(noPi);
      await assert.rejects(svc.refund(await PackageOrder.findById(noPi._id)), /Could not find the Stripe payment/);
      assert.equal((await PackageOrder.findById(noPi._id).lean()).refund.claimedAt, undefined);
    });
  } finally { h.setStripe(null); }
});
test('five concurrent refunds: one reaches Stripe, the rest are told', async () => {
  const calls = [];
  h.setStripe({ refunds: { create: async (params) => { calls.push(params); await new Promise((r) => setTimeout(r, 30)); return { id: 're_c', amount: params.amount, currency: 'gbp' }; } } });
  try {
    await h.inGym(gym, async () => {
      const doc = seed(6); await PackageOrder.collection.insertOne(doc);
      const copies = await Promise.all([1, 2, 3, 4, 5].map(() => PackageOrder.findById(doc._id)));
      const out = await Promise.allSettled(copies.map((c) => svc.refund(c, { amount: 10 })));
      assert.equal(calls.length, 1);
      assert.equal(out.filter((o) => o.status === 'fulfilled').length, 1);
      for (const o of out.filter((o) => o.status === 'rejected')) assert.match(o.reason.message, /already being refunded|already been refunded/);
    });
  } finally { h.setStripe(null); }
});
