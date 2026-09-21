// Website enquiries into the lead pipeline, and the leads list's paging.
// No database: the models are stubbed inside a tenant context.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const Lead = require('../../src/models/leadModel');
const User = require('../../src/models/user');
const leads = require('../../src/controller/leadController');

const gym = { _id: '0000000000000000000000c1', slug: 'unit-leads', database: { name: 'gympilot_unit_leads' }, locale: { timezone: 'UTC' } };

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
function withStubs(stubs, fn) {
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

/* --------------------------------- validation --------------------------------- */

test('a complete enquiry is trimmed and normalised', () => {
  const result = leads.validatePublicLead({ name: '  Ann Marie  Smith ', email: ' Ann@Example.COM ', phone: ' 07700 900000 ', page: '/classes' });
  assert.equal(result.spam, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.data, { name: 'Ann Marie  Smith', email: 'ann@example.com', phone: '07700 900000', interest: '', message: '', page: '/classes' });
});

test('a filled honeypot is spam, whatever else was sent', () => {
  const result = leads.validatePublicLead({ name: 'Bot', email: 'bot@example.com', website: 'http://spam.example' });
  assert.equal(result.spam, true);
  assert.equal(result.data, null);
});

test('a name and one way to reach them is all that is required', () => {
  assert.deepEqual(leads.validatePublicLead({ phone: '0770' }).errors, ['Please tell us your name']);
  assert.deepEqual(leads.validatePublicLead({ name: 'Ann' }).errors, ['Please give an email address or phone number']);
  assert.deepEqual(leads.validatePublicLead({ name: 'Ann', email: 'not-an-email', phone: '0770' }).errors, ['Please enter a valid email address']);
  assert.deepEqual(leads.validatePublicLead({ name: 'Ann', phone: '0770' }).errors, [], 'phone alone will do');
  assert.equal(leads.validatePublicLead({ firstName: 'Ann', lastName: 'Lee', email: 'a@b.co' }).data.name, 'Ann Lee');
});

test('over-long fields are cut, not rejected, and non-strings are ignored', () => {
  const result = leads.validatePublicLead({ name: 'A'.repeat(500), email: 'a@b.co', phone: { $gt: '' }, message: 42 });
  assert.equal(result.data.name.length, 160);
  assert.equal(result.data.phone, '');
  assert.equal(result.data.message, '');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(leads.validatePublicLead(null).errors.length, 2);
});

test('a full name splits into first and last', () => {
  assert.deepEqual(leads.splitName('Ann Marie Smith'), { firstName: 'Ann', lastName: 'Marie Smith' });
  assert.deepEqual(leads.splitName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(leads.splitName(''), { firstName: 'Enquiry', lastName: '' });
});

/* --------------------------------- the endpoint -------------------------------- */

test('a new enquiry becomes a website lead with a note saying where it came from', async () => {
  const seen = {};
  const res = fakeRes();
  await withStubs(
    [
      [Lead, 'findOne', async (filter) => ((seen.match = filter), null)],
      [User, 'exists', async () => null],
      [Lead, 'create', async (doc) => ((seen.created = doc), { _id: 'x', ...doc })]
    ],
    () => leads.publicEnquiry({ body: { name: 'Ann Marie Smith', email: 'ANN@example.com', phone: '0770', page: '/classes', message: 'Evening classes?' } }, res)
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.deepEqual(seen.match, { $or: [{ email: 'ann@example.com' }, { phone: '0770' }], status: { $nin: ['won', 'lost'] } });
  assert.equal(seen.created.source, 'website');
  assert.equal(seen.created.firstName, 'Ann');
  assert.equal(seen.created.lastName, 'Marie Smith');
  assert.equal(seen.created.email, 'ann@example.com');
  assert.equal(seen.created.phone, '0770');
  assert.equal(seen.created.notes.length, 1);
  assert.equal(seen.created.notes[0].text, 'Website enquiry (/classes): Evening classes?');
  assert.equal(seen.created.notes[0].byName, 'Website');
  assert.equal('status' in seen.created, false, 'a new lead starts at the model default, "new"');
  // Due today, as the board's date input stores a day (the gym here is on UTC).
  assert.equal(seen.created.nextFollowUpAt.toISOString(), `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
});

test('a new enquiry brings an open lead\'s follow-up forward to today, never back', async () => {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const cases = [
    [null, today],
    [new Date(today.getTime() + 7 * 86400000), today],
    [new Date(today.getTime() - 3 * 86400000), new Date(today.getTime() - 3 * 86400000)]
  ];
  for (const [before, after] of cases) {
    const lead = { notes: [], nextFollowUpAt: before, save: async () => {} };
    await withStubs([[Lead, 'findOne', async () => lead]], () => leads.publicEnquiry({ body: { name: 'Ann', phone: '0770' } }, fakeRes()));
    assert.equal(lead.nextFollowUpAt.getTime(), after.getTime(), `from ${before && before.toISOString()}`);
  }
});

test('an enquiry from somebody with an open lead is a note on it, and pressing send twice adds one note', async () => {
  const saved = [];
  // A mongoose note array fills in `at` on push; so does this one.
  const notes = [{ text: 'Walk-in', at: new Date(Date.now() - 86400000) }];
  notes.push = (...items) => Array.prototype.push.apply(notes, items.map((n) => ({ at: new Date(), ...n })));
  const lead = {
    notes,
    lastContactedAt: null,
    save: async function () {
      saved.push(this.notes.length);
    }
  };
  const stubs = [
    [Lead, 'findOne', async () => lead],
    [Lead, 'create', async () => assert.fail('no second lead')],
    [User, 'exists', async () => assert.fail('not asked for an open lead')]
  ];
  const body = { name: 'Ann', email: 'ann@example.com', page: '/' };

  const first = fakeRes();
  await withStubs(stubs, () => leads.publicEnquiry({ body }, first));
  const second = fakeRes();
  await withStubs(stubs, () => leads.publicEnquiry({ body }, second));

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.deepEqual(first.body, second.body, 'the visitor is told the same thing either way');
  assert.equal(lead.notes.length, 2);
  assert.equal(lead.notes[1].text, 'Website enquiry (/)');
  assert.ok(lead.lastContactedAt instanceof Date);
  assert.deepEqual(saved, [2], 'the repeat was not saved again');
});

test('an enquiry from an existing member is kept as a lead, marked for staff', async () => {
  let created = null;
  const res = fakeRes();
  await withStubs(
    [
      [Lead, 'findOne', async () => null],
      [User, 'exists', async () => ({ _id: 'u1' })],
      [Lead, 'create', async (doc) => (created = doc)]
    ],
    () => leads.publicEnquiry({ body: { name: 'Ann', email: 'ann@example.com' } }, res)
  );
  assert.equal(res.statusCode, 201);
  assert.match(created.notes[0].text, /already has an account/);
});

test('a bot is thanked and nothing is stored; a bad enquiry is refused in plain words', async () => {
  const untouched = [
    [Lead, 'findOne', async () => assert.fail('no lookup')],
    [Lead, 'create', async () => assert.fail('no create')]
  ];
  const bot = fakeRes();
  await withStubs(untouched, () => leads.publicEnquiry({ body: { name: 'Bot', email: 'b@x.co', website: 'x' } }, bot));
  assert.equal(bot.statusCode, 201);
  assert.equal(bot.body.success, true);

  const bad = fakeRes();
  await withStubs(untouched, () => leads.publicEnquiry({ body: { name: 'Ann' } }, bad));
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.message, 'Please give an email address or phone number');
  assert.doesNotMatch(JSON.stringify(bad.body), /plan|upgrade/i);
});

test('a database failure is a retry message, never a plan or upgrade message', async () => {
  const res = fakeRes();
  const error = console.error;
  console.error = () => {};
  try {
    await withStubs([[Lead, 'findOne', async () => Promise.reject(new Error('down'))]], () =>
      leads.publicEnquiry({ body: { name: 'Ann', phone: '0770' } }, res)
    );
  } finally {
    console.error = error;
  }
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body.message, /plan|upgrade/i);
});

/* ----------------------------------- paging ----------------------------------- */

function listStubs(seen, { rows = [], total = 0 } = {}) {
  const query = {
    sort(s) {
      seen.sort = s;
      return this;
    },
    skip(n) {
      seen.skip = n;
      return this;
    },
    limit(n) {
      seen.limit = n;
      return this;
    },
    lean: async () => rows
  };
  return [
    [Lead, 'find', (filter) => ((seen.filter = filter), query)],
    [Lead, 'countDocuments', async (filter) => ((seen.countFilter = filter), total)],
    [Lead, 'aggregate', async () => [{ _id: 'new', n: 3 }, { _id: 'won', n: 2 }]]
  ];
}

test('the leads list pages by page or skip and says how many there are', async () => {
  const row = { _id: 'l1', firstName: 'Ann', source: 'website', status: 'new', notes: [], tags: [] };

  let seen = {};
  let res = fakeRes();
  await withStubs(listStubs(seen, { rows: [row], total: 250 }), () => leads.list({ query: { limit: '100', page: '3', search: ' ann  s.mith ' } }, res));
  assert.equal(seen.skip, 200);
  assert.equal(seen.limit, 100);
  assert.deepEqual(seen.sort, { nextFollowUpAt: 1, createdAt: -1, _id: -1 });
  assert.deepEqual(seen.countFilter, seen.filter, 'the total counts what the page lists');
  assert.equal(seen.filter.$and.length, 2, 'each word must match somewhere');
  assert.ok(seen.filter.$and[0].$or.some((c) => c.firstName && c.firstName.test('Ann')));
  assert.ok(seen.filter.$and[1].$or.some((c) => c.lastName && c.lastName.test('S.MITH') && !c.lastName.test('Smith')), 'words are matched literally');
  assert.ok(seen.filter.$and[0].$or.some((c) => c.tags), 'search reaches tags too');
  assert.deepEqual(res.body.pagination, { page: 3, limit: 100, skip: 200, total: 250, pages: 3 });
  assert.deepEqual(res.body.counts, { new: 3, won: 2 }, 'the existing fields are unchanged');
  assert.equal(res.body.data[0].name, 'Ann');

  seen = {};
  res = fakeRes();
  await withStubs(listStubs(seen, { total: 0 }), () => leads.list({ query: { limit: '50', skip: '120', page: '9' } }, res));
  assert.equal(seen.skip, 120, 'skip wins over page');
  assert.deepEqual(res.body.pagination, { page: 3, limit: 50, skip: 120, total: 0, pages: 1 });

  seen = {};
  res = fakeRes();
  await withStubs(listStubs(seen), () => leads.list({ query: { limit: '5000', page: '-2' } }, res));
  assert.equal(seen.limit, 1000);
  assert.equal(seen.skip, 0);
  assert.equal(res.body.pagination.page, 1);
});
