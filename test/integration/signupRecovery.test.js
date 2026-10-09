// Paid sign-ups nothing else will finish, against a real MongoDB.
//
// The webhook delivery that was building a gym is killed part-way; Stripe's
// retry lands inside the webhook's stale window and is told "duplicate", so
// the signup sits "being set up" for ever. recoverSignup -- run by the daily
// job and by the success page -- sets it up from what Stripe says was paid
// for, with the real provisionGym: a gym already made is linked, one left
// half made is cleared away (its database with it) and made afresh, and one
// that still cannot be made after days of retries is given up on: its
// Stripe subscription cancelled, the buyer told, and the buyer free to sign
// up again. Stripe is a stand-in; email is the harness's.

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Stripe = require('stripe');
const h = require('./helpers/harness');

const WEBHOOK_SECRET = 'whsec_integration_recovery';
const SECRET_KEY = 'sk_test_integration_recovery';
const signer = new Stripe('sk_test_integration_signer').webhooks;
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TRIAL_END = Math.floor((Date.now() + 14 * DAY) / 1000);

let Gym;
let DemoRequest;
let PlatformPlan;
let PlatformSettings;
let PlatformStripeEvent;
let SuperAdmin;
let jobs;
let signupProvisioning;
let signupController;
let platformSettings;

// What the stand-in Stripe knows, and what it was asked to do.
const sessions = new Map();
const stripeCalls = [];

const test = h.suite(async () => {
  // The harness removes these; a self-served gym needs a web address, and
  // selfServeAvailable needs the platform's own email.
  Object.assign(process.env, {
    PLATFORM_ROOT_DOMAIN: 'gympilot.test',
    PLATFORM_ADMIN_ORIGIN: 'https://gympilot.test',
    SMTP_HOST: 'smtp.gympilot.test',
    SMTP_USER: 'noreply@gympilot.test',
    SMTP_PASS: 'integration'
  });

  Gym = h.src('platform/models/gymModel');
  DemoRequest = h.src('platform/models/demoRequestModel');
  PlatformPlan = h.src('platform/models/platformPlanModel');
  PlatformSettings = h.src('platform/models/platformSettingsModel');
  PlatformStripeEvent = h.src('platform/models/platformStripeEventModel');
  SuperAdmin = h.src('platform/models/superAdminModel');
  jobs = h.src('platform/jobs');
  signupProvisioning = h.src('platform/services/signupProvisioning');
  signupController = h.src('platform/controllers/signupController');
  // The mail server selfServeAvailable asks for a login: there is none here.
  h.src('platform/services/platformEmail').verifyPlatformEmail = async () => ({ ok: true, error: '' });
  platformSettings = h.src('platform/controllers/platformSettingsController');
  const { getPlatformStripe } = h.src('platform/services/platformStripe');

  await PlatformStripeEvent.init();
  const settings = await PlatformSettings.getSettings();
  settings.stripe.secretKey = SECRET_KEY;
  settings.stripe.webhookSecret = WEBHOOK_SECRET;
  settings.stripe.enabled = true;
  await settings.save();

  await PlatformPlan.create({ slug: 'growth', name: 'Growth', price: { monthly: 8000, yearly: 80000, currency: 'PKR' }, trialDays: 14 });
  await SuperAdmin.create({ email: 'ops@gympilot.test', password: 'not-used-here' });

  // The platform's client, as every caller gets it: its calls answered here.
  const client = await getPlatformStripe();
  client.checkout.sessions.retrieve = async (id) => {
    stripeCalls.push(['retrieve session', id]);
    if (!sessions.has(id)) throw Object.assign(new Error(`No such checkout.session: ${id}`), { code: 'resource_missing' });
    return sessions.get(id);
  };
  client.checkout.sessions.create = async (params) => {
    stripeCalls.push(['create session', params.client_reference_id]);
    return { id: `cs_new_${params.client_reference_id}`, url: `https://checkout.stripe.test/${params.client_reference_id}` };
  };
  client.subscriptions.retrieve = async (id) => ({
    id,
    status: 'trialing',
    trial_end: TRIAL_END,
    items: { data: [{ current_period_end: TRIAL_END, quantity: 1, price: { unit_amount: 800000, currency: 'pkr', recurring: { interval: 'month' } } }] }
  });
  client.subscriptions.cancel = async (id, params) => {
    stripeCalls.push(['cancel', id, params]);
    return { id, status: 'canceled', currency: 'pkr', latest_invoice: null };
  };
});

/** A signup whose delivery started building its gym `claimedAgo` ms ago and never finished. */
async function stuckSignup(slug, { planSlug = 'growth', claimedAgo = HOUR, signup = {} } = {}) {
  const email = `${slug}@owners.test`;
  const doc = await DemoRequest.create({
    kind: 'signup',
    name: 'Aisha Khan',
    firstName: 'Aisha',
    lastName: 'Khan',
    email,
    gymName: `Gym ${slug}`,
    country: 'Karachi, Pakistan',
    preferredSlug: slug,
    plan: { slug: planSlug, name: 'Growth', billingCycle: 'monthly', addonSlugs: [], amount: 8000, currency: 'PKR', trialDays: 14 },
    signup: {
      state: 'provisioning',
      timezone: 'Asia/Karachi',
      stripeSessionId: `cs_${slug}`,
      stripeCustomerId: `cus_${slug}`,
      stripeSubscriptionId: `sub_${slug}`,
      claimedAt: new Date(Date.now() - claimedAgo),
      attempts: 1,
      ...signup
    }
  });
  sessions.set(`cs_${slug}`, {
    id: `cs_${slug}`,
    object: 'checkout.session',
    status: 'complete',
    mode: 'subscription',
    client_reference_id: String(doc._id),
    subscription: `sub_${slug}`,
    customer: `cus_${slug}`,
    payment_status: 'no_payment_required',
    metadata: { kind: 'signup', signupId: String(doc._id), planSlug, billingCycle: 'monthly' }
  });
  return doc;
}

function deliver(event) {
  const payload = JSON.stringify(event);
  const header = signer.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return h.call(platformSettings.webhook, { body: Buffer.from(payload), headers: { 'stripe-signature': header } });
}

const emailsTo = (to) => h.calls.emails.filter((mail) => mail.to === to);

/** Waits (up to 10s) for work started after a response -- an admin email, say -- to land. */
async function eventually(check) {
  for (let i = 0; i < 100 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  return check();
}

test('a signup whose retry was told "duplicate" is set up by the daily job', async () => {
  const signup = await stuckSignup('iron-works', { claimedAgo: 20 * MIN });

  // Stripe's retry lands while the dead delivery's event claim still looks fresh.
  const event = { id: 'evt_killed', object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000) - 20 * 60, livemode: false, data: { object: sessions.get('cs_iron-works') } };
  const createdAt = new Date(Date.now() - 5 * MIN);
  await PlatformStripeEvent.collection.insertOne({ eventId: event.id, type: event.type, livemode: false, gymId: null, gymSlug: '', result: '', handledAt: null, createdAt, updatedAt: createdAt });
  const retry = await deliver(event);
  assert.equal(retry.body.duplicate, true);
  assert.equal((await DemoRequest.findById(signup._id).lean()).signup.state, 'provisioning', 'and so it would sit');

  const dry = await jobs.recoverStuckSignups({ dryRun: true });
  assert.deepEqual(dry.due, [String(signup._id)]);
  assert.equal((await DemoRequest.findById(signup._id).lean()).signup.recoveryAttempts, 0, 'a dry run changes nothing');

  const run = await jobs.recoverStuckSignups();
  assert.equal(run.recovered, 1, JSON.stringify(run));

  const after = await DemoRequest.findById(signup._id).lean();
  assert.equal(after.signup.state, 'ready');
  assert.equal(after.signup.inviteSent, true);
  assert.match(after.signup.siteUrl, /^https?:\/\/iron-works\.gympilot\.test$/);
  assert.equal(after.signup.recoveryAttempts, 1);
  const gym = await Gym.findById(after.gymId).lean();
  assert.equal(gym.slug, 'iron-works');
  assert.ok(gym.provisionedAt instanceof Date);
  assert.equal(gym.subscription.stripeSubscriptionId, 'sub_iron-works');
  assert.equal(gym.subscription.status, 'trialing');
  assert.equal(emailsTo('iron-works@owners.test').length, 1, 'the owner gets their set-password link');
  assert.ok(await eventually(() => emailsTo('ops@gympilot.test').some((mail) => /signed up and paid/.test(mail.subject))), 'the admins hear of it');

  // Done: nothing is due any more, and running again makes no second gym.
  assert.deepEqual((await jobs.recoverStuckSignups()).results, []);
  assert.equal(await Gym.countDocuments({ 'subscription.stripeSubscriptionId': 'sub_iron-works' }), 1);
});

test('a gym the dead delivery left half made is cleared away, database and all, and made afresh', async () => {
  const signup = await stuckSignup('half-made');
  const deadDatabase = `${h.TENANT_PREFIX}half_made_dead01`;
  await h.rawDb(deadDatabase).collection('roles').insertOne({ slug: 'admin', note: 'seeded before the delivery died' });
  const made = new Date(Date.now() - HOUR);
  const { insertedId } = await Gym.collection.insertOne({
    name: 'Gym half-made',
    slug: 'half-made',
    status: 'active',
    domains: [{ host: 'half-made.gympilot.test', isPrimary: true, addedAt: made }],
    database: { name: deadDatabase, uri: '' },
    owner: { firstName: 'Aisha', lastName: 'Khan', email: 'half-made@owners.test', phone: '' },
    plan: (await PlatformPlan.findOne({ slug: 'growth' }).lean())._id,
    subscription: { status: 'trialing', billingCycle: 'monthly', stripeSubscriptionId: 'sub_half-made', stripeCustomerId: 'cus_half-made', addons: [] },
    provisionedAt: null,
    createdAt: made,
    updatedAt: made
  });

  const outcome = await signupProvisioning.recoverSignup(signup._id);
  assert.equal(outcome.outcome, 'ready', JSON.stringify(outcome));

  assert.equal(await Gym.findById(insertedId).lean(), null, 'the half-made gym is gone');
  assert.ok(!(await h.databaseNames()).includes(deadDatabase), 'with its database');
  const after = await DemoRequest.findById(signup._id).lean();
  const gym = await Gym.findById(after.gymId).lean();
  assert.equal(gym.slug, 'half-made', 'the address is free again');
  assert.ok(gym.provisionedAt instanceof Date);
  assert.notEqual(gym.database.name, deadDatabase);
});

test('the success page sets a stuck signup going again, once, however often it asks', async () => {
  const signup = await stuckSignup('page-watcher');
  const ask = () => h.call(signupController.status, { params: { id: String(signup._id) } });

  const first = await ask();
  assert.equal(first.body.data.status, 'provisioning');
  await ask();
  await ask();

  assert.ok(await eventually(async () => (await DemoRequest.findById(signup._id).lean()).signup.state === 'ready'), 'set up in the background');
  const after = await DemoRequest.findById(signup._id).lean();
  assert.equal(after.signup.recoveryAttempts, 1, 'polling ran it once');
  assert.equal((await ask()).body.data.status, 'ready');
});

test('still stuck after a few retries, the admins hear once; after days, it is given up on', async () => {
  // A plan taken away since: provisioning can never succeed.
  const signup = await stuckSignup('never-made', { planSlug: 'retired', signup: { state: 'failed', recoveryAttempts: 2, recoveryStartedAt: new Date(Date.now() - HOUR) } });
  const adminMail = () => emailsTo('ops@gympilot.test').filter((mail) => /never-made/.test(mail.subject));

  const third = await signupProvisioning.recoverSignup(signup._id);
  assert.equal(third.outcome, 'failed');
  assert.match(third.error, /no longer exists/);
  let doc = await DemoRequest.findById(signup._id).lean();
  assert.ok(doc.signup.alertedAt instanceof Date, 'the admins are told');
  assert.ok(adminMail().some((mail) => /still not set up/.test(mail.subject)));
  assert.equal(doc.signup.gaveUpAt, null);

  // Not again inside the retry window.
  assert.equal((await signupProvisioning.recoverSignup(signup._id)).outcome, 'not due');

  // Days later.
  const earlier = new Date(Date.now() - HOUR);
  await DemoRequest.updateOne(
    { _id: signup._id },
    { $set: { 'signup.claimedAt': earlier, 'signup.recoveryAt': earlier, 'signup.recoveryStartedAt': new Date(Date.now() - 4 * DAY) } }
  );
  const stillStuck = adminMail().filter((mail) => /still not set up/.test(mail.subject)).length;
  const last = await signupProvisioning.recoverSignup(signup._id);
  assert.equal(last.outcome, 'gave up', JSON.stringify(last));
  assert.deepEqual(stripeCalls.find((call) => call[0] === 'cancel' && call[1] === 'sub_never-made'), ['cancel', 'sub_never-made', { invoice_now: false, prorate: false }]);

  doc = await DemoRequest.findById(signup._id).lean();
  assert.equal(doc.signup.state, 'failed');
  assert.ok(doc.signup.gaveUpAt instanceof Date);
  assert.match(doc.signup.error, /sub_never-made was cancelled/);
  assert.equal(emailsTo('never-made@owners.test').filter((mail) => /could not set up/.test(mail.subject)).length, 1, 'the buyer is told');
  assert.ok(adminMail().some((mail) => /given up on/.test(mail.subject)));
  assert.equal(adminMail().filter((mail) => /still not set up/.test(mail.subject)).length, stillStuck, 'no second "still stuck"');

  // The success page says so, and nothing retries it any more.
  const status = await h.call(signupController.status, { params: { id: String(signup._id) } });
  assert.match(status.body.data.message, /cancelled the subscription/);
  assert.equal((await jobs.recoverStuckSignups({ dryRun: true })).due.includes(String(signup._id)), false);

  // A late delivery of the paid checkout changes nothing.
  const late = await deliver({ id: 'evt_late', object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: sessions.get('cs_never-made') } });
  assert.match(late.body.result, /given up on/);

  // And the buyer may sign up again: not "already being set up", and the address is free.
  const again = await h.call(signupController.start, {
    body: { firstName: 'Aisha', lastName: 'Khan', email: 'never-made@owners.test', gymName: 'Gym never-made', preferredSlug: 'never-made', planSlug: 'growth', billingCycle: 'monthly', website: '' },
    headers: { origin: 'https://gympilot.test' },
    socket: {}
  });
  assert.equal(again.statusCode, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.id, String(signup._id), 'a new signup, not the one given up on');
  assert.equal(await DemoRequest.countDocuments({ email: 'never-made@owners.test' }), 2);
  assert.ok(mongoose.Types.ObjectId.isValid(again.body.id));
});
