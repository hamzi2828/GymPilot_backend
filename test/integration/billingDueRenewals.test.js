// Renewal orders for payment links (services/billing/dueRenewals.js), made
// and closed by the daily billing job, against a real MongoDB:
//
//   * a term ending within the gym's lead time gets ONE pending online
//     renewal order -- the same package at today's price -- however often
//     (or however many at once) the job runs;
//   * terms that renew themselves, are set not to renew, belong to guests,
//     or whose package is off sale are left alone and said so;
//   * a following term by any route -- renewed at the desk, a bank transfer
//     approved, or an order the hooks never saw -- closes the stale renewal
//     order; so does its link running out; a moved end date moves it;
//   * a gym that cannot be paid at all is left alone;
//   * the desk still reads an unpaid online renewal as a lapsed term.
//
// The gym's clock is set to midday (h.middayZone), so "in two days" never
// straddles midnight whenever the suite runs.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let bare;
let T;
let User;
let Package;
let PackageOrder;
let Bank;
let Settings;
let job;
let due;
let service;
let directory;
let provider;
let monthly;

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  User = h.src('models/user');
  Package = h.src('gymfolio/models/packageModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Bank = h.src('models/bank');
  Settings = h.src('models/settings');
  job = h.src('services/billing/billingJob');
  due = h.src('services/billing/dueRenewals');
  service = h.src('gymfolio/services/membershipService');
  directory = h.src('attendance/services/peopleDirectory');
  provider = h.src('services/billing/provider');
  // No gateway: these gyms take renewals by bank transfer, which is enough
  // for the job to run.
  provider.setProviderForTests(null);

  gym = await h.createGym('due-renewals-gym', { timezone: h.middayZone(), currency: 'PKR' });
  bare = await h.createGym('due-renewals-bare', { timezone: h.middayZone(), currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder, User, Package);
    monthly = await Package.create({ name: 'Monthly', price: '5,000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
    await Bank.create({ name: 'Meezan Bank', accountTitle: 'Iron Gym', accountNumber: '0101', iban: 'PK36MEZN0001' });
  });
});

let seq = 0;

async function member(first, extra = {}) {
  seq += 1;
  return User.create({ firstName: first, lastName: 'Member', email: `${first.toLowerCase()}${seq}@due.test`, phone: '03001234567', ...extra });
}

function inDays(days) {
  return T.localInstant(T.shiftDateKey(T.dateKey(), days), 12, 0);
}

function term(user, { number, endDate, pkg = monthly, stripe = null, status = 'active', guest = false, startDate = null }) {
  return PackageOrder.create({
    orderNumber: number,
    userId: guest ? null : user._id,
    packageId: pkg._id,
    packageDetails: { name: pkg.name, price: '4000', currency: 'PKR', period: 'month' },
    customerInfo: { fullName: `${user.firstName} Member`, email: user.email },
    payment: { method: stripe ? 'stripe' : 'cash', amount: 4000, currency: 'pkr', status: 'paid', paidAt: new Date(), stripeSubscriptionId: stripe },
    subscription: { startDate: startDate || new Date(endDate.getTime() - 30 * DAY), endDate, isActive: true, autoRenew: !!stripe },
    status
  });
}

const renewalOf = (termOrder) => PackageOrder.findOne({ 'metadata.dueFor': String(termOrder._id) }).lean();
const meta = (order, key) => order.metadata && order.metadata[key];

test('a term ending within the lead time gets one pending online renewal at the package price, once', async () => {
  await h.inGym(gym, async () => {
    const ann = await member('Ann');
    const soon = await term(ann, { number: 'DUE-SOON', endDate: inDays(2) });
    const later = await term(await member('Later'), { number: 'DUE-LATER', endDate: inDays(10) });

    const first = await job.runBillingJob();
    assert.equal(first.enabled, true, JSON.stringify(first));
    assert.equal(first.provider, null);
    assert.deepEqual(first.created.map((c) => c.order), ['DUE-SOON']);

    const renewal = await renewalOf(soon);
    assert.equal(renewal.status, 'pending');
    assert.equal(renewal.payment.status, 'pending');
    assert.equal(renewal.payment.method, 'online');
    assert.equal(renewal.payment.amount, 5000, 'the package price today, not what the term cost');
    assert.equal(renewal.payment.currency, 'pkr');
    assert.equal(renewal.payment.joiningFee, 0);
    assert.equal(String(renewal.userId), String(ann._id));
    assert.equal(String(renewal.packageId), String(monthly._id));
    assert.equal(String(renewal.renewedFrom), String(soon._id));
    assert.equal(renewal.customerInfo.email, ann.email);
    assert.equal(renewal.customerInfo.phone, ann.phone);
    const dueDate = T.dateKey(soon.subscription.endDate);
    assert.equal(meta(renewal, 'dueFor'), String(soon._id));
    assert.equal(meta(renewal, 'dueDate'), dueDate);
    assert.match(meta(renewal, 'dueDate'), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(meta(renewal, 'lastDay'), T.shiftDateKey(dueDate, 3), 'due date + lastDayAfterDue (3 by default)');
    assert.equal(await renewalOf(later), null, 'ten days out is past the 3-day lead time');

    // Again, and twice at once: still one.
    const again = await job.runBillingJob();
    assert.deepEqual(again.created, []);
    assert.equal(again.skipped.find((s) => s.order === 'DUE-SOON').reason, 'renewal order exists');
    await Promise.all([job.runBillingJob(), job.runBillingJob()]);
    assert.equal(await PackageOrder.countDocuments({ 'metadata.dueFor': String(soon._id) }), 1);
  });
});

test('two jobs side by side on a new term still make one renewal order', async () => {
  await h.inGym(gym, async () => {
    const twin = await term(await member('Twin'), { number: 'DUE-TWIN', endDate: inDays(1) });
    const results = await Promise.all([job.runBillingJob(), job.runBillingJob(), job.runBillingJob()]);
    assert.equal(await PackageOrder.countDocuments({ 'metadata.dueFor': String(twin._id) }), 1);
    const made = results.flatMap((r) => r.created).filter((c) => c.order === 'DUE-TWIN');
    assert.equal(made.length, 1, 'only one run reports making it');
  });
});

test('self-renewing, not-renewing, guest and off-sale terms are left alone, and said so', async () => {
  await h.inGym(gym, async () => {
    const offSale = await Package.create({ name: 'Old Plan', price: '3000', currency: 'PKR', period: 'month', features: ['x'], isActive: false });
    await term(await member('Auto'), { number: 'DUE-AUTO', endDate: inDays(2), stripe: 'sub_due_auto' });
    const stopping = await term(await member('Stop'), { number: 'DUE-STOP', endDate: inDays(2) });
    await PackageOrder.updateOne({ _id: stopping._id }, { $set: { 'subscription.cancelAtPeriodEnd': true } });
    await term(await member('Guest'), { number: 'DUE-GUEST', endDate: inDays(2), guest: true });
    await term(await member('Off'), { number: 'DUE-OFF', endDate: inDays(2), pkg: offSale });
    await term(await member('Gone', { isActive: false }), { number: 'DUE-GONE', endDate: inDays(2) });

    const result = await job.runBillingJob();
    const why = Object.fromEntries(result.skipped.map((s) => [s.order, s.reason]));
    assert.equal(why['DUE-AUTO'], 'renews automatically');
    assert.equal(why['DUE-STOP'], 'set not to renew');
    assert.equal(why['DUE-GUEST'], 'guest order (no member account)');
    assert.equal(why['DUE-OFF'], 'package no longer on sale');
    assert.equal(why['DUE-GONE'], 'account disabled');
    for (const number of ['DUE-AUTO', 'DUE-STOP', 'DUE-GUEST', 'DUE-OFF', 'DUE-GONE']) {
      const t = await PackageOrder.findOne({ orderNumber: number }).lean();
      assert.equal(await renewalOf(t), null, number);
    }
  });
});

test('renewed at the desk: the stale online renewal is closed at once and stops being chased', async () => {
  await h.inGym(gym, async () => {
    const bea = await member('Bea');
    const current = await term(bea, { number: 'DUE-DESK', endDate: inDays(2) });
    await job.runBillingJob();
    const renewal = await renewalOf(current);
    assert.equal(renewal.status, 'pending');

    const doc = await PackageOrder.findById(current._id);
    const desk = await service.renew(doc, { paymentMethod: 'cash', by: 'desk@due.test' });
    assert.equal(desk.payment.status, 'paid');
    assert.equal(new Date(desk.subscription.startDate).getTime(), current.subscription.endDate.getTime(), 'continues from the end');

    const closed = await PackageOrder.findById(renewal._id).lean();
    assert.equal(closed.status, 'cancelled');
    assert.equal(closed.payment.status, 'failed');
    assert.equal(meta(closed, 'closedReason'), 'superseded');
    assert.equal(meta(closed, 'supersededBy'), String(desk._id));
    assert.equal(closed.cancellation.source, 'billing');

    // And no new one for the old term: it has a following term now.
    const after = await job.runBillingJob();
    assert.equal(await PackageOrder.countDocuments({ 'metadata.dueFor': String(current._id) }), 1);
    assert.ok(!after.created.some((c) => c.order === 'DUE-DESK'));
  });
});

test('a bank transfer approved for the next term closes the online renewal too', async () => {
  await h.inGym(gym, async () => {
    const cal = await member('Cal');
    const current = await term(cal, { number: 'DUE-BANK', endDate: inDays(3) });
    await job.runBillingJob();
    const renewal = await renewalOf(current);
    assert.ok(renewal, 'made three days out');

    const transfer = await service.createBankTransferOrder({ user: cal, pkg: monthly });
    const sent = await service.submitTransferProof(transfer, { reference: 'RAAST-1' });
    await service.approveTransfer(sent, { by: null });

    const closed = await PackageOrder.findById(renewal._id).lean();
    assert.deepEqual([closed.status, meta(closed, 'closedReason'), meta(closed, 'supersededBy')], ['cancelled', 'superseded', String(transfer._id)]);
  });
});

test('a following term the hooks never saw is caught by the next run', async () => {
  await h.inGym(gym, async () => {
    const dee = await member('Dee');
    const current = await term(dee, { number: 'DUE-RAW', endDate: inDays(2) });
    await job.runBillingJob();
    const renewal = await renewalOf(current);
    // Written straight to the collection: no markPaidAndActivate.
    await term(dee, { number: 'DUE-RAW-NEXT', startDate: current.subscription.endDate, endDate: inDays(32) });

    const result = await job.runBillingJob();
    assert.ok(result.closed.some((c) => c.order === renewal.orderNumber && c.reason === 'superseded'), JSON.stringify(result.closed));
    assert.equal((await PackageOrder.findById(renewal._id).lean()).status, 'cancelled');
  });
});

test('a paid renewal is the following term; it closes nothing of its own and stops being due', async () => {
  await h.inGym(gym, async () => {
    const eve = await member('Eve');
    const current = await term(eve, { number: 'DUE-PAID', endDate: inDays(2) });
    await job.runBillingJob();
    const renewal = await PackageOrder.findOne({ 'metadata.dueFor': String(current._id) });
    await service.markPaidAndActivate(renewal, { paidAt: new Date(), method: 'online' });

    const paid = await PackageOrder.findById(renewal._id).lean();
    assert.deepEqual([paid.status, paid.payment.status], ['active', 'paid']);
    assert.equal(new Date(paid.subscription.startDate).getTime(), current.subscription.endDate.getTime(), 'starts when the term it renews ends');
    const result = await job.runBillingJob();
    assert.ok(!result.closed.some((c) => c.order === paid.orderNumber));
    assert.equal(await PackageOrder.countDocuments({ 'metadata.dueFor': String(current._id) }), 1);
  });
});

test('its link running out unpaid closes it; a moved end date moves it; not renewing closes it', async () => {
  await h.inGym(gym, async () => {
    const fay = await member('Fay');
    const stale = await term(fay, { number: 'DUE-STALE', endDate: inDays(1) });
    const gil = await member('Gil');
    const moving = await term(gil, { number: 'DUE-MOVE', endDate: inDays(1) });
    const hal = await member('Hal');
    const quitting = await term(hal, { number: 'DUE-QUIT', endDate: inDays(1) });
    await job.runBillingJob();

    // The last day to pay was eight days ago: a week of grace has passed.
    const old = T.shiftDateKey(T.dateKey(), -8);
    await PackageOrder.updateOne({ 'metadata.dueFor': String(stale._id) }, { $set: { 'metadata.dueDate': old, 'metadata.lastDay': old } });
    // A freeze pushed the term out by two weeks.
    await PackageOrder.updateOne({ _id: moving._id }, { $set: { 'subscription.endDate': inDays(15) } });
    // The member said they will not renew.
    await PackageOrder.updateOne({ _id: quitting._id }, { $set: { 'subscription.cancelAtPeriodEnd': true } });

    const dry = await job.runBillingJob({ dryRun: true });
    assert.ok(dry.closed.some((c) => c.reason === 'expired' && c.dryRun));
    assert.equal((await renewalOf(stale)).status, 'pending', 'a dry run closes nothing');

    const result = await job.runBillingJob();
    const reasons = Object.fromEntries(result.closed.map((c) => [c.order, c.reason]));
    const [s, m, q] = [await renewalOf(stale), await renewalOf(moving), await renewalOf(quitting)];
    assert.equal(reasons[s.orderNumber], 'expired');
    assert.equal(meta(s, 'closedReason'), 'expired');
    assert.equal(reasons[q.orderNumber], 'not renewing');
    assert.equal(m.status, 'pending');
    assert.equal(meta(m, 'dueDate'), T.shiftDateKey(T.dateKey(), 15));
    assert.equal(meta(m, 'lastDay'), T.shiftDateKey(T.dateKey(), 18));
    assert.ok(result.moved.some((row) => row.order === m.orderNumber));
  });
});

test('a dry run reports what it would make and writes nothing', async () => {
  await h.inGym(gym, async () => {
    const ivy = await member('Ivy');
    const current = await term(ivy, { number: 'DUE-DRY', endDate: inDays(2) });
    const dry = await job.runBillingJob({ dryRun: true });
    const row = dry.created.find((c) => c.order === 'DUE-DRY');
    assert.ok(row && row.dryRun, JSON.stringify(dry.created));
    assert.equal(row.amount, 5000);
    assert.equal(await renewalOf(current), null);
  });
});

test('a gym with no gateway and no bank account is left alone; so is one with every reminder off', async () => {
  await h.inGym(bare, async () => {
    const BarePackage = await Package.create({ name: 'Bare', price: '100', currency: 'PKR', period: 'month', features: ['x'] });
    const joe = await member('Joe');
    const current = await term(joe, { number: 'BARE-1', endDate: inDays(2), pkg: BarePackage });
    const result = await job.runBillingJob();
    assert.equal(result.enabled, false);
    assert.match(result.reason, /no online payment gateway and no bank account/);
    assert.equal(await renewalOf(current), null);
  });
  await h.inGym(gym, async () => {
    await Settings.updateOne({}, { $set: { 'billing.sendVia': { email: false, sms: false, whatsapp: false, push: false } } });
    try {
      const kim = await member('Kim');
      const current = await term(kim, { number: 'DUE-OFF-ALL', endDate: inDays(2) });
      const result = await job.runBillingJob();
      assert.equal(result.enabled, false);
      assert.match(result.reason, /switched off/);
      assert.equal(await renewalOf(current), null);
    } finally {
      await Settings.updateOne({}, { $unset: { billing: 1 } });
    }
  });
});

test('the desk reads a lapsed term with an unpaid online renewal as expired, as it always has', async () => {
  await h.inGym(gym, async () => {
    const lou = await member('Lou');
    const current = await term(lou, { number: 'DUE-DOOR', endDate: inDays(1) });
    await job.runBillingJob();
    assert.ok(await renewalOf(current));
    // The term runs out, unrenewed.
    await PackageOrder.updateOne({ _id: current._id }, { $set: { 'subscription.endDate': new Date(Date.now() - DAY), status: 'expired' } });
    const verdict = await directory.membershipFor(lou);
    assert.equal(verdict.status, 'expired', JSON.stringify(verdict));
  });
});

test('the order model takes the online method and the renewal metadata as strings', async () => {
  await h.inGym(gym, async () => {
    const { PAYMENT_METHODS, DESK_METHODS, methodLabel } = h.src('services/paymentMethods');
    assert.ok(PAYMENT_METHODS.includes('online'));
    assert.ok(!DESK_METHODS.includes('online'), 'never recorded by hand at the desk');
    assert.equal(methodLabel('online'), 'Online payment');
    const order = new PackageOrder({
      orderNumber: 'DUE-SHAPE',
      packageId: monthly._id,
      packageDetails: { name: 'Monthly', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'Shape' },
      payment: { method: 'online', amount: 5000, currency: 'pkr' },
      metadata: { dueFor: 'x', dueDate: '2026-11-19', lastDay: '2026-11-22' }
    });
    await order.validate();
    assert.equal(due.isDueRenewal(order), true);
    assert.equal(due.metadataOf(order, 'lastDay'), '2026-11-22');
  });
});

test('the billing rules are saved through PUT /settings, merged and checked, and read back', async () => {
  await h.inGym(gym, async () => {
    const settingsController = h.src('controller/settingsController');
    const save = (billing) => h.call(settingsController.updateSettings, { body: { billing } });

    const bad = await save({ reminderDaysBefore: [40] });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.message, /reminderDaysBefore/);

    const ok = await save({ reminderDaysBefore: [7, 3], sendVia: { sms: true }, autoCharge: { enabled: true } });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.data.billing.reminderDaysBefore, [7, 3]);
    assert.equal(ok.body.data.billing.sendVia.sms, true);
    assert.equal(ok.body.data.billing.sendVia.email, true, 'a channel not sent keeps its value');
    assert.equal(ok.body.data.billing.autoCharge.enabled, true);

    const { billingSettings } = h.src('services/billing/settings');
    const stored = billingSettings(await Settings.getSettings());
    assert.deepEqual(stored.reminderDaysBefore, [7, 3]);
    assert.equal(stored.lastDayAfterDue, 3);

    await Settings.updateOne({}, { $unset: { billing: 1 } });
    assert.deepEqual(billingSettings(await Settings.getSettings()).reminderDaysBefore, [3]);
  });
});
