// The admin header's search: which areas a role may search, how the query is
// built, and what the dropdown is sent. No database -- the models are
// stubbed on a tenant connection that never connects.
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
const User = require('../../src/models/user');
const Lead = require('../../src/models/leadModel');
const Role = require('../../src/models/roleModel');
const PackageOrder = require('../../src/gymfolio/models/packageOrderModel');
const GymClass = require('../../src/gymfolio/models/gymClassModel');
const Trainer = require('../../src/gymfolio/models/trainerModel');
const search = require('../../src/controller/adminSearchController');

const permissionsOf = (slug) => fullPermissionMap(DEFAULT_ROLES.find((role) => role.slug === slug).permissions);
const keysOf = (groups) => groups.map((group) => group.key);

test('a query shorter than two characters is not searched', () => {
  assert.equal(search.readTerms(''), null);
  assert.equal(search.readTerms('  a  '), null);
  assert.equal(search.readTerms(undefined), null);
  assert.deepEqual(search.readTerms(' jo '), ['jo']);
});

test('a query is split into at most four words, each kept to a sane length', () => {
  assert.deepEqual(search.readTerms('jo   smith'), ['jo', 'smith']);
  assert.deepEqual(search.readTerms('a b c d e f'), ['a', 'b', 'c', 'd']);
  assert.equal(search.readTerms('x'.repeat(200))[0].length, 80);
});

test('every word must match some field, and regex characters are taken literally', () => {
  const filter = search.termsFilter(['jo', 'a.b('], ['firstName', 'email']);
  assert.equal(filter.$and.length, 2);
  const [first, second] = filter.$and;
  assert.deepEqual(first.$or.map((clause) => Object.keys(clause)[0]), ['firstName', 'email']);
  const rx = second.$or[0].firstName;
  assert.ok(rx instanceof RegExp);
  assert.equal(rx.flags, 'i');
  assert.ok(rx.test('A.B('));
  assert.ok(!rx.test('axb('), 'the dot is not a wildcard');
});

test('a group keeps its own filter under the terms', () => {
  const members = search.GROUPS.find((group) => group.key === 'members');
  const staff = search.GROUPS.find((group) => group.key === 'staff');
  assert.equal(search.groupFilter(members, ['jo']).role, 'user');
  assert.equal(search.groupFilter(staff, ['jo'])['employment.isStaff'], true);
  assert.ok(Array.isArray(search.groupFilter(members, ['jo']).$and));
});

test('each role searches only the areas it can open', () => {
  assert.deepEqual(keysOf(search.searchableGroups(allowAll())), ['members', 'staff', 'leads', 'orders', 'classes', 'trainers']);
  assert.deepEqual(keysOf(search.searchableGroups(permissionsOf('receptionist'))), ['members', 'leads', 'orders', 'classes', 'trainers']);
  assert.deepEqual(keysOf(search.searchableGroups(permissionsOf('trainer'))), ['classes', 'trainers']);
  assert.deepEqual(keysOf(search.searchableGroups(permissionsOf('accountant'))), ['staff', 'orders']);
  assert.deepEqual(keysOf(search.searchableGroups(permissionsOf('cleaner'))), []);
  assert.deepEqual(keysOf(search.searchableGroups(fullPermissionMap())), []);
});

test('a group shows five results and says when there are more', () => {
  const members = search.GROUPS.find((group) => group.key === 'members');
  const rows = Array.from({ length: search.PER_GROUP + 1 }, (_, i) => ({
    _id: { toString: () => `id${i}` },
    firstName: 'Jo',
    lastName: `Smith ${i}`,
    email: `jo${i}@example.com`,
    memberCode: `M-${i}`,
    phone: '',
    isActive: i !== 0
  }));

  const answer = search.presentGroup(members, rows);
  assert.equal(answer.key, 'members');
  assert.equal(answer.href, '/admin/users');
  assert.equal(answer.results.length, search.PER_GROUP);
  assert.equal(answer.has_more, true);
  assert.deepEqual(answer.results[0], {
    id: 'id0',
    label: 'Jo Smith 0',
    sublabel: 'M-0 · jo0@example.com · disabled',
    href: '/admin/users?id=id0'
  });
  assert.equal(search.presentGroup(members, rows.slice(0, 2)).has_more, false);
});

test('orders read as number and customer, with the package and status beneath', () => {
  const orders = search.GROUPS.find((group) => group.key === 'orders');
  const [row] = search.presentGroup(orders, [
    { _id: 'o1', orderNumber: 'PKG260900012', customerInfo: { fullName: 'Ada Lovelace', email: 'ada@example.com' }, packageDetails: { name: 'Gold' }, status: 'past_due' }
  ]).results;
  assert.equal(row.label, 'PKG260900012 · Ada Lovelace');
  assert.equal(row.sublabel, 'Gold · Past due');
  assert.equal(row.href, '/admin/package-orders?id=o1');
});

test('every result opens its own record on the page it lives on', () => {
  const group = (key) => search.GROUPS.find((g) => g.key === key);
  assert.equal(search.hrefFor(group('members'), { _id: 'u1' }), '/admin/users?id=u1');
  assert.equal(search.hrefFor(group('staff'), { _id: 'u2' }), '/admin/staff?id=u2');
  assert.equal(search.hrefFor(group('orders'), { _id: 'o1' }), '/admin/package-orders?id=o1');
  assert.equal(search.hrefFor(group('classes'), { _id: 'c1' }), '/admin/classes?id=c1');
  assert.equal(search.hrefFor(group('trainers'), { _id: 't1' }), '/admin/trainers?id=t1');
  // An ObjectId is written out as its hex string.
  assert.equal(search.hrefFor(group('members'), { _id: { toString: () => 'abc123' } }), '/admin/users?id=abc123');
});

test('a lead opens by its id alone: the board fetches it, whichever page it is on', () => {
  const leads = search.GROUPS.find((g) => g.key === 'leads');
  assert.equal(search.hrefFor(leads, { _id: 'l1', email: 'ann+gym@example.com', phone: '0770' }), '/admin/leads?id=l1');
  assert.equal(search.hrefFor(leads, { _id: 'l2', phone: '+44 7700 900123' }), '/admin/leads?id=l2');
  assert.equal(search.hrefFor(leads, { _id: 'l3', firstName: 'Ann', lastName: 'Smith' }), '/admin/leads?id=l3');
  assert.equal(search.hrefFor(leads, { _id: { toString: () => 'abc123' } }), '/admin/leads?id=abc123');
});

// ---------------------------------------------------------------------------
// The handler, against stubbed models on a tenant connection
// ---------------------------------------------------------------------------

let gymCounter = 0;
const nextGym = () => {
  gymCounter += 1;
  return {
    _id: `00000000000000000000a${String(gymCounter).padStart(3, '0')}`,
    slug: `unit-search-${gymCounter}`,
    database: { name: `gympilot_unit_search_${gymCounter}` },
    domains: [],
    locale: { timezone: 'Europe/London' }
  };
};

function chain(rows, seen) {
  const q = {
    select: () => q,
    sort: () => q,
    limit: (n) => {
      seen.limit = n;
      return q;
    },
    lean: async () => rows
  };
  return q;
}

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

async function stubModels(seen, { failTrainers = false } = {}) {
  Role.find = () => ({ lean: async () => DEFAULT_ROLES.map((role) => ({ ...role, isActive: true })) });
  invalidate();
  User.find = (filter) => {
    seen.userFilters.push(filter);
    if (filter.role === 'user') return chain([{ _id: 'u1', firstName: 'Jo', lastName: 'Member', email: 'jo@example.com', memberCode: 'M-1' }], seen);
    return chain([{ _id: 'u2', firstName: 'Jo', lastName: 'Staff', email: 'jo.staff@example.com', employment: { jobTitle: 'Coach' } }], seen);
  };
  Lead.find = () => chain([], seen);
  PackageOrder.find = () => chain([{ _id: 'o1', orderNumber: 'PKG1', customerInfo: { fullName: 'Jo Buyer' }, packageDetails: { name: 'Gold' }, status: 'active' }], seen);
  GymClass.find = () => chain([{ _id: 'c1', name: 'Jolly Yoga', category: 'Yoga' }], seen);
  Trainer.find = () => {
    if (failTrainers) throw new Error('boom');
    return chain([{ _id: 't1', name: 'Jo Trainer', role: 'Head coach' }], seen);
  };
}

test('the handler answers a receptionist from its tabs only, empty groups left out', async () => {
  await runWithTenant(nextGym(), async () => {
    const seen = { userFilters: [] };
    await stubModels(seen);
    const res = respond();
    await search.search({ query: { q: ' jo ' }, roleSlug: 'receptionist' }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.query, 'jo');
    // No Staff tab: no staff search at all. No leads matched: no Leads group.
    assert.deepEqual(keysOf(res.body.groups), ['members', 'orders', 'classes', 'trainers']);
    assert.equal(seen.userFilters.length, 1);
    assert.equal(seen.userFilters[0].role, 'user');
    assert.equal(seen.limit, search.PER_GROUP + 1);
    assert.equal(res.body.groups[0].results[0].label, 'Jo Member');
    assert.equal(res.body.groups[0].results[0].href, '/admin/users?id=u1');
  });
});

test('an administrator searches everything; one area failing leaves the rest', async () => {
  await runWithTenant(nextGym(), async () => {
    const seen = { userFilters: [] };
    await stubModels(seen, { failTrainers: true });
    const res = respond();
    const logged = console.error;
    console.error = () => {};
    try {
      await search.search({ query: { q: 'jo' }, roleSlug: 'admin' }, res);
    } finally {
      console.error = logged;
    }

    assert.equal(res.statusCode, 200);
    assert.deepEqual(keysOf(res.body.groups), ['members', 'staff', 'orders', 'classes']);
    assert.equal(res.body.groups[1].results[0].sublabel, 'Coach · jo.staff@example.com');
  });
});

test('a one-letter query answers empty without touching the database', async () => {
  const res = respond();
  await search.search({ query: { q: 'j' }, roleSlug: 'admin' }, res);
  assert.deepEqual(res.body, { success: true, query: 'j', groups: [] });
});
