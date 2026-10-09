// Deleting a gym: its card subscription with the platform is cancelled
// before anything is removed, a subscription Stripe will not cancel stops the
// deletion, and a Stripe event about a deleted gym never lands on the gym
// that took its slug next. Members who still pay the gym by card stop it
// too, until the admin says they know. Its sign-in names go with it, its
// stored files with its database, by its own prefix only. And no gym can be
// created in a database another gym uses. No database, no Stripe and no file
// store: the model statics, the stores and the billing calls are stood in for.
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
const MemberDirectory = require('../../src/platform/models/memberDirectoryModel');
const tenantStats = require('../../src/platform/tenantStats');
const gymFiles = require('../../src/platform/services/gymFiles');
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
function deletionWorld({ cancel = async () => ({ status: 'canceled', amountPaid: 8000, currency: 'PKR' }), cardSubscriptions = 0 } = {}) {
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
      findByIdWithUri: async () => null,
      deleteOne: async () => {
        order.push('record deleted');
        return { deletedCount: 1 };
      }
    }),
    stub(tenantStats, { countCardSubscriptions: async () => cardSubscriptions }),
    stub(backupJobs, {
      removeGymBackups: async () => {
        order.push('backups removed');
        return { removed: 0, left: 0 };
      }
    }),
    stub(MemberDirectory, {
      deleteMany: async (filter) => {
        order.push('sign-in names removed');
        assert.deepEqual(Object.keys(filter), ['gymId']);
        return { deletedCount: 3 };
      }
    }),
    stub(gymFiles, {
      removeGymFiles: async (slug) => {
        order.push(`files of ${slug} removed`);
        return { removed: 5 };
      }
    })
  ];
  return { order, restore: () => restore.reverse().forEach((fn) => fn()) };
}

// What goes once the gym's record has: every deletion ends with these.
const AFTERWARDS = ['record deleted', 'backups removed', 'sign-in names removed'];

test('deleting a gym cancels its card subscription before the gym goes', async () => {
  const world = deletionWorld();
  try {
    const result = await deleteGym(gymOnStripe(), { confirmSlug: 'iron-works' });
    assert.deepEqual(world.order, ['cancel sub_1', ...AFTERWARDS]);
    assert.equal(result.deleted, true);
    assert.deepEqual(result.billing, { subscriptionId: 'sub_1', cancelled: true, amountPaid: 8000, currency: 'PKR' });
  } finally {
    world.restore();
  }
});

test("its usernames in the phone app's sign-in directory go with it; its files stay with a database that is kept", async () => {
  const world = deletionWorld();
  try {
    const result = await deleteGym(gymOnStripe({ stripeSubscriptionId: '' }), { confirmSlug: 'iron-works' });
    assert.deepEqual(world.order, AFTERWARDS, 'no files removed: the kept data still points at them');
    assert.equal(result.memberLoginsRemoved, 3);
    assert.equal(result.filesRemoved, 0);
    assert.equal(result.databaseDropped, false);
  } finally {
    world.restore();
  }
});

test('a gym whose members still pay it by card is not deleted until the admin says they know', async () => {
  const world = deletionWorld({ cardSubscriptions: 4 });
  try {
    await assert.rejects(deleteGym(gymOnStripe(), { confirmSlug: 'iron-works' }), (error) => {
      assert.ok(error instanceof ProvisioningError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { code: 'MEMBER_SUBSCRIPTIONS_ACTIVE', count: 4 });
      assert.match(error.message, /^4 members pay this gym by card/);
      assert.match(error.message, /does not stop those charges/);
      return true;
    });
    assert.deepEqual(world.order, [], 'nothing cancelled, nothing removed');

    const result = await deleteGym(gymOnStripe(), { confirmSlug: 'iron-works', memberSubscriptionsAcknowledged: true });
    assert.equal(result.deleted, true);
    assert.deepEqual(world.order, ['cancel sub_1', ...AFTERWARDS]);
  } finally {
    world.restore();
  }
});

test('a deleted gym\'s files are removed by its own prefix, page by page, and never a shared folder', async () => {
  const listed = [];
  const removed = [];
  const pages = {
    undefined: { blobs: [{ url: 'https://s/iron-works/members/a.pdf' }, { url: 'https://s/iron-works/payment-proofs/b.png' }], hasMore: true, cursor: 'next' },
    next: { blobs: [{ url: 'https://s/iron-works/backups/c' }], hasMore: false }
  };
  const restore = stub(gymFiles.store, {
    configured: () => true,
    list: async (options) => {
      listed.push(options);
      return pages[String(options.cursor)];
    },
    remove: async (urls) => {
      removed.push(...urls);
    }
  });
  try {
    assert.deepEqual(await gymFiles.removeGymFiles('iron-works'), { removed: 3 });
    // The trailing slash: `iron/` must never match `iron-works/`.
    assert.deepEqual(listed.map((o) => o.prefix), ['iron-works/', 'iron-works/']);
    assert.equal(listed[1].cursor, 'next');
    assert.equal(removed.length, 3);

    // A slug that is also a folder other files live in is never removed by prefix...
    listed.length = 0;
    assert.match((await gymFiles.removeGymFiles('members')).skipped, /shared folder/);
    assert.equal((await gymFiles.removeGymFiles('')).skipped, 'no slug');
    assert.equal(listed.length, 0);
    // ...and no new gym can be given one.
    for (const folder of gymFiles.SHARED_FOLDERS) assert.equal(provisioning.isReservedSlug(folder), true, folder);

    // The store giving up part-way is reported, not thrown.
    gymFiles.store.remove = async () => {
      throw new Error('store unavailable');
    };
    assert.deepEqual(await gymFiles.removeGymFiles('iron-works'), { removed: 0, left: true, error: 'store unavailable' });

    gymFiles.store.configured = () => false;
    assert.match((await gymFiles.removeGymFiles('iron-works')).skipped, /no file store/);
  } finally {
    restore();
  }
});

test('a gym cannot be created in a database another gym already uses', async () => {
  const filters = [];
  const restore = stub(Gym, {
    find: () => query([]),
    findOne: (filter) => {
      filters.push(filter);
      return query(filter['database.name'] ? { slug: 'iron-works', name: 'Iron Works' } : null);
    },
    create: async () => {
      throw new Error('must not be reached');
    }
  });
  try {
    await assert.rejects(
      provisioning.provisionGym({ name: 'Second Gym', owner: { email: 'o@second.test', password: 'a strong password' }, database: { name: 'gympilot_unit_tests_iron_works_abc123' } }),
      (error) => error instanceof ProvisioningError && error.status === 409 && /already belongs to Iron Works \(iron-works\)/.test(error.message)
    );
    const asked = filters.find((f) => f['database.name']);
    // On the shared cluster: the same name there, whatever the field holds for "no URI".
    assert.deepEqual(asked, { 'database.name': 'gympilot_unit_tests_iron_works_abc123', 'database.uri': { $in: ['', null] } });
  } finally {
    restore();
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
    assert.deepEqual(world.order, ['cancel sub_1', ...AFTERWARDS]);
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
    assert.deepEqual(world.order, AFTERWARDS);
  } finally {
    world.restore();
  }
});

test('a payment page left open is closed, so nobody can pay for a gym that is gone', async () => {
  const world = deletionWorld();
  try {
    await deleteGym(gymOnStripe({ stripeSubscriptionId: '', checkoutSessionId: 'cs_open' }), { confirmSlug: 'iron-works' });
    assert.deepEqual(world.order, ['close cs_open', ...AFTERWARDS]);
  } finally {
    world.restore();
  }
});

test('a half-made gym removed to be made again keeps the payment it is made from', async () => {
  const world = deletionWorld();
  try {
    const result = await deleteGym(gymOnStripe({ checkoutSessionId: 'cs_open' }), { confirmSlug: 'iron-works', keepSubscription: true });
    assert.deepEqual(world.order, AFTERWARDS);
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
