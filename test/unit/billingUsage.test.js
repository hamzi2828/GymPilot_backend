// The plan-usage meter on Settings → Billing: one entry per plan limit, the
// same counts the limits are enforced with, unlimited as null. No database --
// the models are stubbed on a tenant connection that never connects.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const { LIMIT_KINDS } = require('../../src/platform/planLimits');
const User = require('../../src/models/user');
const Trainer = require('../../src/gymfolio/models/trainerModel');
const GymClass = require('../../src/gymfolio/models/gymClassModel');
const { planUsage } = require('../../src/platform/controllers/billingController');

const fakeKinds = {
  members: { field: 'maxMembers', label: 'members', count: async () => 182 },
  staff: { field: 'maxStaff', label: 'staff accounts', count: async () => 4 }
};

test('usage has one entry per limit, labelled for the screen, with 0 read as unlimited', async () => {
  const usage = await planUsage({ limits: { maxMembers: 200, maxStaff: 0 } }, fakeKinds);
  assert.deepEqual(usage, [
    { key: 'members', label: 'Members', used: 182, limit: 200 },
    { key: 'staff', label: 'Staff accounts', used: 4, limit: null }
  ]);
});

test('a gym on no plan, or a plan without limits, is unlimited everywhere but still counted', async () => {
  for (const plan of [null, {}, { limits: {} }]) {
    const usage = await planUsage(plan, fakeKinds);
    assert.deepEqual(usage.map((u) => u.limit), [null, null]);
    assert.deepEqual(usage.map((u) => u.used), [182, 4]);
  }
});

test('a count that fails fails the usage, for the caller to leave out', async () => {
  const broken = { members: { field: 'maxMembers', label: 'members', count: async () => { throw new Error('boom'); } } };
  await assert.rejects(() => planUsage({ limits: { maxMembers: 5 } }, broken), /boom/);
});

test('every plan limit is on the meter, counted as it is enforced -- the owner is not a staff seat', async () => {
  const gym = {
    _id: '00000000000000000000c001',
    slug: 'unit-billing-usage',
    database: { name: 'gympilot_unit_billing_usage' },
    domains: [],
    owner: { email: 'Owner@Example.com ' }
  };

  await runWithTenant(gym, async () => {
    const seen = [];
    User.countDocuments = async (filter) => {
      seen.push(filter);
      return filter.role === 'user' ? 190 : 3;
    };
    Trainer.countDocuments = async () => 2;
    GymClass.countDocuments = async () => 12;

    const usage = await planUsage({ limits: { maxMembers: 200, maxStaff: 3, maxTrainers: 0, maxClasses: 10 } });

    assert.deepEqual(usage.map((u) => u.key), Object.keys(LIMIT_KINDS));
    assert.deepEqual(usage, [
      { key: 'members', label: 'Members', used: 190, limit: 200 },
      { key: 'staff', label: 'Staff accounts', used: 3, limit: 3 },
      { key: 'trainers', label: 'Trainers', used: 2, limit: null },
      { key: 'classes', label: 'Classes', used: 12, limit: 10 }
    ]);
    const staffFilter = seen.find((filter) => filter['employment.isStaff']);
    assert.deepEqual(staffFilter.email, { $ne: 'owner@example.com' });
  });
});
