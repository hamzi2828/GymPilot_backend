// The admin header's bell: what each role is told about, what counts as a
// lead follow-up being due, and what the bell is sent. No database -- the
// models are stubbed on a tenant connection that never connects.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const { DEFAULT_ROLES, invalidate } = require('../../src/services/roleService');
const { allowAll, fullPermissionMap } = require('../../src/config/permissions');
const Role = require('../../src/models/roleModel');
const Contact = require('../../src/models/contactModel');
const Lead = require('../../src/models/leadModel');
const LeaveRequest = require('../../src/models/leaveRequestModel');
const PackageOrder = require('../../src/gymfolio/models/packageOrderModel');
const PackageRegistration = require('../../src/gymfolio/models/packageRegistrationModel');
const Asset = require('../../src/accounts/models/assetModel');
const bell = require('../../src/controller/adminNotificationsController');

const permissionsOf = (slug) => fullPermissionMap(DEFAULT_ROLES.find((role) => role.slug === slug).permissions);
const keysOf = (items) => items.map((item) => item.key);

test('a follow-up is due on or before the gym\'s today, read as the date the input stored', () => {
  const cutoff = bell.followUpCutoff('2026-09-21');
  assert.equal(cutoff.toISOString(), '2026-09-22T00:00:00.000Z');
  // A date input's "21 Sep" is stored as midnight UTC on the 21st.
  assert.ok(new Date('2026-09-21') < cutoff, 'today is due');
  assert.ok(new Date('2026-09-02') < cutoff, 'overdue is due');
  assert.ok(!(new Date('2026-09-22') < cutoff), 'tomorrow is not');
  assert.equal(bell.followUpCutoff('2026-09-30').toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(bell.followUpCutoff('2026-12-31').toISOString(), '2027-01-01T00:00:00.000Z');
});

test('each role is told only about the tabs it can open', () => {
  assert.deepEqual(keysOf(bell.visibleChecks(allowAll())), [
    'failed_payments', 'bank_transfers', 'contact_queries', 'registrations', 'lead_follow_ups', 'leave_requests', 'expiring_memberships',
    'asset_services_due', 'asset_warranties_ending'
  ]);
  assert.deepEqual(keysOf(bell.visibleChecks(permissionsOf('receptionist'))), [
    'failed_payments', 'bank_transfers', 'contact_queries', 'registrations', 'lead_follow_ups', 'expiring_memberships'
  ]);
  assert.deepEqual(keysOf(bell.visibleChecks(permissionsOf('accountant'))), [
    'failed_payments', 'bank_transfers', 'registrations', 'leave_requests', 'expiring_memberships',
    'asset_services_due', 'asset_warranties_ending'
  ]);
  assert.deepEqual(keysOf(bell.visibleChecks(permissionsOf('trainer'))), []);
  assert.deepEqual(keysOf(bell.visibleChecks(fullPermissionMap())), []);
});

test('only items with something waiting are sent, in the bell\'s order', () => {
  const checks = bell.CHECKS.slice(0, 4);
  const items = bell.presentItems(checks, [0, 3, undefined, 2]);
  assert.deepEqual(items, [
    {
      key: 'bank_transfers',
      label: 'Bank transfers to confirm',
      count: 3,
      href: '/admin/package-orders?status=pending&paymentStatus=processing&paymentMethod=bank_transfer'
    },
    { key: 'registrations', label: 'Registrations to follow up', count: 2, href: '/admin/package-registrations?status=pending' }
  ]);
  assert.deepEqual(bell.presentItems(checks, [0, 0, 0, 0]), []);
});

test('each item opens its page filtered to what it counted, where the page can filter', () => {
  const hrefs = Object.fromEntries(bell.CHECKS.map((check) => [check.key, check.href]));
  assert.deepEqual(hrefs, {
    failed_payments: '/admin/package-orders?status=past_due',
    bank_transfers: '/admin/package-orders?status=pending&paymentStatus=processing&paymentMethod=bank_transfer',
    contact_queries: '/admin/contact-queries?status=new',
    registrations: '/admin/package-registrations?status=pending',
    // The board's "due for follow-up" filter (leadController.list ?due=1).
    lead_follow_ups: '/admin/leads?due=1',
    leave_requests: '/admin/staff/leave?status=pending',
    // The orders list has no end-date filter yet.
    expiring_memberships: '/admin/package-orders',
    // The asset register's own filters (assetController.list), which apply
    // the same rule (accounts/services/assetReminders.js).
    asset_services_due: '/admin/accounts?tab=assets&service=due',
    asset_warranties_ending: '/admin/accounts?tab=assets&warranty=ending'
  });
});

// ---------------------------------------------------------------------------
// The handler, against stubbed models on a tenant connection
// ---------------------------------------------------------------------------

let gymCounter = 0;
const nextGym = () => {
  gymCounter += 1;
  return {
    _id: `00000000000000000000b${String(gymCounter).padStart(3, '0')}`,
    slug: `unit-bell-${gymCounter}`,
    database: { name: `gympilot_unit_bell_${gymCounter}` },
    domains: [],
    locale: { timezone: 'Asia/Karachi' }
  };
};

function respond() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function stubModels(seen, { failContacts = false } = {}) {
  Role.find = () => ({ lean: async () => DEFAULT_ROLES.map((role) => ({ ...role, isActive: true })) });
  invalidate();
  // The expiry sweep the handler runs first.
  PackageOrder.updateMany = async () => ({ modifiedCount: 0 });
  PackageOrder.countDocuments = async (filter) => {
    seen.orders.push(filter);
    return filter.status === 'past_due' ? 1 : 4;
  };
  PackageOrder.aggregate = async (stages) => {
    seen.expiring = stages[0].$match;
    return [{ n: 2 }];
  };
  Contact.countDocuments = async () => {
    if (failContacts) throw new Error('boom');
    return 5;
  };
  PackageRegistration.countDocuments = async () => 0;
  Lead.countDocuments = async (filter) => {
    seen.leads = filter;
    return 6;
  };
  LeaveRequest.countDocuments = async (filter) => {
    seen.leave = filter;
    return 1;
  };
  Asset.countDocuments = async (filter) => {
    (seen.assets = seen.assets || []).push(filter);
    return assetCounts(filter);
  };
}

// Nothing waiting on the equipment unless a test says otherwise.
let assetCounts = () => 0;

test('the handler counts what a receptionist may see and leaves out the zeros', async () => {
  await runWithTenant(nextGym(), async () => {
    const seen = { orders: [] };
    stubModels(seen);
    const res = respond();
    await bell.list({ roleSlug: 'receptionist' }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    // No registrations waiting; no Staff tab, so no leave requests at all.
    assert.deepEqual(keysOf(res.body.data), ['failed_payments', 'bank_transfers', 'contact_queries', 'lead_follow_ups', 'expiring_memberships']);
    assert.deepEqual(res.body.data.map((item) => item.count), [1, 4, 5, 6, 2]);
    assert.equal(res.body.total, 18);
    assert.equal(seen.leave, undefined);

    const transfers = seen.orders.find((filter) => filter['payment.method'] === 'bank_transfer');
    assert.equal(transfers['payment.status'], 'processing');
    assert.deepEqual(transfers['payment.proof.uploadedAt'], { $ne: null });
    assert.deepEqual(seen.leads.isActive, { $ne: false });
    assert.deepEqual(seen.leads.status, { $nin: ['won', 'lost'] });
    assert.equal(seen.leads.nextFollowUpAt.$ne, null);
    assert.ok(seen.leads.nextFollowUpAt.$lt instanceof Date);
    // Live memberships ending inside the week.
    assert.equal(seen.expiring['payment.status'], 'paid');
    const window = seen.expiring['subscription.endDate'];
    assert.equal(Math.round((window.$lt - window.$gte) / 86400000), bell.EXPIRING_WINDOW_DAYS);
  });
});

test('a count that fails costs its own item, not the bell', async () => {
  await runWithTenant(nextGym(), async () => {
    const seen = { orders: [] };
    stubModels(seen, { failContacts: true });
    const res = respond();
    const logged = console.error;
    console.error = () => {};
    try {
      await bell.list({ roleSlug: 'admin' }, res);
    } finally {
      console.error = logged;
    }

    assert.equal(res.statusCode, 200);
    assert.deepEqual(keysOf(res.body.data), ['failed_payments', 'bank_transfers', 'lead_follow_ups', 'leave_requests', 'expiring_memberships']);
    assert.deepEqual(seen.leave, { status: 'pending' });
  });
});

test('a role with none of the tabs gets an empty bell', async () => {
  await runWithTenant(nextGym(), async () => {
    stubModels({ orders: [] });
    const res = respond();
    await bell.list({ roleSlug: 'trainer' }, res);
    assert.deepEqual(res.body, { success: true, data: [], total: 0 });
  });
});

test('an accountant is told about equipment services due and warranties ending, counted by the register\'s rule', async () => {
  await runWithTenant(nextGym(), async () => {
    const seen = { orders: [] };
    stubModels(seen);
    assetCounts = (filter) => (filter.nextServiceDue ? 3 : 2);
    try {
      const res = respond();
      await bell.list({ roleSlug: 'accountant' }, res);
      assert.equal(res.statusCode, 200);
      const items = Object.fromEntries(res.body.data.map((item) => [item.key, item]));
      assert.equal(items.asset_services_due.count, 3);
      assert.equal(items.asset_services_due.label, 'Equipment services due within 7 days or overdue');
      assert.equal(items.asset_warranties_ending.count, 2);
      assert.equal(items.asset_warranties_ending.label, 'Equipment warranties ending within 30 days');

      const [service, warranty] = seen.assets;
      // Equipment still in use, due inside the week or already overdue.
      assert.deepEqual(service.status, { $nin: ['retired', 'sold', 'lost'] });
      assert.equal(service.nextServiceDue.$ne, null);
      assert.ok(service.nextServiceDue.$lt instanceof Date);
      // Warranties that have not ended and end inside the month.
      const window = warranty.warrantyUntil;
      assert.equal(Math.round((window.$lt - window.$gte) / 86400000), 30);
    } finally {
      assetCounts = () => 0;
    }
  });
});
