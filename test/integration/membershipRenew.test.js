// Staff renewing a membership by hand, through membershipController.renew.
//
// A card subscription renews itself at Stripe, so a manual renewal on top is
// paid for twice; one whose card payment failed is Stripe's to collect.
// Both are refused (409, with a code the admin screen can act on) unless the
// desk sends `force`. Everything else renews as before.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY_MS = 86400000;

let gym;
let PackageOrder;
let Package;
let User;
let controller;
let member;
let pkg;

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  controller = h.src('gymfolio/controller/membershipController');
  gym = await h.createGym('renew-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    member = await User.create({ firstName: 'Rene', lastName: 'Renew', email: 'rene@renew.test', role: 'member' });
    pkg = await Package.create({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['Gym floor'] });
  });
});

let seq = 0;
async function membership({ card = false, status = 'active', subscription = {} } = {}) {
  seq += 1;
  const endDate = new Date(Date.now() + 10 * DAY_MS);
  const payment = { method: card ? 'stripe' : 'cash', amount: 40, currency: 'gbp', status: 'paid', paidAt: new Date() };
  if (card) Object.assign(payment, { stripeSubscriptionId: `sub_renew_${seq}`, stripeCustomerId: 'cus_rene' });
  return PackageOrder.create({
    orderNumber: `RN-${seq}`,
    userId: member._id,
    packageId: pkg._id,
    packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
    customerInfo: { fullName: 'Rene Renew', email: 'rene@renew.test' },
    payment,
    subscription: {
      startDate: new Date(endDate.getTime() - 30 * DAY_MS),
      endDate,
      renewalDate: endDate,
      isActive: true,
      autoRenew: card,
      stripeStatus: card ? 'active' : '',
      ...subscription
    },
    status
  });
}

const renew = (order, body = {}) =>
  h.call(controller.renew, { params: { id: String(order._id) }, body: { paymentMethod: 'cash', ...body }, user: { id: 'staff', email: 'desk@renew.test' } });

const renewalsOf = (order) => PackageOrder.countDocuments({ renewedFrom: order._id });

test('a card subscription that renews itself is not renewed again by hand', async () => {
  await h.inGym(gym, async () => {
    const order = await membership({ card: true });
    const res = await renew(order);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'AUTO_RENEWS');
    assert.match(res.body.message, /billed automatically by card/);
    assert.match(res.body.message, /charge twice/);
    assert.equal(await renewalsOf(order), 0);

    // A trialing subscription (a package trial, or a freeze moving the next
    // charge) renews itself too.
    const trialing = await membership({ card: true, status: 'frozen', subscription: { stripeStatus: 'trialing' } });
    assert.equal((await renew(trialing)).body.code, 'AUTO_RENEWS');
  });
});

test('a card subscription whose payment failed is sent back to the member to fix the card', async () => {
  await h.inGym(gym, async () => {
    const order = await membership({ card: true, status: 'past_due', subscription: { stripeStatus: 'past_due' } });
    const res = await renew(order);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'CARD_PAYMENT_FAILED');
    assert.equal(res.body.message, 'Card payment failed — ask the member to update their card.');
    assert.equal(await renewalsOf(order), 0);
  });
});

test('force renews either way, when the desk has checked and means it', async () => {
  await h.inGym(gym, async () => {
    for (const order of [
      await membership({ card: true }),
      await membership({ card: true, status: 'past_due', subscription: { stripeStatus: 'past_due' } })
    ]) {
      const res = await renew(order, { force: true });
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.payment.status, 'paid');
      assert.equal(await renewalsOf(order), 1);
    }
    // A form post sends it as a string.
    const again = await membership({ card: true });
    assert.equal((await renew(again, { force: 'true' })).statusCode, 201);
  });
});

test('cash memberships, and card subscriptions already told to stop, renew without force', async () => {
  await h.inGym(gym, async () => {
    const cash = await membership();
    const res = await renew(cash);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    // The new term starts when the current one ends.
    assert.equal(new Date(res.body.data.subscription.startDate).getTime(), new Date(cash.subscription.endDate).getTime());

    const stopping = await membership({ card: true, subscription: { cancelAtPeriodEnd: true, autoRenew: false } });
    assert.equal((await renew(stopping)).statusCode, 201);
    const ended = await membership({ card: true, subscription: { stripeStatus: 'canceled' } });
    assert.equal((await renew(ended)).statusCode, 201);

    // The member hears about the renewal once the response has gone.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(h.calls.notifications.some((n) => n.name === 'membershipConfirmed' && String(n.args[0].renewedFrom) === String(cash._id)));
  });
});
