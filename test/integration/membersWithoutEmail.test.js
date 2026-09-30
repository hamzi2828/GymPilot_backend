// Members without an email address, against a real MongoDB: created at the
// desk with a phone number instead, as many as a gym likes (the email index
// is unique only when an email is there), never stored as '', never matched
// by an email lookup, never emailed -- and brought in from a spreadsheet with
// a single name column, an address, an active flag, a discount and their
// real joining date. Then the migration that swaps an existing gym's old
// always-unique email index for the new one.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let Package;
let PackageOrder;
let users;
let security;
let importer;
let admin;
let emailIndex;

const test = h.suite(async () => {
  User = h.src('models/user');
  Package = h.src('gymfolio/models/packageModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  users = h.src('controller/userController');
  security = h.src('controller/securityController');
  importer = h.src('controller/userImportController');
  emailIndex = require('../../scripts/lib/emailIndex');

  gym = await h.createGym('no-email-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, PackageOrder);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@noemail.test', role: 'admin', password: await bcrypt.hash('admin-pass-1', 4) });
    await Package.create({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['Gym floor'] });
  });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const create = (body) => h.inGym(gym, () => h.call(users.adminCreateUser, { ...as(admin), body }));
const rawUsers = () => h.rawDb(gym.database.name).collection('users');

function csv(text) {
  return { buffer: Buffer.from(text, 'utf8'), originalname: 'members.csv', mimetype: 'text/csv' };
}
const runImport = (text, dryRun = false) =>
  h.inGym(gym, () => h.call(importer.importCsv, { ...as(admin), file: csv(text), body: { dryRun: dryRun ? '1' : '0' } }));

test('a member can be created with a phone number and no email, and is handed a password', async () => {
  const res = await create({ firstName: 'Nadia', lastName: 'Noemail', phone: '+44 7700 900001' });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  // Nowhere to email it, so it is shown to the admin once.
  assert.equal(res.body.credentials, 'show');
  assert.equal(typeof res.body.password, 'string');
  assert.equal(res.body.emailed, false);

  const stored = await rawUsers().findOne({ firstName: 'Nadia' });
  assert.equal('email' in stored, false, 'no email field at all, never ""');
  assert.equal(stored.phone, '+44 7700 900001');
});

test('any number of members can have no email; an email is still unique', async () => {
  for (const name of ['Omar', 'Priya', 'Quinn']) {
    const res = await create({ firstName: name, lastName: 'Phoneonly', phone: `0700 ${name}`, email: '' });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  }
  assert.equal(await rawUsers().countDocuments({ email: { $exists: false } }), 4);

  assert.equal((await create({ firstName: 'Ria', lastName: 'Real', email: 'ria@noemail.test' })).statusCode, 201);
  const again = await create({ firstName: 'Ria', lastName: 'Again', email: 'RIA@noemail.test' });
  assert.equal(again.statusCode, 409);

  const neither = await create({ firstName: 'No', lastName: 'Contact' });
  assert.equal(neither.statusCode, 400);
  assert.match(neither.body.message, /email address or a phone number/);
});

test('clearing an email never stores ""', async () => {
  const ria = await h.inGym(gym, () => User.findOne({ email: 'ria@noemail.test' }));
  await h.inGym(gym, async () => {
    ria.email = '';
    await ria.save();
  });
  const stored = await rawUsers().findOne({ _id: ria._id });
  assert.equal('email' in stored, false);
});

test('a member with no email is never matched by email, never emailed, and cannot turn on emailed codes', async () => {
  const nadia = await h.inGym(gym, () => User.findOne({ firstName: 'Nadia' }));

  // Somebody else's order that has no email on it: an email lookup for an
  // account without one must not pull it into Nadia's data export.
  await h.rawDb(gym.database.name).collection('packageorders').insertOne({ orderNumber: 'X-1', userId: admin._id, customerInfo: { fullName: 'Someone Else' } });
  const exported = await h.inGym(gym, () => h.call(security.exportMyData, { user: { id: String(nadia._id) } }));
  assert.equal(exported.statusCode, 200);
  const data = JSON.parse(exported.body);
  assert.equal(data.memberships.length, 0);
  assert.equal(data.enquiries.length, 0);

  const twoFactor = await h.inGym(gym, () => h.call(security.setMyTwoFactor, { user: { id: String(nadia._id) }, body: { enabled: true } }));
  assert.equal(twoFactor.statusCode, 409);
  assert.match(twoFactor.body.message, /no email address/);

  // The forgot-password form finds nobody for a blank address.
  const forgot = await h.inGym(gym, () => h.call(users.forgotPassword, { body: { email: '' } }));
  assert.equal(forgot.statusCode, 400);
});

test('a spreadsheet: one name column, no emails, address, active flag, discount and joining date', async () => {
  const file = [
    'Name,Email,Phone,Address,Joining Date,Active,Package,Start Date,End Date,Paid,Discount',
    'Sara Malik,sara@noemail.test,0300 1111111,"12 Mall Road, Lahore",15/03/2024,yes,Monthly,2026-09-01,2026-10-01,yes,5',
    'Bilal Ahmed Khan,,0300 2222222,House 4 Street 9,2025-01-10,inactive,,,,,',
    'Cher,,0300 3333333,,,,,,,,',
    'Dua Zafar,,,,,,,,,,',
    'Bilal Ahmed Khan,,0300 2222222,,,,,,,,'
  ].join('\n');

  const preview = await runImport(file, true);
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.body));
  const p = preview.body.data;
  assert.equal(p.dryRun, true);
  assert.equal(p.created, 2);
  assert.equal(p.withoutEmail, 1);
  assert.equal(p.inactive, 1);
  assert.equal(p.memberships, 1);
  assert.ok(p.columns.includes('fullName') && p.columns.includes('joinedAt') && p.columns.includes('discount'));
  assert.deepEqual(
    p.skipped.map((s) => [s.line, s.reason]),
    [
      [4, 'Needs a first and a last name'],
      [5, 'Needs an email or a phone number'],
      [6, 'Duplicate name and phone in the file']
    ]
  );
  assert.equal(await h.inGym(gym, () => User.exists({ phone: '0300 2222222' })), null, 'a preview writes nothing');

  const done = await runImport(file);
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.created, 2);
  assert.equal(done.body.data.errors.length, 0, JSON.stringify(done.body.data.errors));

  const sara = await h.inGym(gym, () => User.findOne({ email: 'sara@noemail.test' }).lean());
  assert.deepEqual([sara.firstName, sara.lastName, sara.isActive], ['Sara', 'Malik', true]);
  assert.equal(sara.addresses[0].address, '12 Mall Road, Lahore');
  assert.equal(sara.addresses[0].isDefault, true);
  assert.equal(sara.createdAt.toISOString().slice(0, 10), '2024-03-15', 'joined when the old system says');
  const order = await h.inGym(gym, () => PackageOrder.findOne({ userId: sara._id }).lean());
  assert.equal(order.payment.discountAmount, 5);
  assert.equal(order.payment.amount, 35);

  const bilal = await h.inGym(gym, () => User.findOne({ phone: '0300 2222222' }).lean());
  assert.deepEqual([bilal.firstName, bilal.lastName, bilal.isActive, bilal.email], ['Bilal', 'Ahmed Khan', false, undefined]);
  assert.equal(bilal.createdAt.toISOString().slice(0, 10), '2025-01-10');

  // The same file again: everybody is already there.
  const again = await runImport(file);
  assert.equal(again.body.data.created, 0);
  assert.ok(again.body.data.skipped.some((s) => s.reason === 'A member with this name and phone number already exists'));
  assert.ok(again.body.data.skipped.some((s) => s.reason === 'An account with this email already exists'));
});

test('imported members are existing members: no joining fee on their imported package', async () => {
  await h.inGym(gym, () => Package.create({ name: 'With joining fee', price: '50', currency: 'GBP', period: 'month', features: ['Gym floor'], joiningFee: 15 }));
  const res = await runImport('name,phone,package,paid\nOmar Old,0300 5550001,With joining fee,yes\n');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const orders = await h.rawDb(gym.database.name).collection('packageorders').find({ 'packageDetails.name': 'With joining fee' }).toArray();
  assert.equal(orders.length, 1, 'the package was given');
  const [order] = orders;
  assert.equal(order.customerInfo.fullName, 'Omar Old');
  const omar = await rawUsers().findOne({ phone: '0300 5550001' });
  assert.equal(String(order.userId), String(omar._id), 'on the imported member');
  assert.equal(order.payment.joiningFee, 0);
  assert.equal(order.payment.amount, 50, 'the package price, no fee added');
});

test('a file needs an email or a phone column, and says so', async () => {
  const res = await runImport('Name,Notes\nSome One,hello', true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /"email" or a "phone" column/);
});

test('the migration swaps the old always-unique email index for one that allows no email', async () => {
  // A gym database from before: email_1 unique over every document, one
  // account with '' and one with no email at all (all it would allow).
  const legacy = h.rawDb('gpit_legacy_email').collection('users');
  await legacy.createIndex({ email: 1 }, { unique: true, name: 'email_1' });
  await legacy.insertMany([{ firstName: 'Old', email: 'old@legacy.test' }, { firstName: 'Blank', email: '' }, { firstName: 'None' }]);
  await assert.rejects(legacy.insertOne({ firstName: 'Second none' }), /duplicate key/);

  const plan = await emailIndex.migrateEmailIndex(legacy);
  assert.equal(plan.applied, false, 'dry by default');
  assert.deepEqual(plan.drop, ['email_1']);
  assert.equal(plan.blanks, 1);
  assert.equal(plan.create, true);
  assert.equal((await legacy.indexes()).find((i) => i.name === 'email_1').partialFilterExpression, undefined, 'nothing changed');

  const applied = await emailIndex.migrateEmailIndex(legacy, { apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.unset, 1);
  const index = (await legacy.indexes()).find((i) => i.name === 'email_1');
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, { email: { $type: 'string' } });
  assert.equal(await legacy.countDocuments({ email: '' }), 0);

  await legacy.insertMany([{ firstName: 'Second none' }, { firstName: 'Third none' }]);
  await assert.rejects(legacy.insertOne({ firstName: 'Dup', email: 'old@legacy.test' }), /duplicate key/);

  const rerun = await emailIndex.migrateEmailIndex(legacy, { apply: true });
  assert.equal(rerun.upToDate, true);
  assert.equal(rerun.applied, false);

  // The app's own index on a new gym is already the new shape.
  const fresh = await emailIndex.planEmailIndex(rawUsers());
  assert.equal(fresh.upToDate, true);
});
