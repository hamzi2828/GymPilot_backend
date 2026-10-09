// Self-serve signup from the marketing site: what the form must carry, how
// the web address is checked before anyone pays, what the success page is
// told, the rules for what a paid checkout does, and the public endpoint's
// answers. No database and no Stripe: model statics and the billing service
// are stubbed where a flow needs them.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.DEFAULT_TENANT_SLUG;
delete process.env.FRONTEND_ORIGIN;
delete process.env.PLATFORM_SELF_SERVE_SIGNUP;

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const DemoRequest = require('../../src/platform/models/demoRequestModel');
const PlatformPlan = require('../../src/platform/models/platformPlanModel');
const PlatformSettings = require('../../src/platform/models/platformSettingsModel');
const platformBilling = require('../../src/platform/services/platformBilling');
const platformEmail = require('../../src/platform/services/platformEmail');
const controller = require('../../src/platform/controllers/signupController');
const { signupDecision, localeFor, recoveryDue } = require('../../src/platform/services/signupProvisioning');

/** Replaces statics for one test; the returned function puts them back. */
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

/** A stand-in for a Mongoose query: chainable, and awaits to `value`. */
function query(value) {
  const q = {
    select: () => q,
    lean: () => q,
    sort: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject)
  };
  return q;
}

async function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

const FORM = {
  gymName: 'Iron Works Fitness',
  firstName: 'Aisha',
  lastName: 'Khan',
  email: 'Aisha@IronWorks.fit',
  phone: '+92 300 1234567',
  country: 'Karachi, Pakistan',
  preferredSlug: 'Iron Works',
  planSlug: 'growth',
  billingCycle: 'monthly',
  addonSlugs: [],
  timezone: 'Asia/Karachi',
  website: ''
};

/* ------------------------------- the form ------------------------------- */

test('a signup is checked like checkout, and must name a plan and both halves of the owner', () => {
  const ok = controller.validateSignup(FORM);
  assert.equal(ok.spam, false);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.data.kind, 'signup');
  assert.equal(ok.data.email, 'aisha@ironworks.fit');
  assert.equal(ok.data.name, 'Aisha Khan');
  assert.equal(ok.data.timezone, 'Asia/Karachi');

  assert.deepEqual(controller.validateSignup({ ...FORM, planSlug: '' }).errors, ['Pick a plan']);
  assert.deepEqual(controller.validateSignup({ ...FORM, lastName: '' }).errors, ['Your last name is required']);
  // No name at all is said once, by the demo-request rules.
  assert.deepEqual(controller.validateSignup({ ...FORM, firstName: '', lastName: '' }).errors, ['Your name is required']);
});

test('a filled honeypot is spam and nothing else is looked at', () => {
  assert.equal(controller.validateSignup({ ...FORM, website: 'http://spam.example' }).spam, true);
});

test('the web address checked is the one provisioning will make', () => {
  assert.equal(controller.webAddressFor('Iron Works!', 'ignored'), 'iron-works');
  assert.equal(controller.webAddressFor('', 'Iron Works Fitness'), 'iron-works-fitness');
  // Capped at 44 like provisioning.freeSlugFrom, and never left ending in a hyphen.
  const long = controller.webAddressFor(`${'a'.repeat(43)} b`, '');
  assert.equal(long, 'a'.repeat(43));
});

/* ---------------------------- the web address --------------------------- */

test('a web address is refused when invalid, reserved, a gym\'s, or held by someone else\'s paying signup', async () => {
  let heldFilter = null;
  let gymTaken = false;
  let held = false;
  const restore = [
    stub(Gym, {
      findOne: () => query(gymTaken ? { _id: 'g1' } : null),
      find: () => query(gymTaken ? [{ slug: 'ironworks' }] : [])
    }),
    stub(DemoRequest, {
      findOne: (filter) => {
        heldFilter = filter;
        return query(held ? { _id: 'd1' } : null);
      }
    })
  ];
  try {
    await withEnv({ PLATFORM_ROOT_DOMAIN: 'gympilot.test' }, async () => {
      assert.equal((await controller.webAddressProblem('', 'a@b.co')).code, 'SLUG_INVALID');

      const reserved = await controller.webAddressProblem('admin', 'a@b.co');
      assert.equal(reserved.code, 'SLUG_TAKEN');
      assert.equal(reserved.suggestion, 'admin-2');

      assert.equal(await controller.webAddressProblem('ironworks', 'a@b.co'), null, 'free');
      // Only somebody else's signup, and only one that reached the payment page.
      assert.deepEqual(heldFilter.email, { $ne: 'a@b.co' });
      assert.deepEqual(heldFilter['signup.stripeSessionId'], { $nin: ['', null] });
      assert.equal(heldFilter.gymId, null);
      // One given up on (subscription cancelled) holds nothing.
      assert.equal(heldFilter['signup.gaveUpAt'], null);
      assert.ok('signup.gaveUpAt' in heldFilter);

      gymTaken = true;
      const taken = await controller.webAddressProblem('ironworks', 'a@b.co');
      assert.equal(taken.status, 409);
      assert.equal(taken.suggestion, 'ironworks-2');
      assert.match(taken.message, /ironworks\.gympilot\.test is already taken/);

      gymTaken = false;
      held = true;
      const pending = await controller.webAddressProblem('ironworks', 'a@b.co');
      assert.equal(pending.code, 'SLUG_TAKEN');
      assert.equal(pending.suggestion, 'ironworks-2', 'never suggests the address that is held');
    });
  } finally {
    restore.forEach((r) => r());
  }
});

test('Stripe sends the buyer back to a configured origin, never one the request made up', async () => {
  await withEnv({ PLATFORM_ADMIN_ORIGIN: 'https://gympilot.app, https://www.gympilot.app/' }, () => {
    assert.equal(controller.marketingOrigin({ headers: { origin: 'https://www.gympilot.app' } }), 'https://www.gympilot.app');
    assert.equal(controller.marketingOrigin({ headers: { origin: 'https://evil.example' } }), 'https://gympilot.app');
    assert.equal(controller.marketingOrigin({ headers: {} }), 'https://gympilot.app');
  });
  await withEnv({ PLATFORM_ADMIN_ORIGIN: undefined }, () => {
    assert.equal(controller.marketingOrigin({ headers: { origin: 'https://evil.example' } }), 'http://localhost:3001');
  });
});

/* ----------------------------- the status page ---------------------------- */

test('the status says where it has got and nothing personal; the address only once ready', () => {
  const waiting = controller.statusView({ signup: { state: 'awaiting_payment', siteUrl: '' } });
  assert.deepEqual(Object.keys(waiting).sort(), ['message', 'status']);
  assert.equal(waiting.status, 'awaiting_payment');

  const failed = controller.statusView({ signup: { state: 'failed', error: 'E11000 duplicate key', siteUrl: 'https://x.gympilot.test' } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.siteUrl, undefined);
  assert.doesNotMatch(failed.message, /E11000/, 'the internal reason stays in the panel');

  const trialEnd = new Date('2026-10-05T00:00:00Z');
  const ready = controller.statusView({ signup: { state: 'ready', siteUrl: 'https://ironworks.gympilot.test', inviteSent: true, trialEndsAt: trialEnd } });
  assert.equal(ready.siteUrl, 'https://ironworks.gympilot.test');
  assert.equal(ready.trialEndsAt, trialEnd);
  assert.match(ready.message, /Check your email/);

  const noEmail = controller.statusView({ signup: { state: 'ready', siteUrl: 'https://ironworks.gympilot.test', inviteSent: false } });
  assert.match(noEmail.message, /did not go out/);

  // Given up on: still failed, but the buyer is told the subscription is cancelled.
  const gaveUp = controller.statusView({ signup: { state: 'failed', gaveUpAt: new Date(), error: 'E11000' } });
  assert.equal(gaveUp.status, 'failed');
  assert.match(gaveUp.message, /cancelled the subscription/);
  assert.doesNotMatch(failed.message, /cancelled/);
});

/* ------------------------ the status page, when stuck ----------------------- */

test('a signup is due another try once its last attempt is old, and not again until the retry window passes', () => {
  const now = Date.parse('2026-09-21T10:00:00Z');
  const min = 60000;
  const doc = (signup, fields = {}) => ({ kind: 'signup', gymId: null, ...fields, signup });
  const due = (d) => recoveryDue(d, now);

  assert.equal(due(doc({ state: 'provisioning', claimedAt: new Date(now - 16 * min) })), true, 'a delivery that died');
  assert.equal(due(doc({ state: 'failed', claimedAt: new Date(now - 16 * min) })), true);
  assert.equal(due(doc({ state: 'provisioning', claimedAt: new Date(now - 5 * min) })), false, 'a delivery still at work');
  assert.equal(due(doc({ state: 'failed', claimedAt: new Date(now - 60 * min), recoveryAt: new Date(now - 5 * min) })), false, 'retried a moment ago');
  assert.equal(due(doc({ state: 'failed', claimedAt: new Date(now - 60 * min), recoveryAt: new Date(now - 20 * min) })), true);
  assert.equal(due(doc({ state: 'failed', claimedAt: null, gaveUpAt: new Date(now - min) })), false, 'given up on');
  assert.equal(due(doc({ state: 'ready', claimedAt: null })), false);
  assert.equal(due(doc({ state: 'awaiting_payment', claimedAt: null })), false);
  assert.equal(due(doc({ state: 'failed', claimedAt: null }, { gymId: 'g1' })), false, 'it has its gym');
  assert.equal(due(null), false);
});

test('the success page sets a stuck signup going again, after answering', async () => {
  const signupProvisioning = require('../../src/platform/services/signupProvisioning');
  const stuck = { _id: new mongoose.Types.ObjectId(), kind: 'signup', gymId: null, signup: { state: 'provisioning', claimedAt: new Date(Date.now() - 3600000) } };
  const fresh = { ...stuck, signup: { state: 'provisioning', claimedAt: new Date() } };
  let shown = stuck;
  const retried = [];
  const restore = [
    stub(DemoRequest, { findById: () => query(shown) }),
    stub(signupProvisioning, {
      recoverSignup: async (id) => {
        retried.push(String(id));
        return { outcome: 'ready' };
      }
    })
  ];
  try {
    const res = fakeRes();
    await controller.status({ params: { id: String(stuck._id) } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.status, 'provisioning');
    assert.deepEqual(retried, [String(stuck._id)]);

    shown = fresh;
    await controller.status({ params: { id: String(stuck._id) } }, fakeRes());
    assert.equal(retried.length, 1, 'a delivery still at work is left alone');
  } finally {
    restore.forEach((r) => r());
  }
});

/* ------------------------- what a paid checkout does ---------------------- */

test('a paid checkout makes a gym once, and only once', () => {
  const now = Date.parse('2026-09-21T10:00:00Z');
  const signup = (fields = {}, state = 'awaiting_payment', claimedAt = null) => ({ gymId: null, ...fields, signup: { state, claimedAt } });
  const gym = (fields = {}) => ({ provisionedAt: new Date(now), subscription: { stripeSubscriptionId: 'sub_1' }, ...fields });
  const decide = (s, g, status = 'trialing', subscriptionId = 'sub_1') => signupDecision(s, { gym: g, subscriptionId, status, now, staleMs: 600000 });

  assert.equal(decide(signup(), null), 'provision');
  assert.equal(decide(signup({}, 'failed'), null), 'provision', 'a failed attempt is tried again');
  assert.equal(decide(signup(), null, 'active'), 'provision');
  // A retry after the gym exists links it rather than making another.
  assert.equal(decide(signup({ gymId: 'g1' }, 'ready'), gym()), 'link');
  assert.equal(decide(signup({}, 'provisioning', new Date(now - 1000)), gym()), 'link', 'found by its Stripe subscription');
  // Set up by hand from the panel before the payment landed: the payment joins it.
  assert.equal(decide(signup({ gymId: 'g1' }), gym({ subscription: { stripeSubscriptionId: '' } })), 'link');
  assert.equal(decide(signup({ gymId: 'g1' }, 'ready'), gym({ subscription: { stripeSubscriptionId: 'sub_other' } })), 'conflict');
  assert.equal(decide(signup({ gymId: 'g1' }, 'ready'), null), 'gone');
  // Another delivery is building it right now.
  assert.equal(decide(signup({}, 'provisioning', new Date(now - 1000)), null), 'wait');
  assert.equal(decide(signup({}, 'provisioning', new Date(now - 1000)), gym({ provisionedAt: null })), 'wait');
  // ...or died doing it.
  assert.equal(decide(signup({}, 'provisioning', new Date(now - 3600000)), null), 'provision');
  assert.equal(decide(signup({}, 'provisioning', new Date(now - 3600000)), gym({ provisionedAt: null })), 'half');
  // checkoutStatus maps Stripe's `incomplete` to nothing.
  assert.equal(decide(signup(), null, null), 'unpaid', 'incomplete is not paid');
  assert.equal(decide(signup(), null, 'trialing', ''), 'unpaid', 'no subscription, nothing to attach');
});

test('the gym\'s locale comes from the place typed, with the browser clock where it agrees', () => {
  assert.deepEqual(localeFor('Karachi, Pakistan', 'Asia/Karachi'), { country: 'PK', currency: 'PKR', timezone: 'Asia/Karachi' });
  assert.deepEqual(localeFor('Austin, USA', 'America/Chicago'), { country: 'US', currency: 'USD', timezone: 'America/Chicago' });
  // A Karachi gym whose owner signed up on holiday keeps Karachi's clock.
  assert.deepEqual(localeFor('Lahore', 'Europe/London'), { country: 'PK', currency: 'PKR', timezone: 'Asia/Karachi' });
  assert.deepEqual(localeFor('', 'Europe/London'), { country: 'GB', currency: 'GBP', timezone: 'Europe/London' });
  assert.deepEqual(localeFor('Somewhere', 'Not/AZone'), { country: '', currency: 'USD', timezone: 'UTC' });
});

/* ---------------------------- POST /public/signup -------------------------- */

const PLAN = {
  _id: new mongoose.Types.ObjectId(),
  slug: 'growth',
  name: 'Growth',
  isActive: true,
  price: { monthly: 8000, yearly: 80000, currency: 'PKR' },
  includedAddons: [],
  trialDays: 14
};

/** Everything start() touches, stubbed; `state` changes what each answers. */
function startStubs(state = {}) {
  const calls = { created: [], updated: [], sessions: [], closed: [], mailChecks: 0 };
  const restore = [
    // The mail server, asked whether it takes the platform's login.
    stub(platformEmail, {
      verifyPlatformEmail: async () => {
        calls.mailChecks += 1;
        return state.mailRefused ? { ok: false, error: state.mailRefused } : { ok: true, error: '' };
      }
    }),
    stub(PlatformSettings, { getSettings: async () => ({ stripe: { secretKey: 'sk_test_unit', enabled: true, webhookSecret: state.noWebhookSecret ? '' : 'whsec_unit' } }) }),
    stub(PlatformPlan, { findOne: () => ({ ...PLAN, lean: async () => PLAN }) }),
    stub(Gym, { findOne: () => query(state.slugTaken ? { _id: 'g1' } : null), find: () => query(state.slugTaken ? [{ slug: 'iron-works' }] : []) }),
    stub(DemoRequest, {
      // The buyer's own open signup is looked up by their exact address; a
      // web address held by somebody else, by anyone's but theirs.
      findOne: (filter) => query(typeof filter.email === 'string' ? state.pending || null : null),
      create: async (doc) => {
        calls.created.push(doc);
        return { _id: new mongoose.Types.ObjectId(), ...doc };
      },
      updateOne: async (filter, update) => {
        calls.updated.push({ filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }),
    stub(platformBilling, {
      createSignupCheckoutSession: async (args) => {
        calls.sessions.push(args);
        return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' };
      },
      closeSignupCheckoutSession: async (id) => {
        calls.closed.push(id);
        return state.previousSession || 'expired';
      }
    })
  ];
  return { calls, restore: () => restore.forEach((r) => r()) };
}

const req = (body) => ({ body, headers: { origin: 'https://gympilot.app', 'user-agent': 'unit' }, socket: {} });
const SIGNUP_ENV = {
  PLATFORM_ROOT_DOMAIN: 'gympilot.test',
  PLATFORM_ADMIN_ORIGIN: 'https://gympilot.app',
  SMTP_HOST: 'smtp.gympilot.test',
  SMTP_USER: 'noreply@gympilot.test',
  SMTP_PASS: 'unit-smtp-pass'
};

test('with no platform email nobody pays for a gym whose set-password link could never be sent', async () => {
  assert.equal(controller.platformEmailConfigured({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }), true);
  assert.equal(controller.platformEmailConfigured({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: '  ' }), false);
  assert.equal(controller.platformEmailConfigured({}), false);

  const { calls, restore } = startStubs();
  try {
    await withEnv({ ...SIGNUP_ENV, SMTP_PASS: undefined }, async () => {
      const availability = await controller.selfServeAvailable();
      assert.equal(availability.available, false);
      assert.match(availability.reason, /SMTP/);
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'SELF_SERVE_UNAVAILABLE');
      assert.equal(calls.created.length, 0);
      assert.equal(calls.sessions.length, 0);
    });
  } finally {
    restore();
  }
});

test('a mail server that refuses the login means nobody is sent to pay: the form becomes a request instead', async () => {
  // Three variables that are filled in and wrong: the card would be charged,
  // the gym built, and the email with the way in never sent.
  const { calls, restore } = startStubs({ mailRefused: 'Invalid login: 535 Authentication failed' });
  try {
    await withEnv(SIGNUP_ENV, async () => {
      const availability = await controller.selfServeAvailable();
      assert.equal(availability.available, false);
      assert.match(availability.reason, /would not accept a connection and login .Invalid login: 535 Authentication failed./);
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'SELF_SERVE_UNAVAILABLE');
      // Nothing about why reaches the public.
      assert.doesNotMatch(JSON.stringify(res.body), /535|login/i);
      assert.equal(calls.created.length, 0);
      assert.equal(calls.sessions.length, 0, 'Stripe was never asked for a payment page');
    });
  } finally {
    restore();
  }

  // The mail server is the last thing asked: not at all when Stripe is not ready.
  const noStripe = startStubs({ noWebhookSecret: true });
  try {
    await withEnv(SIGNUP_ENV, async () => {
      assert.equal((await controller.selfServeAvailable()).available, false);
      assert.equal(noStripe.calls.mailChecks, 0);
    });
  } finally {
    noStripe.restore();
  }
});

test('the mail server is asked for a connection and login, briefly, and the answer is remembered for a while', async () => {
  const SMTP = { SMTP_HOST: 'smtp.gympilot.test', SMTP_PORT: '465', SMTP_USER: 'noreply@gympilot.test', SMTP_PASS: 'unit-smtp-pass' };
  const made = [];
  let answer = async () => true;
  const restore = stub(platformEmail.mailer, {
    createTransport: (options) => {
      made.push(options);
      return { verify: () => answer(), close: () => {} };
    }
  });
  const t0 = Date.parse('2026-10-09T09:00:00Z');
  try {
    platformEmail.forgetPlatformEmailCheck();
    // Not set up at all: no question to ask.
    assert.equal((await platformEmail.verifyPlatformEmail({ env: {}, now: t0 })).ok, false);
    assert.equal(made.length, 0);

    assert.deepEqual(await platformEmail.verifyPlatformEmail({ env: SMTP, now: t0 }), { ok: true, error: '' });
    assert.equal(made.length, 1);
    // The transport emailService would build from the same settings, with short timeouts.
    assert.equal(made[0].host, 'smtp.gympilot.test');
    assert.equal(made[0].port, 465);
    assert.equal(made[0].secure, true);
    assert.deepEqual(made[0].auth, { user: 'noreply@gympilot.test', pass: 'unit-smtp-pass' });
    assert.ok(made[0].connectionTimeout <= 5000 && made[0].greetingTimeout <= 5000 && made[0].socketTimeout <= 5000);

    // Remembered: the public config endpoint does not knock on the mail server every time.
    await platformEmail.verifyPlatformEmail({ env: SMTP, now: t0 + 60 * 1000 });
    assert.equal(made.length, 1);
    // ...but not for long,
    answer = async () => {
      throw new Error('Invalid login: 535 Authentication failed');
    };
    assert.deepEqual(await platformEmail.verifyPlatformEmail({ env: SMTP, now: t0 + platformEmail.OK_TTL_MS + 1 }), { ok: false, error: 'Invalid login: 535 Authentication failed' });
    assert.equal(made.length, 2);
    // a failure for less long still,
    const t1 = t0 + platformEmail.OK_TTL_MS + 1;
    await platformEmail.verifyPlatformEmail({ env: SMTP, now: t1 + platformEmail.FAILED_TTL_MS - 1 });
    assert.equal(made.length, 2);
    answer = async () => true;
    assert.equal((await platformEmail.verifyPlatformEmail({ env: SMTP, now: t1 + platformEmail.FAILED_TTL_MS + 1 })).ok, true);
    assert.equal(made.length, 3);
    // and never across a change of settings.
    await platformEmail.verifyPlatformEmail({ env: { ...SMTP, SMTP_PASS: 'a new password' }, now: t1 + platformEmail.FAILED_TTL_MS + 2 });
    assert.equal(made.length, 4);

    // Several askers at once share one question.
    platformEmail.forgetPlatformEmailCheck();
    const results = await Promise.all([1, 2, 3].map(() => platformEmail.verifyPlatformEmail({ env: SMTP, now: t0 })));
    assert.equal(made.length, 5);
    assert.ok(results.every((r) => r.ok));
  } finally {
    restore();
    platformEmail.forgetPlatformEmailCheck();
  }
});

test('with no root domain, checkout is told to send a request instead', async () => {
  const { calls, restore } = startStubs();
  try {
    await withEnv({ PLATFORM_ROOT_DOMAIN: undefined }, async () => {
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'SELF_SERVE_UNAVAILABLE');
      assert.equal(calls.created.length, 0);
    });
  } finally {
    restore();
  }
});

test('with no webhook signing secret nobody is sent to pay for a gym that would never be made', async () => {
  const { calls, restore } = startStubs({ noWebhookSecret: true });
  try {
    await withEnv(SIGNUP_ENV, async () => {
      assert.equal((await controller.selfServeAvailable()).available, false);
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.body.code, 'SELF_SERVE_UNAVAILABLE');
      assert.equal(calls.sessions.length, 0);
    });
  } finally {
    restore();
  }
});

test('the operator can switch self-serve off with Stripe still on', async () => {
  const { restore } = startStubs();
  try {
    await withEnv({ ...SIGNUP_ENV, PLATFORM_SELF_SERVE_SIGNUP: 'off' }, async () => {
      assert.equal((await controller.selfServeAvailable()).available, false);
    });
    await withEnv(SIGNUP_ENV, async () => {
      assert.equal((await controller.selfServeAvailable()).available, true);
    });
  } finally {
    restore();
  }
});

test('a good signup is stored, priced on the server, and sent to Stripe', async () => {
  const { calls, restore } = startStubs();
  try {
    await withEnv(SIGNUP_ENV, async () => {
      const res = fakeRes();
      // The price the form claims is never read.
      await controller.start(req({ ...FORM, amount: 1 }), res);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(res.body.url, 'https://checkout.stripe.test/cs_test_1');

      assert.equal(calls.created.length, 1);
      const doc = calls.created[0];
      assert.equal(doc.kind, 'signup');
      assert.equal(doc.email, 'aisha@ironworks.fit');
      assert.equal(doc.preferredSlug, 'iron-works');
      assert.equal(doc.plan.amount, 8000);
      assert.equal(doc.plan.trialDays, 14);
      assert.deepEqual(doc.signup, { state: 'awaiting_payment', timezone: 'Asia/Karachi' });

      const session = calls.sessions[0];
      assert.equal(session.email, 'aisha@ironworks.fit');
      assert.equal(session.billingCycle, 'monthly');
      assert.match(session.successUrl, /^https:\/\/gympilot\.app\/checkout\/success\?signup=[0-9a-f]{24}$/);
      assert.equal(session.cancelUrl, 'https://gympilot.app/checkout?plan=growth&cycle=monthly&cancelled=1');

      // The page is remembered only once Stripe has made it.
      const saved = calls.updated.find((u) => u.update.$set && u.update.$set['signup.stripeSessionId']);
      assert.equal(saved.update.$set['signup.stripeSessionId'], 'cs_test_1');
    });
  } finally {
    restore();
  }
});

test('a taken web address is refused before anyone pays', async () => {
  const { calls, restore } = startStubs({ slugTaken: true });
  try {
    await withEnv(SIGNUP_ENV, async () => {
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'SLUG_TAKEN');
      assert.equal(res.body.suggestion, 'iron-works-2');
      assert.equal(calls.created.length, 0);
      assert.equal(calls.sessions.length, 0);
    });
  } finally {
    restore();
  }
});

test('a buyer whose gym is already being set up is never asked to pay again', async () => {
  const { calls, restore } = startStubs({ pending: { _id: 'd1', signup: { state: 'provisioning', stripeSessionId: 'cs_old' } } });
  try {
    await withEnv(SIGNUP_ENV, async () => {
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'SIGNUP_IN_PROGRESS');
      assert.equal(calls.sessions.length, 0);
    });
  } finally {
    restore();
  }
});

test('coming back to checkout closes the old payment page first, and stops if it was paid', async () => {
  let edited = false;
  const pending = {
    _id: new mongoose.Types.ObjectId(),
    signup: { state: 'awaiting_payment', stripeSessionId: 'cs_old' },
    set() {
      edited = true;
    },
    async save() {
      return this;
    }
  };

  const paid = startStubs({ pending, previousSession: 'complete' });
  try {
    await withEnv(SIGNUP_ENV, async () => {
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.body.code, 'SIGNUP_IN_PROGRESS');
      assert.deepEqual(paid.calls.closed, ['cs_old']);
      assert.equal(edited, false, 'the record it was paid from is left as it was paid');
      assert.equal(paid.calls.sessions.length, 0);
    });
  } finally {
    paid.restore();
  }

  const open = startStubs({ pending, previousSession: 'expired' });
  try {
    await withEnv(SIGNUP_ENV, async () => {
      const res = fakeRes();
      await controller.start(req(FORM), res);
      assert.equal(res.statusCode, 201);
      assert.equal(edited, true, 'the same record is picked up again');
      assert.equal(open.calls.created.length, 0, 'not a second record');
      assert.equal(open.calls.sessions.length, 1);
    });
  } finally {
    open.restore();
  }
});
