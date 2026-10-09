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

/* --------------------------- card subscriptions --------------------------- */

const recurring = { mode: 'recurring', interval: 'month', intervalCount: 1 };

// A member on a monthly card subscription, and a Stripe that records what
// it is asked. `product` is the product behind the subscription's one item.
async function cardSubscriber({ product = { id: 'prod_old', name: 'Flex Package', active: true } } = {}) {
  seq += 1;
  const member = await User.create({ firstName: 'Card', lastName: `Sub${seq}`, email: `card${seq}@change.test`, role: 'user' });
  const flex = await Package.create({ name: `Flex ${seq}`, price: '30', currency: 'GBP', period: 'month', features: ['Gym floor'], billing: recurring });
  const sold = await service.createManualOrder({ user: member, pkg: flex, chargeJoiningFee: false });
  await PackageOrder.updateOne(
    { _id: sold._id },
    { $set: { 'payment.method': 'stripe', 'payment.stripeSubscriptionId': `sub_change_${seq}`, 'subscription.autoRenew': true } }
  );

  const asked = { retrieve: [], products: [], update: [] };
  const periodEnd = Math.floor(Date.now() / 1000) + 20 * 86400;
  const stripe = {
    subscriptions: {
      retrieve: async (id, options) => {
        asked.retrieve.push({ id, options });
        return { id, status: 'active', items: { data: [{ id: 'si_1', price: { id: 'price_old', product } }] } };
      },
      update: async (id, params) => {
        asked.update.push({ id, params });
        // What Stripe answers when a subscription item is given a product to create.
        if (params.items.some((item) => item.price_data && item.price_data.product_data)) {
          throw Object.assign(new Error('Received unknown parameter: items[0][price_data][product_data]'), { type: 'StripeInvalidRequestError' });
        }
        return { id, status: 'active', current_period_end: periodEnd };
      }
    },
    products: {
      create: async (params) => {
        asked.products.push(params);
        return { id: `prod_new_${asked.products.length}`, ...params };
      }
    }
  };
  return { order: await PackageOrder.findById(sold._id), asked, stripe, periodEnd };
}

test('a card subscription is switched with a price Stripe accepts: against a product id, never a product to create', async () => {
  const { order, asked, stripe, periodEnd } = await h.inGym(gym, () => cardSubscriber());
  h.setStripe(stripe);
  try {
    await h.inGym(gym, async () => {
      const premium = await Package.create({ name: 'Premium', price: '55', currency: 'GBP', period: 'month', features: ['Everything'], billing: recurring });
      const res = await change(order, { packageId: String(premium._id) });
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(res.body.message, 'Subscription switched; Stripe will prorate the difference.');
      assert.equal(res.body.credit, null);

      // The product is read with the subscription, and a new one made for the new package.
      assert.deepEqual(asked.retrieve[0].options, { expand: ['items.data.price.product'] });
      assert.deepEqual(asked.products, [{ name: 'Premium Package', metadata: { packageId: String(premium._id) } }]);
      assert.deepEqual(asked.update[0].params, {
        items: [{ id: 'si_1', price_data: { currency: 'gbp', product: 'prod_new_1', unit_amount: 5500, recurring: { interval: 'month', interval_count: 1 } } }],
        proration_behavior: 'create_prorations'
      });

      const row = await PackageOrder.findById(order._id).lean();
      assert.equal(String(row.packageId), String(premium._id));
      assert.equal(row.packageDetails.name, 'Premium');
      assert.equal(row.subscription.endDate.getTime(), periodEnd * 1000);
      // What was paid at the start is not rewritten.
      assert.equal(row.payment.amount, 30);
    });
  } finally {
    h.setStripe(null);
  }
});

test('a product the subscription already has under the same name is reused', async () => {
  const { order, asked, stripe } = await h.inGym(gym, () => cardSubscriber({ product: { id: 'prod_same', name: 'Renamed Package', active: true } }));
  h.setStripe(stripe);
  try {
    await h.inGym(gym, async () => {
      const renamed = await Package.create({ name: 'Renamed', price: '45', currency: 'GBP', period: 'month', features: ['x'], billing: recurring });
      const res = await change(order, { packageId: String(renamed._id) });
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(asked.products.length, 0);
      assert.equal(asked.update[0].params.items[0].price_data.product, 'prod_same');
    });
  } finally {
    h.setStripe(null);
  }
});

test('a card subscription is not moved onto a package that is paid once, and Stripe saying no changes nothing', async () => {
  const { order, asked, stripe } = await h.inGym(gym, () => cardSubscriber());
  h.setStripe(stripe);
  try {
    await h.inGym(gym, async () => {
      // Yearly is a one-off: on a subscription its 1200 would be charged every month.
      const refused = await change(order, { packageId: String(yearly._id) });
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.body.code, 'NOT_A_SUBSCRIPTION_PACKAGE');
      assert.match(refused.body.message, /Yearly is not paid by card subscription/);
      assert.match(refused.body.message, /Cancel the subscription, then assign Yearly at the desk/);
      assert.equal(asked.update.length, 0);

      const dollars = await Package.create({ name: 'Premium USD', price: '55', currency: 'USD', period: 'month', features: ['x'], billing: recurring });
      stripe.subscriptions.update = async () => {
        throw Object.assign(new Error('The price currency usd does not match the subscription currency gbp'), { type: 'StripeInvalidRequestError' });
      };
      const failed = await change(order, { packageId: String(dollars._id) });
      assert.equal(failed.statusCode, 409);
      assert.equal(failed.body.code, 'STRIPE_CHANGE_FAILED');
      assert.match(failed.body.message, /^Stripe did not accept the change, so the membership is as it was: The price currency/);
      const row = await PackageOrder.findById(order._id).lean();
      assert.equal(String(row.packageId), String(order.packageId));
      assert.equal(row.packageDetails.name, order.packageDetails.name);
    });
  } finally {
    h.setStripe(null);
  }
});
