// The Leads board's "due for follow-up" filter (the admin bell links to it)
// and the one-lead fetch behind the header search's links. No database: the
// models are stubbed inside a tenant context.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const T = require('../../src/attendance/services/timeUtils');
const Lead = require('../../src/models/leadModel');
const User = require('../../src/models/user');
const leads = require('../../src/controller/leadController');
const bell = require('../../src/controller/adminNotificationsController');

let gymCounter = 0;
const gymIn = (timezone) => {
  gymCounter += 1;
  return {
    _id: `0000000000000000000000${String(gymCounter).padStart(2, '0')}`,
    slug: `unit-leads-due-${gymCounter}`,
    database: { name: `gympilot_unit_leads_due_${gymCounter}` },
    domains: [],
    locale: { timezone }
  };
};

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

/** Replaces model statics for the length of `fn`, inside the gym's context. */
function withStubs(gym, stubs, fn) {
  return runWithTenant(gym, async () => {
    const originals = stubs.map(([model, name]) => [model, name, model[name]]);
    for (const [model, name, impl] of stubs) model[name] = impl;
    try {
      return await fn();
    } finally {
      for (const [model, name, original] of originals) model[name] = original;
    }
  });
}

function listStubs(seen, rows = []) {
  const query = {
    sort(s) {
      seen.sort = s;
      return this;
    },
    skip() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => rows
  };
  return [
    [Lead, 'find', (filter) => ((seen.filter = filter), query)],
    [Lead, 'countDocuments', async (filter) => ((seen.countFilter = filter), rows.length)],
    [Lead, 'aggregate', async (stages) => ((seen.counts = stages[0].$match), [{ _id: 'new', n: 1 }])]
  ];
}

/** The list's filter for `query`, and today's date key, at a gym in `timezone`. */
async function listFilter(query, timezone = 'UTC') {
  const seen = {};
  const res = fakeRes();
  await withStubs(gymIn(timezone), listStubs(seen), async () => {
    await leads.list({ query }, res);
    seen.today = T.dateKey();
  });
  assert.equal(res.statusCode, 200);
  return seen;
}

/* ------------------------------- what "due" means ------------------------------ */

test('a follow-up is due when the lead is still being worked and its date is today at the gym or earlier', () => {
  assert.deepEqual(leads.followUpDueFilter('2026-09-21'), {
    isActive: { $ne: false },
    status: { $nin: ['won', 'lost'] },
    nextFollowUpAt: { $ne: null, $lt: new Date('2026-09-22T00:00:00.000Z') }
  });
  // A date input's "21 Sep" is stored as midnight UTC on the 21st.
  const cutoff = leads.followUpCutoff('2026-09-21');
  assert.ok(new Date('2026-09-21') < cutoff, 'today is due');
  assert.ok(!(new Date('2026-09-22') < cutoff), 'tomorrow is not');
});

test('the bell counts exactly what the board\'s due filter lists, and links to it', async () => {
  assert.equal(bell.followUpCutoff, leads.followUpCutoff, 'one rule, not two copies');
  const check = bell.CHECKS.find((c) => c.key === 'lead_follow_ups');
  assert.equal(check.href, '/admin/leads?due=1');

  let counted = null;
  let listed = null;
  await withStubs(gymIn('Asia/Karachi'), [[Lead, 'countDocuments', async (filter) => ((counted = filter), 0)]], async () => {
    await check.count(new Date());
    listed = leads.followUpDueFilter();
  });
  assert.deepEqual(counted, listed);
});

/* --------------------------------- the list ---------------------------------- */

test('due=1 lists the due leads, by the gym\'s own today', async () => {
  const seen = await listFilter({ due: '1' }, 'Europe/London');
  assert.deepEqual(seen.filter, leads.followUpDueFilter(seen.today));
  assert.deepEqual(seen.countFilter, seen.filter, 'the total counts what the page lists');
  assert.deepEqual(seen.sort, { nextFollowUpAt: 1, createdAt: -1, _id: -1 }, 'most overdue first, as before');
  assert.deepEqual(seen.counts, { isActive: { $ne: false } }, 'the stage counts stay board-wide');

  // UTC+14 and UTC-10 are a whole day apart at every moment, so the gym's
  // zone (not the server's) must be what decides "today".
  const east = await listFilter({ due: '1' }, 'Pacific/Kiritimati');
  const west = await listFilter({ due: '1' }, 'Pacific/Honolulu');
  assert.equal(east.filter.nextFollowUpAt.$lt - west.filter.nextFollowUpAt.$lt, 86400000);
});

test('due=true works too; anything else, or nothing, is the whole board', async () => {
  const yes = await listFilter({ due: 'true' });
  assert.ok(yes.filter.nextFollowUpAt);
  for (const due of [undefined, '', '0', 'no', ['1', '1']]) {
    const seen = await listFilter({ due, status: 'won' });
    assert.deepEqual(seen.filter, { isActive: { $ne: false }, status: 'won' }, `due=${JSON.stringify(due)}`);
  }
});

test('with due=1 a stage narrows the open leads, a closed stage finds none, and search still applies', async () => {
  const trial = await listFilter({ due: '1', status: 'trial', search: 'ann' });
  assert.deepEqual(trial.filter.status, { $nin: ['won', 'lost'], $eq: 'trial' });
  assert.ok(trial.filter.nextFollowUpAt.$lt instanceof Date);
  assert.equal(trial.filter.$and.length, 1, 'the search words are still matched');

  const won = await listFilter({ due: '1', status: 'won' });
  // Both conditions on the one field: nothing is 'won' and not won.
  assert.deepEqual(won.filter.status, { $nin: ['won', 'lost'], $eq: 'won' });

  const bogus = await listFilter({ due: '1', status: 'nonsense' });
  assert.deepEqual(bogus.filter.status, { $nin: ['won', 'lost'] }, 'an unknown stage is ignored');
});

/* ------------------------------- one lead by id ------------------------------ */

test('one lead comes back as the list shows it, assignee name included', async () => {
  const staffId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();
  const row = { _id: leadId, firstName: 'Ann', lastName: 'Lee', source: 'website', status: 'contacted', assignedTo: staffId, notes: [], tags: ['pt'] };
  const seen = {};
  const res = fakeRes();
  await withStubs(
    gymIn('UTC'),
    [
      [Lead, 'findOne', (filter) => ((seen.filter = filter), { lean: async () => row })],
      [User, 'find', () => ({ select: () => ({ lean: async () => [{ _id: staffId, firstName: 'Sam', lastName: 'Coach' }] }) })]
    ],
    () => leads.getOne({ params: { id: String(leadId) } }, res)
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(seen.filter, { _id: String(leadId), isActive: { $ne: false } }, 'a hidden lead is not found');
  assert.equal(res.body.data.id, String(leadId));
  assert.equal(res.body.data.name, 'Ann Lee');
  assert.equal(res.body.data.status, 'contacted');
  assert.equal(res.body.data.assigned_to, String(staffId));
  assert.equal(res.body.data.assigned_name, 'Sam Coach');
  assert.deepEqual(res.body.data.tags, ['pt']);
});

test('a lead that is not there, or an id that could not be one, is a 404; a failure is a 500', async () => {
  const bad = fakeRes();
  await withStubs(gymIn('UTC'), [[Lead, 'findOne', () => assert.fail('no lookup for a malformed id')]], () =>
    leads.getOne({ params: { id: 'not-an-id' } }, bad)
  );
  assert.equal(bad.statusCode, 404);
  assert.equal(bad.body.message, 'Lead not found');

  const gone = fakeRes();
  await withStubs(gymIn('UTC'), [[Lead, 'findOne', () => ({ lean: async () => null })]], () =>
    leads.getOne({ params: { id: String(new mongoose.Types.ObjectId()) } }, gone)
  );
  assert.equal(gone.statusCode, 404);

  const broken = fakeRes();
  const logged = console.error;
  console.error = () => {};
  try {
    await withStubs(gymIn('UTC'), [[Lead, 'findOne', () => ({ lean: async () => Promise.reject(new Error('down')) })]], () =>
      leads.getOne({ params: { id: String(new mongoose.Types.ObjectId()) } }, broken)
    );
  } finally {
    console.error = logged;
  }
  assert.equal(broken.statusCode, 500);
  assert.equal(broken.body.success, false);
});

test('the route: GET /admin/leads/:id is behind auth and the leads gate, like the list', () => {
  const router = require('../../src/routes/allRoutes');
  const auth = require('../../src/middleware/auth');
  const route = (method, path) => {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    assert.ok(layer, `${method} ${path} is mounted`);
    return layer.route.stack.map((entry) => entry.handle);
  };

  const one = route('get', '/admin/leads/:id');
  assert.equal(one.length, 3);
  assert.equal(one[0], auth, 'auth first');
  assert.equal(one[1].name, 'permissionGate', 'then the permission gate');
  assert.equal(one[2], leads.getOne);

  const list = route('get', '/admin/leads');
  assert.equal(list[0], auth);
  assert.equal(list[1].name, 'permissionGate');
  assert.equal(list[2], leads.list);
});
