// Deleting a package that members still hold is refused.
//
// Renewing reads the order's package, so a package deleted from under its
// members left the desk unable to renew them ("The package no longer
// exists"). DELETE /packages/:id now answers 409 PACKAGE_IN_USE, pointing at
// Deactivate, while any order for it is running, awaiting payment, or a
// lapsed membership its member has not moved on from.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let gym;
let PackageOrder;
let Package;
let User;
let controller;
let service;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  controller = h.src('gymfolio/controller/packageController');
  service = h.src('gymfolio/services/membershipService');
  gym = await h.createGym('pkg-delete-gym', { currency: 'GBP' });
  await h.inGym(gym, () => h.ensureIndexes(PackageOrder));
});

let seq = 0;
const newPackage = (name = 'Monthly') => Package.create({ name, price: '40', currency: 'GBP', period: 'month', features: ['Gym floor'] });
const newMember = () => {
  seq += 1;
  return User.create({ firstName: 'Del', lastName: `Member${seq}`, email: `del${seq}@pkg.test`, role: 'user' });
};
const remove = (pkg) => h.call(controller.deletePackage, { params: { id: String(pkg._id) } });

// Moves an order's term into the past and marks it lapsed, as the sweep would.
async function lapse(order) {
  const end = new Date(Date.now() - 5 * DAY);
  await PackageOrder.updateOne(
    { _id: order._id },
    { $set: { status: 'expired', 'subscription.isActive': false, 'subscription.startDate': new Date(end.getTime() - 30 * DAY), 'subscription.endDate': end } }
  );
}

test('a package nobody has bought is deleted', async () => {
  await h.inGym(gym, async () => {
    const pkg = await newPackage('Unsold');
    const res = await remove(pkg);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(await Package.countDocuments({ _id: pkg._id }), 0);
  });
});

test('a live membership keeps its package: 409 with a message that points at Deactivate', async () => {
  await h.inGym(gym, async () => {
    const pkg = await newPackage('Held');
    await service.createManualOrder({ user: await newMember(), pkg });
    const res = await remove(pkg);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'PACKAGE_IN_USE');
    assert.equal(res.body.live, 1);
    assert.match(res.body.message, /Held cannot be deleted/);
    assert.match(res.body.message, /Deactivate it instead/);
    assert.equal(await Package.countDocuments({ _id: pkg._id }), 1);
  });
});

test('an order awaiting payment keeps its package too', async () => {
  await h.inGym(gym, async () => {
    const pkg = await newPackage('Awaiting');
    await service.createBankTransferOrder({ user: await newMember(), pkg });
    const res = await remove(pkg);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.live, 1);
  });
});

test('a lapsed membership is renewable until its member moves on', async () => {
  await h.inGym(gym, async () => {
    const pkg = await newPackage('Lapsed');
    const other = await newPackage('Other');
    const member = await newMember();
    const order = await service.createManualOrder({ user: member, pkg });
    await lapse(order);

    let res = await remove(pkg);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.live, 0);
    assert.equal(res.body.renewable, 1);
    assert.match(res.body.message, /1 lapsed and not yet renewed/);

    // The member came back on another package: nothing left to renew here.
    await service.createManualOrder({ user: member, pkg: other });
    res = await remove(pkg);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });
});

test('cancelled and refunded orders do not hold a package', async () => {
  await h.inGym(gym, async () => {
    const pkg = await newPackage('Done');
    const order = await service.createManualOrder({ user: await newMember(), pkg });
    await service.refund(order, { reason: 'moved away' });
    const res = await remove(pkg);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });
});

test('an id that is not one is a 404, not a 500', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(controller.deletePackage, { params: { id: 'nope' } });
    assert.equal(res.statusCode, 404);
  });
});
