// Member IDs from the moment an account exists, against a real MongoDB: the
// admin form, the sign-up form, a converted lead and the CSV import all hand
// out the next "GP-0000" in the gym's one series; staff are left out; two
// members made at the same instant still get two IDs; and the Users list
// carries the ID and the phone number and finds a member by either.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let Lead;
let users;
let leads;
let importer;
let admin;

const CODE = /^GP-\d{4}$/;

const test = h.suite(async () => {
  User = h.src('models/user');
  Lead = h.src('models/leadModel');
  users = h.src('controller/userController');
  leads = h.src('controller/leadController');
  importer = h.src('controller/userImportController');

  gym = await h.createGym('codes-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, Lead);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@codes.test', role: 'admin', password: await bcrypt.hash('admin-pass-1', 4), employment: { isStaff: true } });
  });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const create = (body) => h.inGym(gym, () => h.call(users.adminCreateUser, { ...as(admin), body }));
const codeOf = (query) => h.inGym(gym, async () => ((await User.findOne(query).select('memberCode').lean()) || {}).memberCode);
const number = (code) => parseInt(String(code).slice(3), 10);

test('a member made from the admin form has an ID straight away, in the response too', async () => {
  const res = await create({ firstName: 'First', lastName: 'Member', email: 'first@codes.test', phone: '0700 000001' });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.match(res.body.data.memberCode, CODE);
  assert.equal(await codeOf({ email: 'first@codes.test' }), res.body.data.memberCode);
  assert.equal(await codeOf({ _id: admin._id }), null, 'the administrator is not a member');

  const next = await create({ firstName: 'Second', lastName: 'Member', phone: '0700 000002' });
  assert.equal(number(next.body.data.memberCode), number(res.body.data.memberCode) + 1, 'the next one in the series');
});

test('staff are not given a member ID', async () => {
  const res = await create({ firstName: 'Rae', lastName: 'Desk', email: 'rae@codes.test', role: 'receptionist' });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.memberCode, null);
});

test('signing up online (checkout signs people up this way) gives an ID', async () => {
  const res = await h.inGym(gym, () =>
    h.call(users.createUser, { body: { firstName: 'Web', lastName: 'Signup', email: 'web@codes.test', password: 'web-password-1' } })
  );
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.match(res.body.data.memberCode, CODE);
});

test('a lead converted into a member gets an ID', async () => {
  const notify = h.src('services/gymNotifications');
  const stubbed = notify.brand;
  notify.brand = async () => ({ siteName: 'Codes Gym', accountUrl: 'https://codes-gym.test/user-detail' });
  try {
    const lead = await h.inGym(gym, () => Lead.create({ firstName: 'Lena', lastName: 'Lead', email: 'lena@codes.test' }));
    const res = await h.inGym(gym, () => h.call(leads.convert, { ...as(admin), params: { id: String(lead._id) } }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(await codeOf({ email: 'lena@codes.test' }), CODE);
  } finally {
    notify.brand = stubbed;
  }
});

test('the import keeps a free ID from the old system and gives everyone else the next one', async () => {
  // An old system's odd code must not restart the series.
  await h.inGym(gym, () => User.create({ firstName: 'Odd', lastName: 'Code', email: 'odd@codes.test', memberCode: 'GP-A12' }));
  const before = number(await codeOf({ email: 'web@codes.test' }));

  const file = [
    'firstName,lastName,email,phone,memberCode',
    'Kept,Code,kept@codes.test,,GP-0500',
    'Fresh,Code,fresh@codes.test,,',
    'Clash,Code,clash@codes.test,,GP-0500'
  ].join('\n');
  const res = await h.inGym(gym, () =>
    h.call(importer.importCsv, { ...as(admin), file: { buffer: Buffer.from(file) }, body: { dryRun: '0' } })
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.created, 3);

  assert.equal(await codeOf({ email: 'kept@codes.test' }), 'GP-0500');
  const fresh = await codeOf({ email: 'fresh@codes.test' });
  const clash = await codeOf({ email: 'clash@codes.test' });
  assert.match(fresh, CODE);
  assert.match(clash, CODE);
  assert.ok(number(fresh) > before, 'carries on the series');
  assert.notEqual(clash, 'GP-0500');
  assert.notEqual(fresh, clash);
});

test('two members created at the same instant get two different IDs', async () => {
  const results = await Promise.all(
    ['Twin', 'Other'].map((firstName) => create({ firstName, lastName: 'Race', phone: `0700 ${firstName}` }))
  );
  const codes = results.map((res) => res.body.data.memberCode);
  for (const code of codes) assert.match(code, CODE);
  assert.notEqual(codes[0], codes[1]);
});

test('the Users list carries the ID and phone, and finds a member by either', async () => {
  const code = await codeOf({ firstName: 'Second' });
  // getAllUsers reads the caller from the Authorization header itself.
  const token = require('jsonwebtoken').sign({ id: String(admin._id), role: 'admin' }, process.env.JWT_SECRET);
  const call = (query) => h.inGym(gym, () => h.call(users.getAllUsers, { query, headers: { authorization: `Bearer ${token}` } }));

  const all = await call({});
  assert.equal(all.statusCode, 200, JSON.stringify(all.body));
  const second = all.body.data.find((u) => u.firstName === 'Second');
  assert.equal(second.memberCode, code);
  assert.equal(second.phone, '0700 000002');

  const byCode = await call({ search: code.toLowerCase(), page: '1', limit: '10' });
  assert.deepEqual(byCode.body.data.map((u) => u.firstName), ['Second']);
  const byPhone = await call({ search: '0700 000002' });
  assert.deepEqual(byPhone.body.data.map((u) => u.firstName), ['Second']);
});

test('a code imported in another width does not stop the series', async () => {
  // "GP-101" from an old system beside the series' own "GP-0102".."GP-0104":
  // as strings "GP-101" is the highest, so every try at the next code used
  // to land on a taken one and the member was left with none.
  await h.inGym(gym, async () => {
    await User.create({ firstName: 'Old', lastName: 'Width', phone: '0700 000101', memberCode: 'GP-101' });
    for (const memberCode of ['GP-0102', 'GP-0103', 'GP-0104']) {
      await User.create({ firstName: 'Taken', lastName: memberCode, phone: `0700 ${memberCode}`, memberCode });
    }
  });
  const highest = Math.max(
    ...(await h.inGym(gym, () => User.find({ memberCode: /^GP-\d+$/ }).select('memberCode').lean())).map((u) => number(u.memberCode))
  );

  const res = await create({ firstName: 'After', lastName: 'Import', phone: '0700 000105' });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.match(res.body.data.memberCode || '', CODE);
  assert.equal(number(res.body.data.memberCode), highest + 1, 'the next number after the highest, whatever its width');
});
