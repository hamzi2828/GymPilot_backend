// Bringing members in from a spreadsheet, against a real MongoDB.
//
// The dates a membership is given: a date the importer cannot read stops
// that row and says so, in the preview and in the import alike -- it is never
// replaced by "today plus the package's term".
//
// And a file too big for one request: the import stops at its time budget,
// says how much is left, and the same file uploaded again carries on --
// including for a member whose account was made by an earlier upload but
// whose membership was not.

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

test('an import that runs out of time stops, says what is left, and the same file carries on', async () => {
  const file = ['Name,Phone,Package,Start Date,End Date', 'Big One,0300 7200001,Monthly,2026-09-01,2026-09-30', 'Big Two,0300 7200002,Monthly,2026-09-01,2026-09-30', 'Big Three,0300 7200003,Monthly,2026-09-01,2026-09-30'].join('\n');

  // A budget every row overruns: each upload does one member and stops.
  process.env.IMPORT_BUDGET_MS = '1';
  try {
    const first = await runImport(file);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    const a = first.body.data;
    assert.deepEqual([a.stopped, a.created, a.memberships, a.processed, a.remaining, a.total], [true, 1, 1, 1, 2, 3]);
    assert.match(first.body.message, /2 row\(s\) still to do\. Upload the same file again to carry on/);
    // Where today's panel shows it: first in the list under the totals.
    assert.equal(a.errors[0].line, 3);
    assert.match(a.errors[0].reason, /Upload the same file again to carry on/);

    const second = await runImport(file);
    const b = second.body.data;
    assert.deepEqual([b.stopped, b.created, b.memberships, b.remaining], [true, 1, 1, 1]);
    assert.deepEqual(b.skipped.map((s) => [s.line, s.reason]), [[2, 'A member with this name and phone number already exists']]);

    const third = await runImport(file);
    const c = third.body.data;
    assert.deepEqual([c.stopped, c.created, c.memberships, c.remaining, c.processed], [false, 1, 1, 0, 3]);
    assert.equal(c.skipped.length, 2);
    assert.deepEqual(c.errors, []);
    assert.doesNotMatch(third.body.message, /Upload the same file/);
  } finally {
    delete process.env.IMPORT_BUDGET_MS;
  }

  for (const phone of ['0300 7200001', '0300 7200002', '0300 7200003']) {
    assert.equal(await h.inGym(gym, () => User.countDocuments({ phone })), 1, phone);
    assert.equal((await ordersOf(await memberBy(phone))).length, 1, phone);
  }
});

test('a member imported without their membership gets it when the file is uploaded again', async () => {
  const file = [
    'Name,Email,Phone,Package,Start Date,End Date,Paid',
    'Quinn Quarterly,quinn@import.test,0300 7300001,Quarterly,2026-09-01,2026-11-30,yes',
    'Rafi Quarterly,,0300 7300002,Quarterly,2026-09-01,2026-11-30,yes',
    'Sana Broken,sana@import.test,0300 7300003,Broken price,2026-09-01,2026-09-30,yes'
  ].join('\n');

  // "Quarterly" is not a package yet, and "Broken price" cannot be sold.
  const broken = await h.inGym(gym, () => Package.create({ name: 'Broken price', price: 'ask at the desk', currency: 'PKR', period: 'month', features: ['Gym floor'] }));
  const first = await runImport(file);
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.data.created, first.body.data.memberships], [3, 0]);
  const reasons = first.body.data.errors.map((e) => [e.line, e.reason]);
  assert.deepEqual(reasons.slice(0, 2), [
    [2, 'No package called "Quarterly" — the member is created without a membership'],
    [3, 'No package called "Quarterly" — the member is created without a membership']
  ]);
  assert.equal(reasons[2][0], 4);
  assert.match(reasons[2][1], /^Imported without the membership: Package "Broken price" has an unreadable price .* Put that right and upload the file again to add it\.$/);
  const sana = await memberBy('0300 7300003');
  assert.ok(sana, 'the account stays');
  assert.deepEqual(await ordersOf(sana), []);

  // The gym puts both right and uploads the same file.
  await h.inGym(gym, async () => {
    await Package.create({ name: 'Quarterly', price: '10000', currency: 'PKR', period: 'quarter', features: ['Gym floor'] });
    await Package.updateOne({ _id: broken._id }, { $set: { price: '4000' } });
  });

  const preview = await runImport(file, true);
  assert.deepEqual([preview.body.data.created, preview.body.data.completed, preview.body.data.memberships, preview.body.data.skipped.length], [0, 3, 3, 0]);
  assert.deepEqual(await ordersOf(sana), [], 'a preview writes nothing');

  const second = await runImport(file);
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  const d = second.body.data;
  assert.deepEqual([d.created, d.completed, d.memberships, d.skipped.length, d.errors.length], [0, 3, 3, 0, 0], JSON.stringify(d));
  for (const phone of ['0300 7300001', '0300 7300002', '0300 7300003']) {
    assert.equal(await h.inGym(gym, () => User.countDocuments({ phone })), 1, 'nobody is added twice');
    const orders = await ordersOf(await memberBy(phone));
    assert.equal(orders.length, 1, phone);
    assert.equal(orders[0].subscription.startDate.toISOString(), '2026-08-31T19:00:00.000Z');
  }

  // Once they have it, they are simply already here.
  const third = await runImport(file);
  assert.deepEqual([third.body.data.created, third.body.data.completed, third.body.data.memberships], [0, 0, 0]);
  assert.deepEqual(third.body.data.skipped.map((s) => s.reason), [
    'An account with this email already exists',
    'A member with this name and phone number already exists',
    'An account with this email already exists'
  ]);
  assert.equal((await ordersOf(sana)).length, 1);
});

test('only a member with no membership at all is added to: not staff, and not a member who has had one', async () => {
  const lapsed = await memberBy('0300 7100003');
  const file = ['Name,Email,Phone,Package', 'Ada Admin,ada@import.test,,Monthly', 'Lapsed Member,,0300 7100003,Monthly'].join('\n');
  const res = await runImport(file);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.data.created, res.body.data.completed, res.body.data.memberships], [0, 0, 0]);
  assert.equal(res.body.data.skipped.length, 2);
  assert.deepEqual(await ordersOf(admin), []);
  assert.equal((await ordersOf(lapsed)).length, 1);
});

test('the plan limit is counted as the rows come in, in the preview too', async () => {
  const members = await h.inGym(gym, () => User.countDocuments({ role: 'user' }));
  // The same gym on a plan with room for two more members.
  const limited = { ...gym, plan: { slug: 'small', limits: { maxMembers: members + 2 } } };
  const file = ['Name,Phone', 'Limit One,0300 7400001', 'Limit Two,0300 7400002', 'Limit Three,0300 7400003', 'Limit Four,0300 7400004'].join('\n');
  const upload = (dryRun) => h.inGym(limited, () => h.call(importer.importCsv, { ...as(admin), file: { buffer: Buffer.from(file, 'utf8') }, body: { dryRun: dryRun ? '1' : '0' } }));
  const full = `This gym's plan allows up to ${members + 2} members. Upgrade the plan to add more.`;

  for (const dryRun of [true, false]) {
    const res = await upload(dryRun);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.created, 2, dryRun ? 'preview' : 'import');
    assert.deepEqual(res.body.data.skipped.map((s) => [s.line, s.reason]), [[4, full], [5, full]]);
  }
  assert.equal(await h.inGym(gym, () => User.countDocuments({ role: 'user' })), members + 2);
});

// Members brought over from another system paid there, before the gym moved:
// the import gives them their memberships, and none of it is today's money.
test('imported memberships are not today\'s takings, get no invoice number, and are as good as any other at the desk', async () => {
  const T = h.src('attendance/services/timeUtils');
  const L = h.src('accounts/services/ledger');
  const service = h.src('gymfolio/services/membershipService');
  const dashboard = h.src('controller/dashboardController');
  const accounts = h.src('accounts/controller/accountsController');
  const membershipController = h.src('gymfolio/controller/membershipController');
  const { dailySales } = h.src('services/dailySales');
  const pnl = h.src('accounts/services/profitAndLoss');
  const { membershipFor } = h.src('attendance/services/peopleDirectory');

  // Every screen that says what was taken today.
  const takings = () =>
    h.inGym(gym, async () => {
      const today = T.dateKey();
      const range = L.readRange({ from: today, to: today });
      const dash = await h.call(dashboard.overview);
      const overview = await h.call(accounts.overview, { query: { from: today, to: today } });
      const sales = await h.call(accounts.sales, { query: { from: today, to: today } });
      for (const res of [dash, overview, sales]) assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const daily = await dailySales(range);
      const [ledger] = await PackageOrder.aggregate([...L.membershipPaymentStages(range), { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } }]);
      return JSON.parse(
        JSON.stringify({
          dashboard: { today: dash.body.revenue_today, month: dash.body.revenue, memberships: dash.body.membership_revenue },
          overview: overview.body,
          sales: { summary: sales.body.summary, rows: sales.body.sales.length },
          daily: { days: daily.days, totals: daily.totals, by_method: daily.by_method },
          profitAndLoss: await pnl.forRange(range),
          ledger: { total: ledger ? ledger.total : 0, payments: ledger ? ledger.n : 0 }
        })
      );
    });

  // One real sale today, so there are takings to compare.
  await h.inGym(gym, async () => {
    const user = await User.create({ firstName: 'Reggie', lastName: 'Regular', email: 'reggie@import.test', role: 'user' });
    await service.createManualOrder({ user, pkg: await Package.findOne({ name: 'Monthly' }), paymentMethod: 'cash' });
  });
  const before = await takings();
  assert.deepEqual(before.ledger, { total: 4000, payments: 1 });
  assert.equal(before.dashboard.today.base_amount, 4000);
  const invoiced = () => h.inGym(gym, () => PackageOrder.countDocuments({ 'invoice.number': { $ne: null } }));
  const invoicesBefore = await invoiced();

  const day = (offset) => T.dateKey(new Date(Date.now() + offset * 86400000));
  const file = [
    'Name,Phone,Package,Start Date,End Date,Paid,Discount',
    `Moved One,0300 7500001,Monthly,${day(-10)},${day(20)},yes,`,
    `Moved Two,0300 7500002,Monthly,${day(-10)},${day(20)},yes,1000`,
    `Owes Still,0300 7500003,Monthly,${day(-10)},${day(20)},no,`
  ].join('\n');
  const done = await runImport(file);
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.data.created, done.body.data.memberships, done.body.data.errors.length], [3, 3, 0], JSON.stringify(done.body.data));

  // Nothing was taken today: every figure is what it was.
  assert.deepEqual(await takings(), before);
  assert.equal(await invoiced(), invoicesBefore, 'no invoice number is used up');

  // The memberships themselves are whole: paid, running, good at the desk.
  for (const phone of ['0300 7500001', '0300 7500002']) {
    const user = await memberBy(phone);
    const [order] = await ordersOf(user);
    assert.equal(order.imported, true, phone);
    assert.deepEqual([order.payment.status, order.status, order.subscription.isActive], ['paid', 'active', true], phone);
    assert.equal(order.invoice.number, null, phone);
    const held = await h.inGym(gym, () => membershipFor(user));
    assert.equal(held.status, 'active', phone);
    assert.equal(String(held.orderId), String(order._id));
  }
  // Asking for its invoice does not make one up.
  const movedOne = await h.inGym(gym, async () => PackageOrder.findOne({ userId: (await User.findOne({ phone: '0300 7500001' }))._id }));
  assert.equal(await h.inGym(gym, () => h.src('services/invoiceService').ensureInvoice(movedOne)), null);
  assert.equal(await invoiced(), invoicesBefore);

  // The one that came in unpaid is an ordinary order waiting for its money:
  // when it is paid here, that is today's takings, with an invoice.
  const owes = await h.inGym(gym, async () => PackageOrder.findOne({ userId: (await User.findOne({ phone: '0300 7500003' }))._id }));
  assert.equal(owes.imported, undefined);
  assert.equal(owes.payment.status, 'pending');
  await h.inGym(gym, () => service.markPaidAndActivate(owes, { method: 'cash' }));
  const paidHere = await takings();
  assert.deepEqual(paidHere.ledger, { total: 8000, payments: 2 });
  assert.equal(paidHere.dashboard.today.base_amount, 8000);
  assert.equal(await invoiced(), invoicesBefore + 1);

  // And money taken later on an imported membership counts on its day: the
  // discount is withdrawn, the 1000 it leaves owing is paid at the desk.
  await h.inGym(gym, async () => {
    const movedTwo = await PackageOrder.findOne({ userId: (await User.findOne({ phone: '0300 7500002' }))._id });
    assert.equal(movedTwo.payment.amount, 3000);
    const edited = await service.editTerms(movedTwo, { discountAmount: 0 });
    assert.equal(edited.payment.balanceDue, 1000);
    await service.recordPayment(edited, { amount: 1000, method: 'cash' });
  });
  const later = await takings();
  assert.deepEqual(later.ledger, { total: 9000, payments: 3 });
  assert.equal(later.dashboard.today.base_amount, 9000);
});
