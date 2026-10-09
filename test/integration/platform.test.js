// The platform against a real MongoDB.
//
// Webhook idempotency: the platform Stripe webhook (platformSettingsController
// .webhook) with real signatures, so the claim in platform_stripe_events is
// exercised end to end -- a redelivery is a duplicate, two deliveries at once
// apply once, a claim abandoned for longer than STALE_CLAIM_MS is taken over,
// a fresh or finished one is not.
//
// Dunning: a gym whose card keeps failing goes past due, is cut off after the
// grace period however far Stripe has moved its period on, stays cut off
// through Stripe's further retries, comes back when paid, and its owner is
// told once when Stripe cancels.
//
// Deletion: deleteGym() cancelling the gym's card, dropping its database,
// removing its sign-in names and files -- and refusing while members still
// pay it by card, or when the database is another gym's too.
//
// Hand billing: a payment recorded from the panel (gymsController
// .recordPayment) reactivating a lapsed gym exactly once however often Save
// is clicked, and the daily roll-over treating it as paid until its date.
//
// Provisioning: provisionGym() creating a tenant database and seeding it, and
// rolling back on a failure part-way through seeding -- dropping a database it
// created, never one that was already there. Email and Vercel are stand-ins.

const assert = require('node:assert/strict');
const Stripe = require('stripe');
const h = require('./helpers/harness');

const WEBHOOK_SECRET = 'whsec_integration_secret';
const signer = new Stripe('sk_test_integration_signer').webhooks;

let Gym;
let PlatformSettings;
let PlatformStripeEvent;
let platformSettings;
let provisioning;
let contentPages;
let Settings;
let Role;
let User;
let billedGym;

const test = h.suite(async () => {
  Gym = h.src('platform/models/gymModel');
  PlatformSettings = h.src('platform/models/platformSettingsModel');
  PlatformStripeEvent = h.src('platform/models/platformStripeEventModel');
  platformSettings = h.src('platform/controllers/platformSettingsController');
  provisioning = h.src('platform/provisioning');
  contentPages = h.src('seeds/contentPageDefaults');
  Settings = h.src('models/settings');
  Role = h.src('models/roleModel');
  User = h.src('models/user');

  await PlatformStripeEvent.init();
  const settings = await PlatformSettings.getSettings();
  settings.stripe.secretKey = 'sk_test_integration_platform';
  settings.stripe.webhookSecret = WEBHOOK_SECRET;
  await settings.save();

  billedGym = await h.createGym('billed-gym', { currency: 'GBP' });
  await Gym.updateOne({ _id: billedGym._id }, { $set: { 'subscription.status': 'trialing', 'subscription.stripeSubscriptionId': 'sub_integration' } });
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

function subscriptionEvent(id, status, { createdAgoSeconds = 0 } = {}) {
  return {
    id,
    object: 'event',
    type: 'customer.subscription.updated',
    created: nowSeconds() - createdAgoSeconds,
    livemode: false,
    data: {
      object: {
        id: 'sub_integration',
        object: 'subscription',
        status,
        customer: 'cus_integration',
        metadata: { gymId: String(billedGym._id) },
        items: {
          data: [{ current_period_end: nowSeconds() + 30 * 86400, quantity: 1, price: { currency: 'gbp', unit_amount: 4900, recurring: { interval: 'month' } } }]
        }
      }
    }
  };
}

function deliver(event, { secret = WEBHOOK_SECRET } = {}) {
  const payload = JSON.stringify(event);
  const header = signer.generateTestHeaderString({ payload, secret });
  return h.call(platformSettings.webhook, { body: Buffer.from(payload), headers: { 'stripe-signature': header } });
}

async function gymStatus() {
  return (await Gym.findById(billedGym._id).lean()).subscription.status;
}

// A claim written earlier, with its own createdAt: straight into the collection.
function seedClaim(eventId, { createdAgoMs, handledAt = null }) {
  const createdAt = new Date(Date.now() - createdAgoMs);
  return PlatformStripeEvent.collection.insertOne({ eventId, type: 'customer.subscription.updated', livemode: false, gymId: null, gymSlug: '', result: '', handledAt, createdAt, updatedAt: createdAt });
}

test('a signature that does not verify is refused before anything is claimed', async () => {
  const res = await deliver(subscriptionEvent('evt_forged', 'active'), { secret: 'whsec_wrong' });
  assert.equal(res.statusCode, 400);
  assert.equal(await PlatformStripeEvent.countDocuments({ eventId: 'evt_forged' }), 0);
});

test('one event delivered twice at the same moment is applied once', async () => {
  const event = subscriptionEvent('evt_twice', 'active', { createdAgoSeconds: 300 });
  const results = await Promise.all([deliver(event), deliver(event)]);
  // The loser is either a plain duplicate (the winner had finished) or told
  // to come back later (still in progress) -- never applied a second time.
  for (const res of results) {
    assert.ok(res.statusCode === 200 || (res.statusCode === 409 && res.body.inProgress), JSON.stringify(res.body));
  }
  const applied = results.filter((res) => !res.body.duplicate);
  assert.equal(applied.length, 1, JSON.stringify(results.map((r) => r.body)));
  assert.equal(applied[0].body.result, 'synced: active');

  const gym = await Gym.findById(billedGym._id).lean();
  assert.equal(gym.subscription.status, 'active');
  assert.equal(gym.subscription.amount, 49);
  assert.equal(gym.subscription.currency, 'GBP');

  const claims = await PlatformStripeEvent.find({ eventId: 'evt_twice' }).lean();
  assert.equal(claims.length, 1);
  assert.ok(claims[0].handledAt instanceof Date);
  assert.equal(claims[0].result, 'synced: active');

  // And again later: still a duplicate.
  const again = await deliver(event);
  assert.equal(again.body.duplicate, true);
});

test('a claim abandoned past STALE_CLAIM_MS is taken over by the redelivery', async () => {
  await seedClaim('evt_abandoned', { createdAgoMs: platformSettings.STALE_CLAIM_MS + 60000 });
  const res = await deliver(subscriptionEvent('evt_abandoned', 'past_due', { createdAgoSeconds: 200 }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.duplicate, undefined, JSON.stringify(res.body));
  assert.equal(res.body.result, 'synced: past_due');
  assert.equal(await gymStatus(), 'past_due');
  const claims = await PlatformStripeEvent.find({ eventId: 'evt_abandoned' }).lean();
  assert.equal(claims.length, 1);
  assert.ok(claims[0].handledAt instanceof Date);
});

test('a claim still in progress, or already handled, is not taken over', async () => {
  await seedClaim('evt_in_progress', { createdAgoMs: 60000 });
  await seedClaim('evt_long_done', { createdAgoMs: 3 * 3600000, handledAt: new Date(Date.now() - 2 * 3600000) });

  const inProgress = await deliver(subscriptionEvent('evt_in_progress', 'cancelled', { createdAgoSeconds: 100 }));
  assert.equal(inProgress.body.duplicate, true);
  // Still in progress: not acknowledged, so Stripe retries rather than
  // dropping the event if that first delivery never finishes.
  assert.equal(inProgress.statusCode, 409);
  assert.equal(inProgress.body.inProgress, true);
  const done = await deliver(subscriptionEvent('evt_long_done', 'cancelled', { createdAgoSeconds: 90 }));
  assert.equal(done.body.duplicate, true);
  assert.equal(done.statusCode, 200);
  assert.equal(await gymStatus(), 'past_due', 'neither was applied');
});

test('two redeliveries racing for one abandoned claim apply it once', async () => {
  await seedClaim('evt_contested', { createdAgoMs: platformSettings.STALE_CLAIM_MS * 3 });
  const event = subscriptionEvent('evt_contested', 'active', { createdAgoSeconds: 30 });
  const results = await Promise.all([deliver(event), deliver(event)]);
  const applied = results.filter((res) => !res.body.duplicate);
  assert.equal(applied.length, 1, JSON.stringify(results.map((r) => r.body)));
  assert.equal(await PlatformStripeEvent.countDocuments({ eventId: 'evt_contested' }), 1);
  assert.equal(await gymStatus(), 'active');
});

test('a released claim can be claimed again; a handled one cannot be released', async () => {
  const event = { id: 'evt_release', type: 'invoice.paid' };
  assert.equal(await PlatformStripeEvent.claim(event), true);
  assert.equal(await PlatformStripeEvent.claim(event), false);
  await PlatformStripeEvent.release(event);
  assert.equal(await PlatformStripeEvent.claim(event), true);
  await PlatformStripeEvent.markHandled(event, { result: 'done' });
  await PlatformStripeEvent.release(event);
  assert.equal(await PlatformStripeEvent.claim(event), false, 'a finished event stays claimed');
});

/* ------------------------ a card that keeps failing ------------------------ */

function billingEvent(id, type, object, createdAt) {
  return { id, object: 'event', type, created: createdAt, livemode: false, data: { object } };
}

test('a gym whose card keeps failing is cut off after the grace period, though Stripe keeps moving its period on', async () => {
  const jobs = h.src('platform/jobs');
  const DAY = 86400;
  const t = nowSeconds();
  const gym = await h.createGym('dunning-gym', { currency: 'GBP' });
  await Gym.updateOne(
    { _id: gym._id },
    {
      $set: {
        'owner.email': 'owner@dunning.test',
        'owner.firstName': 'Dana',
        'subscription.status': 'active',
        'subscription.stripeSubscriptionId': 'sub_dunning',
        'subscription.stripeCustomerId': 'cus_dunning',
        'subscription.currentPeriodEnd': new Date((t + 2 * DAY) * 1000)
      }
    }
  );
  const invoice = (amountPaid = 0) => ({ id: 'in_dunning', object: 'invoice', subscription: 'sub_dunning', customer: 'cus_dunning', amount_paid: amountPaid, metadata: {}, lines: { data: [{ period: { end: t + 60 * DAY } }] } });
  const subscription = (status, periodEnd) => ({
    id: 'sub_dunning',
    object: 'subscription',
    status,
    customer: 'cus_dunning',
    metadata: { gymId: String(gym._id) },
    items: { data: [{ current_period_end: periodEnd, quantity: 1, price: { currency: 'gbp', unit_amount: 4900, recurring: { interval: 'month' } } }] }
  });
  const read = async () => (await Gym.findById(gym._id).lean()).subscription;

  // The renewal fails: past due, and the clock starts when Stripe said so.
  await deliver(billingEvent('evt_dun_1', 'invoice.payment_failed', invoice(), t - 300));
  let sub = await read();
  assert.equal(sub.status, 'past_due');
  assert.equal(sub.pastDueSince.getTime(), (t - 300) * 1000);

  // Stripe moves the period on anyway, and retries: the clock keeps running.
  await deliver(billingEvent('evt_dun_2', 'customer.subscription.updated', subscription('past_due', t + 32 * DAY), t - 200));
  sub = await read();
  assert.equal(sub.currentPeriodEnd.getTime(), (t + 32 * DAY) * 1000);
  assert.equal(sub.pastDueSince.getTime(), (t - 300) * 1000);

  // Eight days on, the period end still ahead: expired all the same.
  const rolled = await jobs.rollSubscriptionStatuses({ now: new Date((t + 8 * DAY) * 1000) });
  assert.ok(rolled.expired >= 1);
  assert.equal((await read()).status, 'expired');

  // Stripe's next retries fail too: still expired, not back to "past due" and served.
  const retried = await deliver(billingEvent('evt_dun_3', 'invoice.payment_failed', invoice(), t - 100));
  assert.equal(retried.body.result, 'already expired');
  await deliver(billingEvent('evt_dun_4', 'customer.subscription.updated', subscription('past_due', t + 32 * DAY), t - 50));
  assert.equal((await read()).status, 'expired');

  // Paid at last: active, and the clock stops.
  await deliver(billingEvent('evt_dun_5', 'invoice.paid', invoice(4900), t));
  sub = await read();
  assert.equal(sub.status, 'active');
  assert.equal(sub.pastDueSince, null);

  // Then cancelled in Stripe: the owner is told once, with the way back.
  await deliver(billingEvent('evt_dun_6', 'customer.subscription.deleted', subscription('canceled', t + 60 * DAY), t + 10));
  assert.equal((await read()).status, 'cancelled');
  const toOwner = () => h.calls.emails.filter((mail) => mail.to === 'owner@dunning.test' && /has been cancelled/.test(mail.subject));
  const first = await jobs.sendOwnerBillingNotices();
  assert.ok(first.sent.some((entry) => entry.slug === 'dunning-gym' && entry.notice === 'cancelled'), JSON.stringify(first));
  assert.equal(toOwner().length, 1);
  assert.match(toOwner()[0].html, /Sign in to renew/);
  await jobs.sendOwnerBillingNotices();
  assert.equal(toOwner().length, 1, 'once');
});

const owner = (email) => ({ firstName: 'Olga', lastName: 'Owner', email, password: 'correct-horse-battery' });

test('provisionGym creates the gym, its own database, and seeds it', async () => {
  const before = await h.databaseNames();
  const result = await provisioning.provisionGym({
    name: 'Iron Works Integration',
    owner: owner('olga@ironworks.test'),
    domains: ['ironworks.localhost:3000'],
    locale: { timezone: 'Europe/London', currency: 'GBP', country: 'GB' }
  });

  const gym = await Gym.findById(result.gym._id).lean();
  assert.equal(gym.slug, 'iron-works-integration');
  assert.ok(gym.provisionedAt instanceof Date);
  assert.ok(gym.database.name.startsWith(h.TENANT_PREFIX));
  assert.ok(!before.includes(gym.database.name));
  assert.ok((await h.databaseNames()).includes(gym.database.name), 'the database now exists');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.ownerInvite.sent, true);
  assert.ok(h.calls.emails.some((mail) => mail.to === 'olga@ironworks.test'), 'the owner was emailed (stub)');

  await h.inGym({ ...gym, database: { name: gym.database.name } }, async () => {
    const settings = await Settings.findOne({ isActive: true }).lean();
    assert.equal(settings.siteName, 'Iron Works Integration');
    assert.equal(settings.currency, 'GBP');
    assert.equal(settings.country, 'GB');
    assert.ok(await Role.exists({ slug: 'admin' }));
    const ownerUser = await User.findOne({ email: 'olga@ironworks.test' }).select('+passwordResetTokenHash').lean();
    assert.equal(ownerUser.role, 'admin');
    assert.ok(ownerUser.passwordResetTokenHash, 'a set-password token is waiting');
  });

  // The same name again gets the next free address, not an error.
  const second = await provisioning.provisionGym({ name: 'Iron Works Integration', owner: owner('olga2@ironworks.test') });
  assert.equal(second.gym.slug, 'iron-works-integration-2');
  assert.notEqual(second.gym.database.name, gym.database.name);
});

async function withFailingSeed(fn) {
  const original = contentPages.ensureSeeded;
  contentPages.ensureSeeded = async () => {
    throw new Error('seeded failure');
  };
  try {
    return await fn();
  } finally {
    contentPages.ensureSeeded = original;
  }
}

test('a failure part-way through seeding removes the gym and drops the database it created', async () => {
  const database = `${h.TENANT_PREFIX}doomed_db`;
  await withFailingSeed(async () => {
    await assert.rejects(
      provisioning.provisionGym({ name: 'Doomed Gym', owner: owner('d@doomed.test'), database: { name: database } }),
      (error) => error instanceof provisioning.ProvisioningError && error.status === 500 && /seeded failure/.test(error.message)
    );
  });
  assert.equal(await Gym.findOne({ slug: 'doomed-gym' }).lean(), null);
  assert.ok(!(await h.databaseNames()).includes(database), 'the half-seeded database was dropped');
});

test('a failure never drops a database that was already there', async () => {
  const database = `${h.TENANT_PREFIX}somebodys_data`;
  await h.rawDb(database).collection('keep_me').insertOne({ note: 'existing data' });
  await withFailingSeed(async () => {
    await assert.rejects(provisioning.provisionGym({ name: 'Careful Gym', owner: owner('c@careful.test'), database: { name: database } }), /seeded failure/);
  });
  assert.equal(await Gym.findOne({ slug: 'careful-gym' }).lean(), null);
  assert.ok((await h.databaseNames()).includes(database));
  assert.equal(await h.rawDb(database).collection('keep_me').countDocuments(), 1);
});

test('deleting a gym stops its card, and takes its database, its sign-in names and its files with it', async () => {
  const MemberDirectory = h.src('platform/models/memberDirectoryModel');
  const PackageOrder = h.src('gymfolio/models/packageOrderModel');
  const platformBilling = h.src('platform/services/platformBilling');
  const gymFiles = h.src('platform/services/gymFiles');

  const leaving = await h.createGym('leaving-gym');
  const staying = await h.createGym('staying-gym');
  await Gym.updateOne({ _id: leaving._id }, { $set: { 'subscription.stripeSubscriptionId': 'sub_leaving', 'subscription.stripeCustomerId': 'cus_leaving' } });
  const member = () => new h.state.mongoose.Types.ObjectId();
  await MemberDirectory.create([
    { username: 'leaving.one', gymId: leaving._id, gymSlug: leaving.slug, userId: member() },
    { username: 'leaving.two', gymId: leaving._id, gymSlug: leaving.slug, userId: member() },
    { username: 'staying.one', gymId: staying._id, gymSlug: staying.slug, userId: member() }
  ]);
  // Two members on card subscriptions in the gym's own Stripe account; one
  // already set to end, one cancelled -- neither of those charges again.
  await h.inGym(leaving, () =>
    PackageOrder.collection.insertMany([
      { orderNumber: 'T-1', status: 'active', payment: { stripeSubscriptionId: 'sub_member_1' }, subscription: {} },
      { orderNumber: 'T-2', status: 'past_due', payment: { stripeSubscriptionId: 'sub_member_2' }, subscription: {} },
      { orderNumber: 'T-3', status: 'active', payment: { stripeSubscriptionId: 'sub_member_3' }, subscription: { cancelAtPeriodEnd: true } },
      { orderNumber: 'T-4', status: 'cancelled', payment: { stripeSubscriptionId: 'sub_member_4' }, subscription: {} },
      { orderNumber: 'T-5', status: 'active', payment: { stripeSubscriptionId: null }, subscription: {} }
    ])
  );

  const cancelled = [];
  const prefixes = [];
  const real = { cancel: platformBilling.cancelSubscriptionNow, store: { ...gymFiles.store } };
  platformBilling.cancelSubscriptionNow = async (id) => {
    cancelled.push(id);
    return { status: 'canceled', amountPaid: 0, currency: 'GBP' };
  };
  Object.assign(gymFiles.store, {
    configured: () => true,
    list: async ({ prefix }) => {
      prefixes.push(prefix);
      return { blobs: [{ url: `https://store.test/${prefix}members/id-scan.pdf` }], hasMore: false };
    },
    remove: async () => {}
  });
  try {
    const doc = () => Gym.findById(leaving._id);

    // The members' own subscriptions come first: nothing is touched until the admin says they know.
    await assert.rejects(provisioning.deleteGym(await doc(), { confirmSlug: 'leaving-gym', dropDatabase: true }), (error) => error.status === 409 && error.details.code === 'MEMBER_SUBSCRIPTIONS_ACTIVE' && error.details.count === 2);
    assert.deepEqual(cancelled, []);
    assert.ok((await h.databaseNames()).includes(leaving.database.name));

    const result = await provisioning.deleteGym(await doc(), { confirmSlug: 'leaving-gym', dropDatabase: true, memberSubscriptionsAcknowledged: true });
    assert.equal(result.deleted, true);
    assert.deepEqual(cancelled, ['sub_leaving']);
    assert.equal(result.billing.cancelled, true);
    assert.equal(await Gym.countDocuments({ _id: leaving._id }), 0);
    assert.ok(!(await h.databaseNames()).includes(leaving.database.name), 'its database is gone');
    assert.equal(result.memberLoginsRemoved, 2);
    assert.equal(await MemberDirectory.countDocuments({ gymId: leaving._id }), 0);
    assert.equal(await MemberDirectory.isTaken('leaving.one'), false, 'the username is free again');
    assert.equal(await MemberDirectory.countDocuments({ gymId: staying._id }), 1, "another gym's sign-in names stay");
    assert.deepEqual(prefixes, ['leaving-gym/']);
    assert.equal(result.filesRemoved, 1);

    // A database another gym is using is never created in, and never dropped.
    await assert.rejects(
      provisioning.provisionGym({ name: 'Squatter Gym', owner: owner('s@squatter.test'), database: { name: staying.database.name } }),
      (error) => error.status === 409 && /already belongs to/.test(error.message)
    );
    assert.equal(await Gym.countDocuments({ slug: 'squatter-gym' }), 0);
    // Two records on one database, as could be made before that check existed.
    const twin = await Gym.create({ name: 'Twin Gym', slug: 'twin-gym', database: { name: staying.database.name }, subscription: { status: 'active' } });
    await assert.rejects(provisioning.deleteGym(twin, { confirmSlug: 'twin-gym', dropDatabase: true }), (error) => error.status === 409 && /also the database of/.test(error.message));
    assert.ok((await h.databaseNames()).includes(staying.database.name));
    const kept = await provisioning.deleteGym(twin, { confirmSlug: 'twin-gym' });
    assert.equal(kept.databaseDropped, false);
    assert.equal(kept.filesRemoved, 0, 'files stay with a database that is kept');
    assert.deepEqual(prefixes, ['leaving-gym/']);
  } finally {
    platformBilling.cancelSubscriptionNow = real.cancel;
    Object.assign(gymFiles.store, real.store);
  }
});

test('a payment recorded by hand brings a lapsed gym back, once, and the daily roll-over then leaves it alone until it is due again', async () => {
  const PlatformPayment = h.src('platform/models/platformPaymentModel');
  const PlatformAuditLog = h.src('platform/models/platformAuditLogModel');
  const gymsController = h.src('platform/controllers/gymsController');
  const jobs = h.src('platform/jobs');
  await PlatformPayment.init();

  const DAY = 86400000;
  const now = Date.now();
  const gym = await h.createGym('bank-transfer-gym', { currency: 'PKR' });
  // Billed by hand, its trial long over: cut off for not paying.
  await Gym.updateOne(
    { _id: gym._id },
    { $set: { 'subscription.status': 'expired', 'subscription.billingCycle': 'monthly', 'subscription.amount': 8000, 'subscription.currentPeriodEnd': new Date(now - 20 * DAY), 'subscription.pastDueSince': new Date(now - 20 * DAY), 'subscription.notices.expired': new Date(now - 13 * DAY) } }
  );
  const superAdmin = { _id: new h.state.mongoose.Types.ObjectId(), email: 'admin@gympilot.test' };
  const post = (body) => h.call(gymsController.recordPayment, { params: { id: String(gym._id) }, body, superAdmin });
  const read = async () => (await Gym.findById(gym._id).lean()).subscription;

  // What the form starts from: the bill, and one cycle on from today.
  const before = await h.call(gymsController.listPayments, { params: { id: String(gym._id) }, superAdmin });
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.body.data, []);
  assert.equal(before.body.next.canRecord, true);
  assert.equal(before.body.next.amount, 8000);
  const paidUntil = new Date(before.body.next.paidUntil);
  assert.ok(paidUntil.getTime() > now + 27 * DAY && paidUntil.getTime() < now + 32 * DAY);

  const form = { amount: 8000, method: 'bank_transfer', receivedAt: new Date(now - DAY).toISOString().slice(0, 10), reference: 'FT26283XYZ', note: 'HBL', paidUntil: paidUntil.toISOString().slice(0, 10), requestId: 'integration-request-1' };
  // Two clicks at the same moment: one payment.
  const [a, b] = await Promise.all([post(form), post(form)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201], JSON.stringify([a.body, b.body]));
  assert.equal(await PlatformPayment.countDocuments({ gymId: gym._id }), 1);
  const made = a.statusCode === 201 ? a : b;
  assert.equal(made.body.duplicate, false);
  assert.equal(made.body.gym.subscription.status, 'active');
  assert.equal(made.body.gym.access_block, null);

  let sub = await read();
  assert.equal(sub.status, 'active');
  assert.equal(sub.currentPeriodEnd.getTime(), paidUntil.getTime());
  assert.equal(sub.pastDueSince, null);
  assert.equal(sub.notices.expired, null);
  assert.equal(sub.amount, 8000, 'the bill itself is untouched');

  // A third click, later, with the page's old form: still the same payment.
  const again = await post(form);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal((await read()).currentPeriodEnd.getTime(), paidUntil.getTime());
  // The same transfer typed into a fresh form is refused.
  const retyped = await post({ ...form, requestId: 'integration-request-2', paidUntil: new Date(paidUntil.getTime() + 31 * DAY).toISOString().slice(0, 10) });
  assert.equal(retyped.statusCode, 409);
  assert.equal(retyped.body.code, 'DUPLICATE_REFERENCE');
  assert.equal(await PlatformPayment.countDocuments({ gymId: gym._id }), 1);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const audits = await PlatformAuditLog.find({ action: 'gym_payment_recorded', gymId: gym._id }).lean();
  assert.equal(audits.length, 1, 'logged once');
  assert.equal(audits[0].actorEmail, 'admin@gympilot.test');
  assert.equal(audits[0].meta.reference, 'FT26283XYZ');

  const history = await h.call(gymsController.listPayments, { params: { id: String(gym._id) }, superAdmin });
  assert.equal(history.body.data.length, 1);
  assert.equal(history.body.data[0].methodLabel, 'Bank transfer');
  assert.equal(history.body.data[0].statusBefore, 'expired');
  assert.equal(history.body.data[0].recordedBy, 'admin@gympilot.test');
  // The next one starts from the date now paid until.
  assert.ok(new Date(history.body.next.paidUntil).getTime() > paidUntil.getTime() + 27 * DAY);

  // The daily roll-over: nothing to do while it is paid up...
  await jobs.rollSubscriptionStatuses({ now: new Date(now + DAY) });
  assert.equal((await read()).status, 'active');
  // ...past due the day after the paid-until date, cut off a grace period later...
  await jobs.rollSubscriptionStatuses({ now: new Date(paidUntil.getTime() + DAY) });
  assert.equal((await read()).status, 'past_due');
  await jobs.rollSubscriptionStatuses({ now: new Date(paidUntil.getTime() + 9 * DAY) });
  assert.equal((await read()).status, 'expired');

  // A gym that pays by card is Stripe's to record.
  await Gym.updateOne({ _id: gym._id }, { $set: { 'subscription.stripeSubscriptionId': 'sub_card_billed' } });
  const refused = await post({ ...form, requestId: 'integration-request-3', reference: 'FT-OTHER' });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.code, 'STRIPE_BILLED');
  await Gym.updateOne({ _id: gym._id }, { $set: { 'subscription.stripeSubscriptionId': '' } });
});
