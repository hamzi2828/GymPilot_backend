// Freezing a membership against a real MongoDB, with a stand-in for the
// gym's Stripe that keeps a subscription's billing dates the way Stripe does.
//
// On a card subscription a freeze moves the next CHARGE by the frozen days
// (trial_end, no proration) instead of pausing collection, so: a freeze
// inside one period keeps its days when the next invoice.paid lands; one
// spanning a renewal moves that renewal rather than voiding it; resuming
// early brings the charge back by the unused days; and a retry never pushes
// twice. Cash and bank memberships keep the plain end-date rule.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400;
const DAY_MS = DAY * 1000;

let gym;
let PackageOrder;
let User;
let svc;
let payments;
let expiry;
let controller;
let member;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  User = h.src('models/user');
  svc = h.src('gymfolio/services/membershipService');
  payments = h.src('services/gymfolioPaymentService');
  expiry = h.src('gymfolio/services/membershipExpiry');
  controller = h.src('gymfolio/controller/membershipController');
  gym = await h.createGym('freeze-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    member = await User.create({ firstName: 'Fran', lastName: 'Freeze', email: 'fran@freeze.test', role: 'member' });
  });
});

const nowSec = () => Math.floor(Date.now() / 1000);
const atSec = (seconds) => new Date(seconds * 1000);
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A gym's Stripe holding one subscription. It moves billing dates the way
 * Stripe documents: a future trial_end makes the subscription 'trialing'
 * with that as its period end and issues a 0 invoice; trial_end 'now' ends
 * the trial and bills a full period straight away.
 */
function fakeStripe({ id, status = 'active', periodEnd, extra = {} }) {
  const calls = [];
  const invoices = new Map();
  let seq = 0;
  const invoice = (fields) => {
    const inv = { id: `in_${id}_${++seq}`, object: 'invoice', status: 'paid', currency: 'gbp', ...fields };
    invoices.set(inv.id, inv);
    return inv;
  };
  const first = invoice({ total: 5000, amount_paid: 5000, payment_intent: `pi_${id}_first` });
  const sub = {
    id,
    object: 'subscription',
    status,
    current_period_start: periodEnd - 30 * DAY,
    current_period_end: periodEnd,
    trial_end: null,
    pause_collection: null,
    cancel_at_period_end: false,
    metadata: { tenantSlug: 'freeze-gym', orderNumber: 'set-by-checkout' },
    latest_invoice: first.id,
    ...extra
  };
  const view = (expand) => {
    const copy = clone(sub);
    if (expand && expand.includes('latest_invoice')) copy.latest_invoice = clone(invoices.get(sub.latest_invoice));
    return copy;
  };
  return {
    calls,
    sub,
    invoiceStore: invoices,
    updates: () => calls.filter((c) => c.op === 'update'),
    subscriptions: {
      retrieve: async (subId, options = {}) => {
        calls.push({ op: 'retrieve', id: subId });
        return view(options.expand);
      },
      update: async (subId, params) => {
        calls.push({ op: 'update', id: subId, params: clone(params) });
        const now = nowSec();
        if (params.trial_end === 'now') {
          sub.status = 'active';
          sub.trial_end = now;
          sub.current_period_start = now;
          sub.current_period_end = now + 30 * DAY;
          sub.latest_invoice = invoice({ total: 5000, amount_paid: 5000, payment_intent: `pi_${id}_${seq + 1}` }).id;
        } else if (params.trial_end !== undefined) {
          if (!(params.trial_end > now)) throw new Error('Invalid timestamp: trial_end must be in the future');
          sub.status = 'trialing';
          sub.trial_end = params.trial_end;
          sub.current_period_start = now;
          sub.current_period_end = params.trial_end;
          sub.latest_invoice = invoice({ total: 0, amount_paid: 0, payment_intent: null, period: { start: now, end: params.trial_end } }).id;
        }
        if (params.pause_collection !== undefined) sub.pause_collection = params.pause_collection || null;
        if (params.metadata) Object.assign(sub.metadata, params.metadata);
        return view(params.expand);
      },
      cancel: async (subId) => {
        calls.push({ op: 'cancel', id: subId });
        sub.status = 'canceled';
        return view();
      }
    },
    invoices: {
      retrieve: async (invoiceId) => {
        calls.push({ op: 'invoices.retrieve', id: invoiceId });
        return clone(invoices.get(invoiceId) || null);
      },
      list: async (params) => {
        calls.push({ op: 'invoices.list', params });
        const rows = [...invoices.values()].filter((i) => !params.status || i.status === params.status).reverse();
        return { data: clone(rows.slice(0, params.limit || 10)) };
      }
    },
    refunds: {
      create: async (params, options) => {
        calls.push({ op: 'refund', params, options });
        return { id: `re_${id}`, amount: params.amount || 5000, currency: 'gbp' };
      }
    }
  };
}

let orderSeq = 0;
/** A paid monthly membership; `subId` makes it a Stripe subscription. */
async function membership({ endDate, subId = null, status = 'active', extra = {} }) {
  orderSeq += 1;
  const payment = { method: subId ? 'stripe' : 'cash', amount: 50, currency: 'gbp', status: 'paid', paidAt: new Date() };
  const subscription = { startDate: new Date(endDate.getTime() - 30 * DAY_MS), endDate, renewalDate: endDate, isActive: true };
  if (subId) {
    Object.assign(payment, { stripeSubscriptionId: subId, stripeCustomerId: 'cus_fran', stripeInvoiceId: `in_${subId}_1` });
    Object.assign(subscription, { autoRenew: true, stripeStatus: 'active' });
  }
  return PackageOrder.create({
    orderNumber: `FZ-${orderSeq}`,
    userId: member._id,
    packageId: new h.state.mongoose.Types.ObjectId(),
    packageDetails: {
      name: 'Monthly',
      price: '50',
      currency: 'gbp',
      period: 'month',
      billing: { mode: subId ? 'recurring' : 'one_time', interval: 'month', intervalCount: 1 }
    },
    customerInfo: { fullName: 'Fran Freeze', email: 'fran@freeze.test' },
    payment,
    subscription,
    status,
    ...extra
  });
}

function invoicePaid(id, { subId, amount, start, end, reason }) {
  return {
    type: 'invoice.paid',
    data: {
      object: {
        id,
        object: 'invoice',
        subscription: subId,
        customer: 'cus_fran',
        billing_reason: reason,
        amount_paid: amount,
        currency: 'gbp',
        lines: { data: [{ period: { start, end } }] }
      }
    }
  };
}

const reload = (order) => PackageOrder.findById(order._id);
const stored = (order) => PackageOrder.findById(order._id).lean();

async function withStripe(fake, fn) {
  h.setStripe(fake);
  try {
    return await h.inGym(gym, fn);
  } finally {
    h.setStripe(null);
  }
}

test('frozen inside one billing period: the next charge moves by the frozen days, and invoice.paid agrees', async () => {
  const periodEnd = nowSec() + 20 * DAY;
  const fake = fakeStripe({ id: 'sub_inside', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_inside' });
    await svc.freeze(await reload(order), { days: 10, reason: 'holiday', by: member._id, source: 'member' });

    const pushed = periodEnd + 10 * DAY;
    const updates = fake.updates();
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].params, {
      trial_end: pushed,
      proration_behavior: 'none',
      metadata: { gympilot_freeze: `0:10:${pushed}` },
      expand: ['latest_invoice']
    });
    assert.ok(!('pause_collection' in updates[0].params), 'collection is never paused -- that voided renewals');

    let row = await stored(order);
    assert.equal(row.status, 'frozen');
    assert.equal(row.freeze.billing, 'stripe_trial');
    assert.equal(row.freeze.totalFrozenDays, 10);
    assert.equal(row.subscription.endDate.getTime(), pushed * 1000, 'end date = the day Stripe next charges');
    assert.equal(row.subscription.renewalDate.getTime(), pushed * 1000);
    assert.equal(row.subscription.stripeStatus, 'trialing');
    // The 0 invoice Stripe issued for the free days is already known here.
    const zero = fake.sub.latest_invoice;
    assert.equal(fake.invoiceStore.get(zero).total, 0);
    assert.equal(row.payment.stripeInvoiceId, zero);

    // Its invoice.paid is not a renewal of nothing, and changes no date.
    const before = h.calls.notifications.length;
    await payments.handleWebhook(invoicePaid(zero, { subId: 'sub_inside', amount: 0, start: nowSec(), end: pushed, reason: 'subscription_update' }));
    row = await stored(order);
    assert.equal(row.subscription.renewals.length, 0);
    assert.equal(row.subscription.endDate.getTime(), pushed * 1000);
    assert.equal(row.status, 'frozen');
    assert.equal(h.calls.notifications.slice(before).filter((n) => n.name === 'membershipRenewed').length, 0);

    // The next real charge starts exactly where the end date is: the frozen
    // days are kept, not overwritten by Stripe's old period end.
    await payments.handleWebhook(invoicePaid('in_renewal', { subId: 'sub_inside', amount: 5000, start: pushed, end: pushed + 30 * DAY, reason: 'subscription_cycle' }));
    row = await stored(order);
    assert.equal(row.subscription.renewals.length, 1);
    assert.equal(row.subscription.renewals[0].amount, 50);
    assert.equal(row.subscription.endDate.getTime(), (pushed + 30 * DAY) * 1000);
  });
});

test('frozen across a renewal: the renewal is moved, not voided, and the member stays live until the pushed charge', async () => {
  const periodEnd = nowSec() + 3 * DAY;
  const fake = fakeStripe({ id: 'sub_span', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_span' });
    await svc.freeze(await reload(order), { days: 10, source: 'member', by: member._id });

    const pushed = periodEnd + 10 * DAY;
    assert.equal(fake.sub.current_period_end, pushed, 'Stripe charges next when the freeze has been made up');
    assert.equal(fake.sub.pause_collection, null);
    assert.equal((await stored(order)).subscription.endDate.getTime(), pushed * 1000);

    // The freeze runs its course; the daily job switches it back on without
    // touching Stripe, which already charges on the end date.
    await PackageOrder.updateOne({ _id: order._id }, { $set: { 'freeze.resumeAt': new Date(Date.now() - 60000) } });
    const callsBefore = fake.calls.length;
    assert.equal((await svc.resumeDueFreezes()).resumed, 1);
    assert.equal(fake.calls.length, callsBefore, 'resuming on schedule does not reach Stripe');

    const row = await stored(order);
    assert.equal(row.status, 'active');
    assert.equal(row.subscription.isActive, true);
    assert.equal(row.subscription.endDate.getTime(), pushed * 1000);
    assert.equal(row.freeze.totalFrozenDays, 10);

    // Past the ORIGINAL renewal date the member is not swept as expired.
    await expiry.expireLapsedOrders(new Date((periodEnd + 5 * DAY) * 1000));
    assert.equal((await stored(order)).status, 'active');
  });
});

test('resuming early takes the unused days off the end date and off Stripe\'s next charge alike; a retry does not take them twice', async () => {
  const periodEnd = nowSec() + 20 * DAY;
  const fake = fakeStripe({ id: 'sub_early', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_early' });
    await svc.freeze(await reload(order), { days: 10, source: 'member', by: member._id });
    const pushed = periodEnd + 10 * DAY;

    // Three and a half days in: 6.5 days left, 7 whole days handed back.
    await PackageOrder.updateOne(
      { _id: order._id },
      { $set: { 'freeze.frozenAt': new Date(Date.now() - 3.5 * DAY_MS), 'freeze.resumeAt': new Date(Date.now() + 6.5 * DAY_MS) } }
    );
    const frozen = await PackageOrder.collection.findOne({ _id: order._id });

    await svc.unfreeze(await reload(order), { by: member._id, source: 'member' });
    const expected = pushed - 7 * DAY;
    const last = fake.updates().pop();
    assert.deepEqual(last.params, { trial_end: expected, proration_behavior: 'none', expand: ['latest_invoice'] });
    assert.equal(fake.sub.current_period_end, expected);

    let row = await stored(order);
    assert.equal(row.status, 'active');
    assert.equal(row.subscription.endDate.getTime(), expected * 1000, 'the end date and the next charge agree');
    assert.equal(row.freeze.totalFrozenDays, 3);
    assert.equal(row.freeze.history[row.freeze.history.length - 1].days, 3);

    // The resume reached Stripe but its record here was lost: trying again
    // lands on the same date rather than pulling it back another 7 days.
    await PackageOrder.collection.replaceOne({ _id: order._id }, frozen);
    await svc.unfreeze(await reload(order), { by: member._id, source: 'member' });
    assert.equal(fake.updates().pop().params.trial_end, expected);
    row = await stored(order);
    assert.equal(row.subscription.endDate.getTime(), expected * 1000);
  });
});

test('resuming once the paid time has run out ends the trial now: Stripe bills the next period and the member stays live', async () => {
  const periodEnd = nowSec() + 120; // renewal due in two minutes
  const fake = fakeStripe({ id: 'sub_now', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_now' });
    await svc.freeze(await reload(order), { days: 3, source: 'staff' });
    await svc.unfreeze(await reload(order), { source: 'staff' });

    assert.deepEqual(fake.updates().pop().params, { trial_end: 'now', proration_behavior: 'none' });
    let row = await stored(order);
    assert.equal(row.status, 'active');
    assert.equal(row.subscription.isActive, true);
    assert.ok(Math.abs(row.subscription.endDate.getTime() - Date.now()) < 60000, 'paid up to now');
    assert.equal(row.subscription.stripeStatus, 'active');

    // Stripe's charge for the new period moves the end date on as usual.
    const charged = fake.sub.latest_invoice;
    await payments.handleWebhook(
      invoicePaid(charged, { subId: 'sub_now', amount: 5000, start: fake.sub.current_period_start, end: fake.sub.current_period_end, reason: 'subscription_update' })
    );
    row = await stored(order);
    assert.equal(row.subscription.endDate.getTime(), fake.sub.current_period_end * 1000);
    assert.equal(row.subscription.renewals.length, 1);
  });
});

test('a freeze retried after its Stripe half went through does not push the charge twice', async () => {
  const periodEnd = nowSec() + 20 * DAY;
  const fake = fakeStripe({ id: 'sub_retry', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_retry' });
    const untouched = await PackageOrder.collection.findOne({ _id: order._id });
    await svc.freeze(await reload(order), { days: 10, source: 'member', by: member._id });
    const pushed = periodEnd + 10 * DAY;

    // The record here is lost; Stripe already says trialing to `pushed`.
    await PackageOrder.collection.replaceOne({ _id: order._id }, untouched);
    await svc.freeze(await reload(order), { days: 10, source: 'member', by: member._id });

    assert.equal(fake.updates().length, 2);
    assert.equal(fake.updates()[1].params.trial_end, pushed, 'the same date again, not 20 days on');
    assert.equal(fake.sub.current_period_end, pushed);
    assert.equal((await stored(order)).subscription.endDate.getTime(), pushed * 1000);
  });
});

test('billing Stripe cannot move is refused with a clear reason, and nothing changes', async () => {
  const cases = [
    { id: 'sub_pastdue', status: 'past_due', code: 'FREEZE_PAYMENT_OUTSTANDING', message: /card payment outstanding/ },
    { id: 'sub_paused', extra: { pause_collection: { behavior: 'void' } }, code: 'FREEZE_STRIPE_PAUSED', message: /paused in Stripe/ },
    { id: 'sub_flexible', extra: { billing_mode: { type: 'flexible' } }, code: 'FREEZE_STRIPE_UNSUPPORTED', message: /flexible billing mode/ }
  ];
  for (const c of cases) {
    const periodEnd = nowSec() + 20 * DAY;
    const fake = fakeStripe({ id: c.id, status: c.status, periodEnd, extra: c.extra });
    await withStripe(fake, async () => {
      const order = await membership({ endDate: atSec(periodEnd), subId: c.id, status: c.status === 'past_due' ? 'past_due' : 'active' });
      await assert.rejects(svc.freeze(await reload(order), { days: 5, source: 'member', by: member._id }), (error) => {
        assert.equal(error.status, 409, c.id);
        assert.equal(error.code, c.code);
        assert.match(error.message, c.message);
        return true;
      });
      assert.equal(fake.updates().length, 0, `${c.id}: Stripe untouched`);
      const row = await stored(order);
      assert.notEqual(row.status, 'frozen');
      assert.equal(row.subscription.endDate.getTime(), periodEnd * 1000);
    });
  }
});

test('a subscription Stripe has already ended is frozen as a date here only', async () => {
  const periodEnd = nowSec() + 20 * DAY;
  const fake = fakeStripe({ id: 'sub_ended', status: 'canceled', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_ended' });
    await PackageOrder.updateOne(
      { _id: order._id },
      { $set: { 'subscription.cancelAtPeriodEnd': true, 'subscription.autoRenew': false, 'subscription.stripeStatus': 'canceled' } }
    );
    await svc.freeze(await reload(order), { days: 5, source: 'member', by: member._id });
    let row = await stored(order);
    assert.equal(row.freeze.billing, 'local');
    assert.equal(row.subscription.endDate.getTime(), (periodEnd + 5 * DAY) * 1000);

    await svc.unfreeze(await reload(order), { source: 'member' });
    assert.equal(fake.updates().length, 0, 'nothing to move at Stripe, either way');
    row = await stored(order);
    assert.equal(row.subscription.endDate.getTime(), periodEnd * 1000);
    assert.equal(row.status, 'active');
  });
});

test('cash memberships keep the plain rule, and Stripe is never contacted', async () => {
  h.setStripe(null); // reaching Stripe would throw
  await h.inGym(gym, async () => {
    const end = new Date(Date.now() + 20 * DAY_MS);
    const order = await membership({ endDate: end });
    await svc.freeze(await reload(order), { days: 10, source: 'member', by: member._id });
    let row = await stored(order);
    assert.equal(row.status, 'frozen');
    assert.equal(row.freeze.billing, 'local');
    assert.equal(row.subscription.endDate.getTime(), end.getTime() + 10 * DAY_MS);

    await svc.unfreeze(await reload(order), { source: 'member' });
    row = await stored(order);
    assert.equal(row.status, 'active');
    assert.equal(row.subscription.endDate.getTime(), end.getTime(), 'all ten days handed back');
    assert.equal(row.freeze.totalFrozenDays, 0);
  });
});

test('a freeze from before this change (collection paused at Stripe) is undone the old way', async () => {
  const periodEnd = nowSec() + 20 * DAY;
  const fake = fakeStripe({ id: 'sub_legacy', periodEnd, extra: { pause_collection: { behavior: 'void' } } });
  await withStripe(fake, async () => {
    const order = await membership({
      endDate: atSec(periodEnd),
      subId: 'sub_legacy',
      status: 'frozen',
      extra: { freeze: { isFrozen: true, frozenAt: new Date(), resumeAt: new Date(Date.now() - 60000), totalFrozenDays: 5, history: [{ days: 5 }] } }
    });
    await PackageOrder.updateOne({ _id: order._id }, { $unset: { 'freeze.billing': 1 } });
    await svc.unfreeze(await reload(order), { source: 'system' });
    assert.deepEqual(fake.updates().map((u) => u.params), [{ pause_collection: '' }]);
    assert.equal(fake.sub.pause_collection, null);
    assert.equal((await stored(order)).status, 'active');
  });
});

test('refunding a frozen card membership finds the real payment behind the freeze\'s 0 invoice', async () => {
  const periodEnd = nowSec() + 20 * DAY;
  const fake = fakeStripe({ id: 'sub_refund', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_refund' });
    await svc.freeze(await reload(order), { days: 10, source: 'member', by: member._id });
    await svc.refund(await reload(order), { reason: 'moving away' });

    const refund = fake.calls.find((c) => c.op === 'refund');
    assert.equal(refund.params.payment_intent, 'pi_sub_refund_first');
    assert.ok(fake.calls.some((c) => c.op === 'cancel'), 'the subscription is stopped');
    const row = await stored(order);
    assert.equal(row.payment.status, 'refunded');
    assert.equal(row.status, 'cancelled');
  });
});

test('a member freezing their own card membership is told when the next payment will be taken', async () => {
  const periodEnd = nowSec() + 20 * DAY;
  const fake = fakeStripe({ id: 'sub_http', periodEnd });
  await withStripe(fake, async () => {
    const order = await membership({ endDate: atSec(periodEnd), subId: 'sub_http' });
    const before = h.calls.notifications.length;
    const res = await h.call(controller.freeze, {
      params: { id: String(order._id) },
      body: { days: 7, reason: 'away' },
      user: { id: String(member._id) }
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const next = atSec(periodEnd + 7 * DAY).toDateString();
    assert.match(res.body.message, new RegExp(`next card payment moves to ${next}`));
    assert.equal(res.body.data.freeze.history[0].source, 'member');

    // The member hears about it once the response has gone.
    for (let i = 0; i < 50 && !h.calls.notifications.slice(before).some((n) => n.name === 'membershipFrozen'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sent = h.calls.notifications.slice(before).find((n) => n.name === 'membershipFrozen');
    assert.ok(sent, 'membershipFrozen sent');
    assert.equal(sent.args[1].email, 'fran@freeze.test');
  });
});
