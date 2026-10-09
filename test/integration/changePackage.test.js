// Changing a member's package, against a real MongoDB.
//
// The unused days of the old package are credited against the new price.
// When they are worth more than the new package -- a year paid, half of it
// left, moved to a monthly -- the rest used to vanish while the desk was told
// the whole credit had been applied. Now the change is refused, naming the
// amount, until the desk confirms; and the answer says what was done.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let PackageOrder;
let Package;
let User;
let service;
let controller;
let yearly;
let monthly;
let twoYear;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  service = h.src('gymfolio/services/membershipService');
  controller = h.src('gymfolio/controller/membershipController');
  gym = await h.createGym('change-gym', { currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    yearly = await Package.create({ name: 'Yearly', price: '1200', currency: 'GBP', period: 'year', features: ['Gym floor'] });
    monthly = await Package.create({ name: 'Monthly', price: '120', currency: 'GBP', period: 'month', features: ['Gym floor'] });
    twoYear = await Package.create({ name: 'Two years', price: '2000', currency: 'GBP', period: '2 years', features: ['Gym floor'] });
  });
});

let seq = 0;

// A yearly membership paid in full, exactly half of it used.
async function halfUsedYear() {
  seq += 1;
  const member = await User.create({ firstName: 'Chan', lastName: `Ge${seq}`, email: `change${seq}@change.test`, role: 'user' });
  const order = await service.createManualOrder({ user: member, pkg: yearly, chargeJoiningFee: false });
  const now = Date.now();
  await PackageOrder.updateOne(
    { _id: order._id },
    { $set: { 'subscription.startDate': new Date(now - 100 * DAY), 'subscription.endDate': new Date(now + 100 * DAY) } }
  );
  return order;
}

// Signed in as real staff are: the token carries their account id and email.
let staff;
const change = async (order, body) => {
  staff = staff || (await User.create({ firstName: 'Desk', lastName: 'Staff', email: 'desk@change.test', role: 'admin' }));
  return h.call(controller.changePackage, { params: { id: String(order._id) }, body, user: { id: String(staff._id), email: staff.email } });
};

test('a credit worth more than the new package is not thrown away: the desk is told the amount and what to do', async () => {
  await h.inGym(gym, async () => {
    const order = await halfUsedYear();
    const res = await change(order, { packageId: String(monthly._id) });

    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'CREDIT_EXCEEDS_PRICE');
    assert.deepEqual(res.body.details, { credit: 600, price: 120, creditUnused: 480, currency: 'GBP' });
    assert.match(res.body.message, /GBP 600\.00 of unused days already paid for, but Monthly costs only GBP 120\.00: GBP 480\.00 would be lost/);
    assert.match(res.body.message, /refund GBP 600\.00 of this membership and then assign Monthly/);
    assert.match(res.body.message, /To change anyway and give up the GBP 480\.00, confirm the change/);

    // Nothing moved: the yearly membership is as it was, and no order replaced it.
    const row = await PackageOrder.findById(order._id).lean();
    assert.equal(row.status, 'active');
    assert.equal(await PackageOrder.countDocuments({ renewedFrom: order._id }), 0);
  });
});

test('confirmed, the change goes ahead and the answer says what was credited and what was given up', async () => {
  await h.inGym(gym, async () => {
    const order = await halfUsedYear();
    const res = await change(order, { packageId: String(monthly._id), forfeitCredit: true });

    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.credit, 120);
    assert.equal(res.body.creditUnused, 480);
    assert.equal(
      res.body.message,
      'Package changed. GBP 120.00 credited for unused days; the other GBP 480.00 was given up, as confirmed. The new membership comes to GBP 0.00.'
    );
    // The new order carries the credit it was given, not the one it was not.
    assert.equal(res.body.data.payment.amount, 0);
    assert.equal(res.body.data.payment.discountAmount, 120);
    assert.match(res.body.data.payment.discountNote, /480 of unused credit given up/);
    // And the old one records what ending it cost the member.
    const old = await PackageOrder.findById(order._id).lean();
    assert.equal(old.status, 'cancelled');
    assert.match(old.cancellation.reason, /^Changed to Monthly \(PKG\d+\); 480 of unused credit given up$/);
  });
});

test('a credit the new package can take in full needs no confirmation, and the message gives the real figures', async () => {
  await h.inGym(gym, async () => {
    const order = await halfUsedYear();
    const res = await change(order, { packageId: String(twoYear._id) });

    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.credit, 600);
    assert.equal(res.body.creditUnused, 0);
    assert.equal(res.body.message, 'Package changed. GBP 600.00 credited for unused days. The new membership comes to GBP 1400.00.');
    assert.equal(res.body.data.payment.amount, 1400);
    assert.equal(res.body.data.payment.discountAmount, 600);
    assert.doesNotMatch(res.body.data.payment.discountNote, /given up/);
    assert.equal((await PackageOrder.findById(order._id).lean()).cancellation.reason, `Changed to Two years (${res.body.data.orderNumber})`);
  });
});

test('the old membership is ended in the same request, with who changed it -- never left running beside the new one', async () => {
  await h.inGym(gym, async () => {
    const order = await halfUsedYear();
    const res = await change(order, { packageId: String(twoYear._id) });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));

    const old = await PackageOrder.findById(order._id).lean();
    assert.equal(old.status, 'cancelled');
    assert.equal(old.subscription.isActive, false);
    assert.equal(String(old.cancellation.by), String(staff._id));
    // One live membership, not two.
    assert.equal(await PackageOrder.countDocuments({ userId: order.userId, status: 'active' }), 1);
    assert.match(res.body.data.notes, /^Changed from PKG\d+ \(Yearly\)$/);
  });
});
