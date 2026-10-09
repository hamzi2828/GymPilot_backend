// Deleting a gym: its card subscription with the platform is cancelled
// before anything is removed, a subscription Stripe will not cancel stops the
// deletion, and a Stripe event about a deleted gym never lands on the gym
// that took its slug next. No database and no Stripe: the model statics, the
// backup store and the billing calls are stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const provisioning = require('../../src/platform/provisioning');
const platformBilling = require('../../src/platform/services/platformBilling');
const backupJobs = require('../../src/services/backupJobs');
const { handlePlatformStripeEvent } = require('../../src/platform/services/platformWebhook');

const { deleteGym, ProvisioningError } = provisioning;

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

function query(value) {
  const q = { select: () => q, lean: () => q, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return q;
}

function gymOnStripe(subscription = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: 'Iron Works',
    slug: 'iron-works',
    database: { name: 'gympilot_unit_tests_iron_works_abc123' },
    subscription: { status: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', ...subscription }
  };
}

/** Everything deleteGym touches, stubbed; `order` is what happened, in order. */
function deletionWorld({ cancel = async () => ({ status: 'canceled', amountPaid: 8000, currency: 'PKR' }) } = {}) {
  const order = [];
  const restore = [
    stub(platformBilling, {
      cancelSubscriptionNow: async (id) => {
        order.push(`cancel ${id}`);
        return cancel(id);
      },
      closeCheckoutSession: async (id) => {
        order.push(`close ${id}`);
        return 'expired';
      }
    }),
    stub(Gym, {
      deleteOne: async () => {
        order.push('record deleted');
        return { deletedCount: 1 };
      }
    }),
    stub(backupJobs, {
      removeGymBackups: async () => {
        order.push('backups removed');
        return { removed: 0, left: 0 };
      }
    })
  ];
  return { order, restore: () => restore.reverse().forEach((fn) => fn()) };
}

test('deleting a gym cancels its card subscription before the gym goes', async () => {
  const world = deletionWorld();
  try {
    const result = await deleteGym(gymOnStripe(), { confirmSlug: 'iron-works' });
    assert.deepEqual(world.order, ['cancel sub_1', 'record deleted', 'backups removed']);
    assert.equal(result.deleted, true);
    assert.deepEqual(result.billing, { subscriptionId: 'sub_1', cancelled: true, amountPaid: 8000, currency: 'PKR' });
  } finally {
    world.restore();
  }
});

test('a gym whose subscription Stripe will not cancel is not deleted, and the admin is told what to do', async () => {
  const world = deletionWorld({
    cancel: async () => {
      throw new Error('No such subscription: sub_1');
    }
  });
  try {
    await assert.rejects(deleteGym(gymOnStripe(), { confirmSlug: 'iron-works', dropDatabase: false }), (error) => {
      assert.ok(error instanceof ProvisioningError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { code: 'SUBSCRIPTION_NOT_CANCELLED', subscriptionId: 'sub_1' });
      assert.match(error.message, /NOT deleted/);
      assert.match(error.message, /Cancel sub_1 in the Stripe dashboard/);
      return true;
    });
    assert.deepEqual(world.order, ['cancel sub_1'], 'nothing was removed');

    // Cancelled by hand since: the deletion goes on, and says Stripe never confirmed it.
    world.order.length = 0;
    const result = await deleteGym(gymOnStripe(), { confirmSlug: 'iron-works', subscriptionCancelledByHand: true });
    assert.deepEqual(world.order, ['cancel sub_1', 'record deleted', 'backups removed']);
    assert.deepEqual(result.billing, { subscriptionId: 'sub_1', cancelled: false, byHand: true, error: 'No such subscription: sub_1' });
  } finally {
    world.restore();
  }
});

test('nothing is cancelled until the deletion is confirmed, and a gym billed by hand has nothing to cancel', async () => {
  const world = deletionWorld();
  try {
    await assert.rejects(deleteGym(gymOnStripe(), { confirmSlug: 'iron-work' }), /Type the gym's slug/);
    assert.deepEqual(world.order, []);

    const byHand = await deleteGym(gymOnStripe({ stripeSubscriptionId: '', stripeCustomerId: '' }), { confirmSlug: 'iron-works' });
    assert.equal(byHand.billing, null);
    assert.deepEqual(world.order, ['record deleted', 'backups removed']);
  } finally {
    world.restore();
  }
});

test('a payment page left open is closed, so nobody can pay for a gym that is gone', async () => {
  const world = deletionWorld();
  try {
    await deleteGym(gymOnStripe({ stripeSubscriptionId: '', checkoutSessionId: 'cs_open' }), { confirmSlug: 'iron-works' });
    assert.deepEqual(world.order, ['close cs_open', 'record deleted', 'backups removed']);
  } finally {
    world.restore();
  }
});

test('a half-made gym removed to be made again keeps the payment it is made from', async () => {
  const world = deletionWorld();
  try {
    const result = await deleteGym(gymOnStripe({ checkoutSessionId: 'cs_open' }), { confirmSlug: 'iron-works', keepSubscription: true });
    assert.deepEqual(world.order, ['record deleted', 'backups removed']);
    assert.equal(result.billing, null);
  } finally {
    world.restore();
  }
});

test('cancelling a subscription that is already over counts as cancelled; one Stripe cannot find does not', async () => {
  const refused = Object.assign(new Error('This subscription is already canceled'), { code: 'resource_missing' });
  const over = {
    subscriptions: {
      cancel: async () => {
        throw refused;
      },
      retrieve: async (id) => ({ id, status: 'canceled', currency: 'pkr', latest_invoice: null })
    }
  };
  assert.deepEqual(await platformBilling.cancelSubscriptionNow('sub_1', over), { status: 'canceled', amountPaid: 0, currency: 'PKR' });

  const unknown = {
    subscriptions: {
      cancel: async () => {
        throw refused;
      },
      retrieve: async () => {
        throw refused;
      }
    }
  };
  await assert.rejects(platformBilling.cancelSubscriptionNow('sub_1', unknown), /already canceled/);
});

test("a Stripe event about a deleted gym never lands on the gym that took its slug", async () => {
  const deletedId = new mongoose.Types.ObjectId();
  // A new gym on the old slug, with no subscription of its own yet.
  const successor = { _id: new mongoose.Types.ObjectId(), slug: 'iron-works', subscription: { status: 'trialing', stripeSubscriptionId: '', stripeCustomerId: '' } };
  const writes = [];
  const restore = stub(Gym, {
    findById: () => query(null),
    findOne: (filter) => query(filter && filter.slug ? successor : null),
    updateOne: async (filter, update) => {
      writes.push({ filter, update });
      return { matchedCount: 1 };
    }
  });
  try {
    const metadata = { gymId: String(deletedId), gymSlug: 'iron-works' };
    const events = [
      { type: 'invoice.paid', data: { object: { subscription: 'sub_old', customer: 'cus_old', amount_paid: 800000, subscription_details: { metadata } } } },
      { type: 'invoice.payment_failed', data: { object: { subscription: 'sub_old', subscription_details: { metadata } } } },
      { type: 'customer.subscription.updated', data: { object: { id: 'sub_old', status: 'active', customer: 'cus_old', metadata, items: { data: [] } } } },
      { type: 'customer.subscription.deleted', data: { object: { id: 'sub_old', metadata } } },
      { type: 'checkout.session.completed', data: { object: { id: 'cs_old', mode: 'subscription', client_reference_id: String(deletedId), subscription: 'sub_old', metadata } } }
    ];
    for (const event of events) {
      const outcome = await handlePlatformStripeEvent({ id: 'evt_1', created: 1790000000, ...event }, {});
      assert.deepEqual(outcome, { gym: null, result: 'no gym matched' }, event.type);
    }
    assert.equal(writes.length, 0);
    // A slug alone names no gym either.
    const slugOnly = await handlePlatformStripeEvent(
      { id: 'evt_2', created: 1790000000, type: 'customer.subscription.updated', data: { object: { id: 'sub_old', status: 'active', metadata: { gymSlug: 'iron-works' }, items: { data: [] } } } },
      {}
    );
    assert.equal(slugOnly.gym, null);
  } finally {
    restore();
  }
});
