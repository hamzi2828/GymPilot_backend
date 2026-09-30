// Admission and trainer's fees as money of their own, against a real
// MongoDB: what every order writer records in payment.joiningFee /
// payment.trainerFee, and how ledger.membershipPaymentStages reads each
// payment back -- admission, trainer's fee, membership, method and kind --
// for the accounts, the dashboard and the reports.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let PackageOrder;
let Package;
let User;
let L;
let service;
let accounts;
let monthly;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  L = h.src('accounts/services/ledger');
  service = h.src('gymfolio/services/membershipService');
  accounts = h.src('accounts/controller/accountsController');
  gym = await h.createGym('fees-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['Gym floor'], joiningFee: 25 });
  });
});

let seq = 0;
const at = (iso) => new Date(iso);

/** An order straight into the collection, as older code or another writer left it. */
async function seed({ amount, payment = {}, renewals = [], createdAt = at('2026-07-05T09:00:00Z') }) {
  seq += 1;
  const { Types } = h.state.mongoose;
  const doc = {
    _id: new Types.ObjectId(),
    orderNumber: `FEE-${seq}`,
    userId: null,
    packageId: new Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: [], kind: 'membership', joiningFee: 25 },
    customerInfo: { fullName: `Fee ${seq}`, email: `fee${seq}@fees.test` },
    payment: { method: 'cash', amount, currency: 'gbp', status: 'paid', paidAt: createdAt, ...payment },
    subscription: { startDate: createdAt, endDate: new Date(createdAt.getTime() + 30 * 86400000), isActive: true, renewals },
    status: 'active',
    createdAt,
    updatedAt: createdAt
  };
  await PackageOrder.collection.insertOne(doc);
  return doc;
}

const rowsFor = async (from, to, orderNumbers) =>
  (await PackageOrder.aggregate(L.membershipPaymentStages(L.readRange({ from, to }), { orderNumber: { $in: orderNumbers } })))
    .map((r) => ({ n: r.orderNumber, kind: r.kind, amount: r.amount, admission: r.admission, trainerFee: r.trainerFee, membership: r.membership, method: r.method }))
    .sort((a, b) => (a.n + a.kind).localeCompare(b.n + b.kind));

test('the desk records the joining fee it charged, and none on the next order', async () => {
  await h.inGym(gym, async () => {
    const member = await User.create({ firstName: 'Ada', lastName: 'Fees', email: 'ada@fees.test', role: 'user' });
    const first = await service.createManualOrder({ user: member, pkg: monthly });
    assert.equal(first.payment.amount, 65);
    assert.equal(first.payment.joiningFee, 25);
    assert.equal(first.payment.trainerFee, 0);

    const renewal = await service.renew(first, {});
    assert.equal(renewal.payment.joiningFee, 0);
    assert.equal(renewal.payment.amount, 40);
  });
});

test('a discount comes off the package price, never the joining fee', async () => {
  await h.inGym(gym, async () => {
    const member = await User.create({ firstName: 'Bo', lastName: 'Fees', email: 'bo@fees.test', role: 'user' });
    const order = await service.createManualOrder({ user: member, pkg: monthly, discountAmount: 50, discountNote: 'friend' });
    // The price goes to nothing; the fee is still charged, and the recorded
    // discount is what it actually took off.
    assert.equal(order.payment.amount, 25);
    assert.equal(order.payment.joiningFee, 25);
    assert.equal(order.payment.discountAmount, 40);
  });
});

test('an override below the fee is allocated admission first', async () => {
  await h.inGym(gym, async () => {
    const member = await User.create({ firstName: 'Cy', lastName: 'Fees', email: 'cy@fees.test', role: 'user' });
    const order = await service.createManualOrder({ user: member, pkg: monthly, amountOverride: 20 });
    assert.equal(order.payment.amount, 20);
    assert.equal(order.payment.joiningFee, 20);
  });
});

test('a member on file without an email still gets an order', async () => {
  await h.inGym(gym, async () => {
    // The access work makes email optional on members; an order for one
    // must not fail on customerInfo.email.
    const phoneOnly = new User({ firstName: 'Dee', lastName: 'Phone', phone: '+923001234567', role: 'user' });
    const order = await service.createManualOrder({ user: phoneOnly, pkg: monthly, markPaid: false });
    assert.equal(order.customerInfo.email, '');
    assert.equal(order.customerInfo.fullName, 'Dee Phone');
  });
});

test('each payment row carries admission, trainer fee, membership, method and kind', async () => {
  await h.inGym(gym, async () => {
    const withFee = await seed({ amount: 65, payment: { joiningFee: 25 } });
    const legacy = await seed({ amount: 65 }); // no joiningFee field: reads 0 until backfilled
    const renewing = await seed({
      amount: 95,
      payment: { method: 'stripe', joiningFee: 25, trainerFee: 30 },
      renewals: [{ at: at('2026-08-05T09:00:00Z'), amount: 40, currency: 'gbp' }]
    });
    const partPaid = await seed({ amount: 65, payment: { joiningFee: 25, trainerFee: 10, amountPaid: 30, balanceDue: 35 } });
    const inParts = await seed({
      amount: 100,
      payment: {
        joiningFee: 20,
        trainerFee: 30,
        amountPaid: 100,
        balanceDue: 0,
        installments: [
          { amount: 30, joiningFee: 20, trainerFee: 10, method: 'jazzcash', at: at('2026-07-05T09:00:00Z') },
          { amount: 40, joiningFee: 0, trainerFee: 20, method: '', at: at('2026-07-20T09:00:00Z') },
          // A later part, in August: found although nothing else of the order is.
          { amount: 30, joiningFee: 0, trainerFee: 0, method: 'easypaisa', at: at('2026-08-02T09:00:00Z') }
        ]
      }
    });

    const numbers = [withFee, legacy, renewing, partPaid, inParts].map((o) => o.orderNumber);
    const july = await rowsFor('2026-07-01', '2026-07-31', numbers);
    assert.deepEqual(july, [
      { n: withFee.orderNumber, kind: 'initial', amount: 65, admission: 25, trainerFee: 0, membership: 40, method: 'cash' },
      { n: legacy.orderNumber, kind: 'initial', amount: 65, admission: 0, trainerFee: 0, membership: 65, method: 'cash' },
      { n: renewing.orderNumber, kind: 'initial', amount: 95, admission: 25, trainerFee: 30, membership: 40, method: 'stripe' },
      // Paid 30 of 65 so far: admission first, then the trainer, then the membership.
      { n: partPaid.orderNumber, kind: 'initial', amount: 30, admission: 25, trainerFee: 5, membership: 0, method: 'cash' },
      { n: inParts.orderNumber, kind: 'initial', amount: 30, admission: 20, trainerFee: 10, membership: 0, method: 'jazzcash' },
      { n: inParts.orderNumber, kind: 'installment', amount: 40, admission: 0, trainerFee: 20, membership: 20, method: 'cash' }
    ].sort((a, b) => (a.n + a.kind).localeCompare(b.n + b.kind)));

    const august = await rowsFor('2026-08-01', '2026-08-31', numbers);
    assert.deepEqual(august, [
      { n: renewing.orderNumber, kind: 'renewal', amount: 40, admission: 0, trainerFee: 0, membership: 40, method: 'stripe' },
      { n: inParts.orderNumber, kind: 'installment', amount: 30, admission: 0, trainerFee: 0, membership: 30, method: 'easypaisa' }
    ].sort((a, b) => (a.n + a.kind).localeCompare(b.n + b.kind)));
  });
});

test('the accounts overview counts the money received, part payments included', async () => {
  await h.inGym(gym, async () => {
    await seed({ amount: 50, createdAt: at('2026-05-03T09:00:00Z'), payment: { amountPaid: 20, balanceDue: 30 } });
    await seed({
      amount: 80,
      createdAt: at('2026-05-04T09:00:00Z'),
      payment: {
        amountPaid: 80,
        installments: [
          { amount: 50, joiningFee: 0, trainerFee: 0, method: 'cash', at: at('2026-05-04T09:00:00Z') },
          { amount: 30, joiningFee: 0, trainerFee: 0, method: 'wallet', at: at('2026-05-10T09:00:00Z') }
        ]
      }
    });
    const res = await h.call(accounts.overview, { query: { from: '2026-05-01', to: '2026-05-31' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    // 20 taken on the first, 50 + 30 on the second; not the 130 ordered.
    assert.equal(res.body.income.base_amount, 100);
  });
});

test('daily sales count a desk renewal and a package change as renewals; the ledger rows say which order each renewed', async () => {
  await h.inGym(gym, async () => {
    const { dailySales } = h.src('services/dailySales');
    const T = h.src('attendance/services/timeUtils');
    const today = L.readRange({ from: T.dateKey(), to: T.dateKey() });
    const gold = await Package.create({ name: 'Gold', price: '60', currency: 'GBP', period: 'month', features: ['Everything'] });
    const before = (await dailySales(today)).totals;

    // One member joins and renews at the desk; another joins and moves to Gold.
    const renewer = await User.create({ firstName: 'Ren', lastName: 'Fees', email: 'ren@fees.test', role: 'user' });
    const joined = await service.createManualOrder({ user: renewer, pkg: monthly });
    const renewal = await service.renew(joined, {});
    const mover = await User.create({ firstName: 'Mo', lastName: 'Fees', email: 'mo@fees.test', role: 'user' });
    const started = await service.createManualOrder({ user: mover, pkg: monthly });
    const { order: moved } = await service.changePackage(started, { packageId: gold._id });

    const after = (await dailySales(today)).totals;
    const change = (column) => Math.round((after[column] - before[column]) * 100) / 100;
    assert.equal(change('new_signups'), 80, 'the two first memberships');
    assert.equal(change('admission'), 50);
    assert.equal(change('renewals'), Math.round((40 + moved.payment.amount) * 100) / 100, 'the renewal and the package change');
    assert.equal(change('total'), Math.round((65 + 40 + 65 + moved.payment.amount) * 100) / 100);

    const rows = await PackageOrder.aggregate(
      L.membershipPaymentStages(today, { orderNumber: { $in: [joined.orderNumber, renewal.orderNumber, moved.orderNumber] } })
    );
    const renewedFrom = Object.fromEntries(rows.map((r) => [r.orderNumber, r.renewedFrom ? String(r.renewedFrom) : null]));
    assert.deepEqual(renewedFrom, {
      [joined.orderNumber]: null,
      [renewal.orderNumber]: String(joined._id),
      [moved.orderNumber]: String(started._id)
    });
    assert.ok(rows.every((r) => r.kind === 'initial'), 'the kind each payment already had is unchanged');
  });
});

test('the fee backfill finds old orders a later save wrote a 0 into, and nothing written since the split', async () => {
  const { planOrderFees, applyOrderFees } = require('../../scripts/lib/orderFees');
  await h.inGym(gym, async () => {
    const Trainer = h.src('gymfolio/models/trainerModel');
    const old = { createdAt: at('2026-06-10T09:00:00Z') };
    // Legacy orders: the subtotal is price + fee, the fee never recorded.
    const untouched = await seed({ amount: 65, payment: { subtotal: 65 }, ...old });
    const frozen = await seed({ amount: 65, payment: { subtotal: 65 }, ...old });
    const noFee = await seed({ amount: 40, payment: { subtotal: 40 }, ...old }); // subtotal is the price: not charged

    // Freezing it saves the whole order, and the schema's default goes in
    // with it: the order now says it carried no admission fee.
    await service.freeze(await PackageOrder.findById(frozen._id), { days: 7, reason: 'travel' });
    const saved = await PackageOrder.collection.findOne({ _id: frozen._id });
    assert.equal(saved.payment.joiningFee, 0, 'a save writes the default');

    // Written since the split: the fee waived, a trainer's fee of the same
    // 25 on top -- 40 + 25 is the same subtotal, but no fee was charged.
    const coach = await Trainer.create({ name: 'Coach Backfill', role: 'Coach', isActive: true });
    const member = await User.create({ firstName: 'Wai', lastName: 'Fees', email: 'wai@fees.test', role: 'user' });
    const waived = await service.createManualOrder({
      user: member,
      pkg: monthly,
      chargeJoiningFee: false,
      trainer: { trainerId: coach._id, fee: 25, commissionType: 'percent', commissionValue: 10 }
    });
    assert.deepEqual([waived.payment.subtotal, waived.payment.joiningFee, waived.payment.trainerFee], [65, 0, 25]);

    const mine = [untouched, frozen, noFee, waived].map((o) => o.orderNumber);
    const planned = (plan) => plan.updates.filter((u) => mine.includes(u.order.orderNumber)).map((u) => [u.order.orderNumber, u.fee]).sort();
    const plan = await planOrderFees();
    assert.deepEqual(planned(plan), [[untouched.orderNumber, 25], [frozen.orderNumber, 25]].sort());

    assert.ok((await applyOrderFees(plan.updates)) >= 2);
    for (const o of [untouched, frozen]) {
      assert.equal((await PackageOrder.collection.findOne({ _id: o._id })).payment.joiningFee, 25, o.orderNumber);
    }
    assert.equal((await PackageOrder.collection.findOne({ _id: waived._id })).payment.joiningFee, 0);
    assert.deepEqual(planned(await planOrderFees()), [], 'run again, nothing left to do');

    // --before narrows the re-saved ones to orders made before that day.
    const later = await seed({ amount: 65, payment: { subtotal: 65, joiningFee: 0, trainerFee: 0 }, createdAt: at('2026-06-20T09:00:00Z') });
    const narrowed = await planOrderFees({ before: at('2026-06-15T00:00:00Z') });
    assert.ok(!narrowed.updates.some((u) => u.order.orderNumber === later.orderNumber));
    assert.ok((await planOrderFees()).updates.some((u) => u.order.orderNumber === later.orderNumber));
  });
});
