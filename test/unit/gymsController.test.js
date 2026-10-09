// The panel's actions on one gym, minus the database and Stripe: suspending
// a gym that pays by card stops Stripe charging it, reactivating starts it
// again, and Stripe refusing never stops the switch itself.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const PlatformAuditLog = require('../../src/platform/models/platformAuditLogModel');
const platformBilling = require('../../src/platform/services/platformBilling');
const controller = require('../../src/platform/controllers/gymsController');

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

/** A gym document as the controller loads it: fields, save() and toObject(). */
function gymDoc(fields = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Iron Works',
    slug: 'iron-works',
    status: 'active',
    domains: [{ host: 'iron-works.test', isPrimary: true }],
    database: { name: 'gympilot_unit_tests_iron_works_abc123' },
    owner: { email: 'owner@ironworks.test' },
    plan: null,
    ...fields,
    subscription: { status: 'active', billingCycle: 'monthly', currency: 'PKR', stripeSubscriptionId: '', ...(fields.subscription || {}) },
    saves: 0
  };
  doc.save = async () => {
    doc.saves += 1;
    return doc;
  };
  doc.toObject = () => {
    const { save, toObject, saves, ...plain } = doc;
    return JSON.parse(JSON.stringify(plain));
  };
  return doc;
}

/** The controller's world: one gym to load, the audit log and Stripe's pause recorded. */
function world(gym, { pause = async () => {} } = {}) {
  const calls = { paused: [], audits: [] };
  const restore = [
    stub(Gym, { findById: () => ({ select: async () => gym }) }),
    stub(PlatformAuditLog, {
      record: async (entry) => {
        calls.audits.push(entry);
        return entry;
      }
    }),
    stub(platformBilling, {
      setCollectionPaused: async (id, paused) => {
        calls.paused.push([id, paused]);
        return pause(id, paused);
      }
    })
  ];
  return { calls, restore: () => restore.reverse().forEach((fn) => fn()) };
}

async function call(handler, gym, body) {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  await handler({ params: { id: String(gym._id) }, body, headers: {}, superAdmin: { _id: new mongoose.Types.ObjectId(), email: 'admin@gympilot.test' } }, res);
  return res;
}

test('suspending a gym that pays by card stops Stripe charging it; reactivating starts it again', async () => {
  const gym = gymDoc({ subscription: { stripeSubscriptionId: 'sub_1' } });
  const w = world(gym);
  try {
    const suspended = await call(controller.setStatus, gym, { status: 'suspended' });
    assert.equal(suspended.statusCode, 200);
    assert.equal(suspended.body.data.status, 'suspended');
    assert.deepEqual(suspended.body.billing, { subscriptionId: 'sub_1', paused: true });
    assert.deepEqual(suspended.body.warnings, []);

    // Saved twice by accident: Stripe is not asked again.
    await call(controller.setStatus, gym, { status: 'suspended' });
    assert.deepEqual(w.calls.paused, [['sub_1', true]]);

    const back = await call(controller.setStatus, gym, { status: 'active' });
    assert.deepEqual(back.body.billing, { subscriptionId: 'sub_1', paused: false });
    assert.deepEqual(w.calls.paused, [['sub_1', true], ['sub_1', false]]);
    assert.deepEqual(w.calls.audits.map((a) => a.action), ['gym_suspended', 'gym_suspended', 'gym_activated']);
    assert.deepEqual(w.calls.audits[0].meta.billing, { subscriptionId: 'sub_1', paused: true });
  } finally {
    w.restore();
  }
});

test('Stripe refusing never stops a suspension: the gym goes off, and the admin is told its card is still charged', async () => {
  const gym = gymDoc({ subscription: { stripeSubscriptionId: 'sub_1' } });
  const w = world(gym, {
    pause: async () => {
      throw new Error('No such subscription: sub_1');
    }
  });
  try {
    const res = await call(controller.setStatus, gym, { status: 'suspended' });
    assert.equal(res.statusCode, 200);
    assert.equal(gym.status, 'suspended');
    assert.equal(gym.saves, 1);
    assert.equal(res.body.billing, null);
    assert.equal(res.body.warnings.length, 1);
    assert.match(res.body.warnings[0], /still being charged/);
    assert.match(res.body.warnings[0], /Pause or cancel sub_1 in the Stripe dashboard/);

    const back = await call(controller.setStatus, gym, { status: 'active' });
    assert.equal(gym.status, 'active');
    assert.match(back.body.warnings[0], /Resume sub_1 in the Stripe dashboard/);
  } finally {
    w.restore();
  }
});

test('a gym billed by hand has nothing to pause, and an unknown status is refused', async () => {
  const gym = gymDoc();
  const w = world(gym);
  try {
    const res = await call(controller.setStatus, gym, { status: 'suspended' });
    assert.equal(res.body.billing, null);
    assert.deepEqual(res.body.warnings, []);
    assert.deepEqual(w.calls.paused, []);

    const bad = await call(controller.setStatus, gym, { status: 'paused' });
    assert.equal(bad.statusCode, 400);
  } finally {
    w.restore();
  }
});

test('pausing voids what falls due rather than charging it later; resuming clears the pause', async () => {
  const sent = [];
  const stripe = { subscriptions: { update: async (id, params) => sent.push([id, params]) } };
  await platformBilling.setCollectionPaused('sub_1', true, stripe);
  await platformBilling.setCollectionPaused('sub_1', false, stripe);
  assert.deepEqual(sent, [
    ['sub_1', { pause_collection: { behavior: 'void' } }],
    ['sub_1', { pause_collection: '' }]
  ]);
});
