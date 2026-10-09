// Bringing members in from a spreadsheet, against a real MongoDB: the dates
// a membership is given. A date the importer cannot read stops that row and
// says so, in the preview and in the import alike -- it is never replaced by
// "today plus the package's term".

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let Package;
let PackageOrder;
let importer;
let admin;

const test = h.suite(async () => {
  User = h.src('models/user');
  Package = h.src('gymfolio/models/packageModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  importer = h.src('controller/userImportController');

  gym = await h.createGym('import-gym', { timezone: 'Asia/Karachi', currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, PackageOrder);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@import.test', role: 'admin', password: await bcrypt.hash('admin-pass-1', 4) });
    await Package.create({ name: 'Monthly', price: '4000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
  });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const runImport = (text, dryRun = false) =>
  h.inGym(gym, () => h.call(importer.importCsv, { ...as(admin), file: { buffer: Buffer.from(text, 'utf8'), originalname: 'members.csv', mimetype: 'text/csv' }, body: { dryRun: dryRun ? '1' : '0' } }));
const memberBy = (phone) => h.inGym(gym, () => User.findOne({ phone }).lean());
const ordersOf = (user) => h.inGym(gym, () => PackageOrder.find({ userId: user._id }).lean());

test('a membership date that cannot be read skips the row with a reason, in the preview and the import', async () => {
  const file = [
    'Name,Phone,Package,Start Date,End Date,Paid',
    'Good Dates,0300 7000001,Monthly,01/09/2026,30/09/2026,yes',
    'Month First,0300 7000002,Monthly,2026-09-01,09/30/2026,yes',
    'Short Year,0300 7000003,Monthly,01/09/26,30/09/2026,yes',
    'Backwards Dates,0300 7000004,Monthly,2026-09-30,2026-09-01,yes',
    'No Package,0300 7000005,,whenever,,'
  ].join('\n');
  const expected = [
    [3, 'Could not read the membership end date "09/30/2026". It looks like month/day/year, and dates are read day first: write it as 30/09/2026, then upload the file again.'],
    [4, 'Could not read the membership start date "01/09/26". Write the year in full, like 30/09/2026 or 2026-09-30, then upload the file again.'],
    [5, 'The membership ends (2026-09-01) before it starts (2026-09-30). Correct the dates, then upload the file again.']
  ];

  const preview = await runImport(file, true);
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.skipped.map((s) => [s.line, s.reason]), expected);
  assert.equal(preview.body.data.created, 2);
  assert.equal(preview.body.data.memberships, 1);

  const done = await runImport(file);
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.data.skipped.map((s) => [s.line, s.reason]), expected);
  assert.equal(done.body.data.created, 2);
  assert.equal(done.body.data.memberships, 1);
  assert.deepEqual(done.body.data.errors, []);

  // The skipped rows wrote nothing: no account, so no membership either.
  for (const phone of ['0300 7000002', '0300 7000003', '0300 7000004']) assert.equal(await memberBy(phone), null, phone);
  // Dates only matter where there is a membership to give.
  assert.ok(await memberBy('0300 7000005'));

  const [order] = await ordersOf(await memberBy('0300 7000001'));
  assert.equal(order.subscription.startDate.toISOString(), '2026-08-31T19:00:00.000Z');
  assert.equal(order.subscription.endDate.toISOString(), '2026-09-30T18:59:59.999Z');
});

test('month names and spreadsheet serial numbers are read; a member who lapsed stays lapsed', async () => {
  const file = [
    'Name,Phone,Date of Birth,Package,Start Date,End Date,Paid',
    // 46266 and 46295 are 1 and 30 September 2026 as a spreadsheet stores them.
    'Named Month,0300 7100001,14 May 1990,Monthly,1 Sep 2026,30-Sep-2026,yes',
    'Serial Number,0300 7100002,,Monthly,46266,46295,yes',
    'Lapsed Member,0300 7100003,sometime in May,Monthly,1 Jan 2025,31 Jan 2025,yes'
  ].join('\n');

  const done = await runImport(file);
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.created, 3);
  assert.equal(done.body.data.memberships, 3);
  assert.deepEqual(done.body.data.skipped, []);
  // A date of birth that cannot be read is left blank, and said.
  assert.deepEqual(
    done.body.data.errors.map((e) => [e.line, e.reason]),
    [[4, 'Could not read the date of birth "sometime in May". Write dates as 2026-09-30 or 30/09/2026 (day first) — left blank']]
  );

  for (const phone of ['0300 7100001', '0300 7100002']) {
    const [order] = await ordersOf(await memberBy(phone));
    assert.equal(order.subscription.startDate.toISOString(), '2026-08-31T19:00:00.000Z', phone);
    assert.equal(order.subscription.endDate.toISOString(), '2026-09-30T18:59:59.999Z', phone);
  }
  assert.equal((await memberBy('0300 7100001')).dateOfBirth.toISOString(), '1990-05-14T07:00:00.000Z');

  const lapsed = await memberBy('0300 7100003');
  assert.equal(lapsed.dateOfBirth, null);
  const [old] = await ordersOf(lapsed);
  assert.equal(old.subscription.endDate.toISOString(), '2025-01-31T18:59:59.999Z', 'the term that ended, not a new one from today');
});
