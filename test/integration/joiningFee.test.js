// The joining fee is charged once, with a member's first membership.
//
// It used to be added to every order a package made: renewing at the desk,
// changing package, and a returning member's card checkout all charged it
// again, while the Packages screen said "charged once". Now it is taken only
// when the member has never had a paid (or refunded) membership order, and
// never on a renewal or a package change.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let PackageOrder;
let Package;
let User;
let service;
let payments;
let orders;
let monthly;
let gold;
let dayPass;

const STRIPE_READY = {
  stripe: { enabled: true, publishableKey: 'pk_test_fee', secretKey: 'sk_test_fee', webhookSecret: 'whsec_fee' }
};

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  User = h.src('models/user');
  service = h.src('gymfolio/services/membershipService');
  payments = h.src('services/gymfolioPaymentService');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  gym = await h.createGym('fee-gym', { currency: 'GBP', settings: STRIPE_READY });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    monthly = await Package.create({ name: 'Monthly', price: '40', currency: 'GBP', period: 'month', features: ['Gym floor'], joiningFee: 25 });
    gold = await Package.create({ name: 'Gold', price: '60', currency: 'GBP', period: 'month', features: ['Everything'], joiningFee: 25 });
    dayPass = await Package.create({ name: 'Day pass', price: '8', currency: 'GBP', period: 'day', kind: 'day_pass', features: ['One visit'], joiningFee: 0 });
  });
});

let seq = 0;
async function newMember(name) {
  seq += 1;
  return User.create({ firstName: name, lastName: 'Fee', email: `${name.toLowerCase()}${seq}@fee.test`, role: 'user' });
}

const assign = (member, pkg, body = {}) =>
  h.call(orders.assignPackageToUser, {
    body: { userId: String(member._id), packageId: String(pkg._id), paymentMethod: 'cash', ...body },
    user: { id: 'staff', email: 'desk@fee.test' }
  });

test('a first membership carries the joining fee; the next one does not', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember('First');
    const first = await assign(member, monthly);
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.payment.amount, 65);
    assert.equal(first.body.data.payment.subtotal, 65);

    // Assigned again later -- a lapse and a rejoin, say: joined already.
    const again = await assign(member, monthly);
    assert.equal(again.body.data.payment.amount, 40);
    assert.equal(again.body.data.payment.subtotal, 40);
  });
});

test('a refunded membership still counts as having joined; a pending one does not', async () => {
  await h.inGym(gym, async () => {
    const refunded = await newMember('Refunded');
    const first = await service.createManualOrder({ user: refunded, pkg: monthly });
    await service.refund(first, { reason: 'changed mind' });
    assert.equal((await service.createManualOrder({ user: refunded, pkg: monthly })).payment.amount, 40);

    const pendingOnly = await newMember('Pending');
    await service.createManualOrder({ user: pendingOnly, pkg: monthly, markPaid: false });
    assert.equal((await service.createManualOrder({ user: pendingOnly, pkg: monthly })).payment.amount, 65);
  });
});

test('a day pass before joining is not joining: the membership after it carries the fee', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember('Visitor');
    await service.createManualOrder({ user: member, pkg: dayPass });
    const joined = await service.createManualOrder({ user: member, pkg: monthly });
    assert.equal(joined.payment.amount, 65);
  });
});

test('renewing at the desk and changing package never charge it again', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember('Loyal');
    const first = await service.createManualOrder({ user: member, pkg: monthly });
    assert.equal(first.payment.amount, 65);

    const renewal = await service.renew(first, { paymentMethod: 'cash' });
    assert.equal(renewal.payment.amount, 40);
    assert.equal(renewal.payment.subtotal, 40);

    const { order: changed, credit } = await service.changePackage(renewal, { packageId: gold._id });
    // The unused days of the renewal come off Gold's price; nothing is added.
    assert.equal(changed.payment.subtotal, 60);
    assert.equal(changed.payment.amount, Math.round(Math.max(0, 60 - credit) * 100) / 100);
  });
});

test('changing package credits the unused membership only, never the fees sold with it', async () => {
  await h.inGym(gym, async () => {
    const Trainer = h.src('gymfolio/models/trainerModel');
    const coach = await Trainer.create({ name: 'Coach Switch', role: 'Coach', isActive: true });
    const trainer = { trainerId: coach._id, fee: 50, commissionType: 'percent', commissionValue: 10 };
    const round2 = (n) => Math.round(n * 100) / 100;

    // 40 membership + 25 admission + 50 trainer, changed the same day: the
    // unused days are nearly all of the 40, and none of the 75 in fees.
    const first = await service.createManualOrder({ user: await newMember('Switcher'), pkg: monthly, trainer });
    assert.equal(first.payment.amount, 115);
    const { order: changed, credit } = await service.changePackage(first, { packageId: gold._id });
    assert.ok(credit > 39.9 && credit <= 40, `credit ${credit} is for the membership's 40 only`);
    assert.equal(changed.payment.amount, round2(60 - credit));

    // Charged 90 instead of 115: the fees are settled first, so 15 of it
    // paid for the membership -- and that is all there is to credit.
    const cut = await service.createManualOrder({ user: await newMember('Cutprice'), pkg: monthly, trainer, amountOverride: 90 });
    assert.deepEqual([cut.payment.joiningFee, cut.payment.trainerFee], [25, 50]);
    const moved = await service.changePackage(cut, { packageId: gold._id });
    assert.ok(moved.credit > 14.9 && moved.credit <= 15, `credit ${moved.credit} is for the 15 paid towards the membership`);
  });
});

test('changing a renewal that has not started credits what it cost, never more', async () => {
  await h.inGym(gym, async () => {
    const first = await service.createManualOrder({ user: await newMember('Queued'), pkg: monthly });
    // Renewed early: the 40 renewal starts when the running term ends.
    const renewal = await service.renew(first, {});
    assert.ok(new Date(renewal.subscription.startDate) > new Date());
    const { order: changed, credit } = await service.changePackage(renewal, { packageId: gold._id });
    // Every day of it is unused -- which is all of the 40, not twice it.
    assert.equal(credit, 40);
    assert.equal(changed.payment.amount, 20);
  });
});

test('a bank transfer from a member who has joined leaves the fee off', async () => {
  await h.inGym(gym, async () => {
    const newcomer = await newMember('Transfer');
    const firstTransfer = await service.createBankTransferOrder({ user: newcomer, pkg: monthly });
    assert.equal(firstTransfer.payment.amount, 65);

    const member = await newMember('Returning');
    await service.createManualOrder({ user: member, pkg: monthly });
    const transfer = await service.createBankTransferOrder({ user: member, pkg: monthly });
    assert.equal(transfer.payment.amount, 40);
    assert.equal(transfer.payment.subtotal, 40);
  });
});

test('card checkout: a returning member is not sent a joining-fee line; a new one is', async () => {
  const asked = [];
  h.setStripe({
    checkout: {
      sessions: {
        create: async (params) => {
          asked.push(params);
          return { id: `cs_fee_${asked.length}`, url: 'https://stripe.test/pay' };
        }
      }
    }
  });
  try {
    await h.inGym(gym, async () => {
      const member = await newMember('Card');
      await service.createManualOrder({ user: member, pkg: monthly });
      await payments.createPackageCheckoutSession(member._id, monthly._id, { email: member.email, fullName: 'Card Fee' });
      const back = await PackageOrder.findOne({ 'payment.stripeSessionId': 'cs_fee_1' }).lean();
      assert.equal(asked[0].line_items.length, 1);
      assert.equal(back.payment.amount, 40);

      // A guest is nobody the gym knows yet, whatever address they type:
      // typing a member's email does not take the fee off.
      await payments.createPackageCheckoutSession(null, monthly._id, { email: member.email, fullName: 'Card Fee' });
      assert.equal(asked[1].line_items.length, 2);
      assert.equal(asked[1].line_items[1].price_data.product_data.name, 'Joining fee');
      assert.equal((await PackageOrder.findOne({ 'payment.stripeSessionId': 'cs_fee_2' }).lean()).payment.amount, 65);

      await payments.createPackageCheckoutSession(null, monthly._id, { email: 'someone-new@fee.test', fullName: 'New' });
      assert.equal(asked[2].line_items.length, 2);
      assert.equal(asked[2].line_items[1].price_data.product_data.name, 'Joining fee');
      const fresh = await PackageOrder.findOne({ 'payment.stripeSessionId': 'cs_fee_3' }).lean();
      assert.equal(fresh.payment.amount, 65);
    });
  } finally {
    h.setStripe(null);
  }
});

test('card checkout: the fee and the one-subscription rule follow the signed-in account, never an email typed into the form', async () => {
  const asked = [];
  h.setStripe({
    checkout: {
      sessions: {
        create: async (params) => {
          asked.push(params);
          return { id: `cs_who_${asked.length}`, url: 'https://stripe.test/pay' };
        }
      }
    }
  });
  try {
    await h.inGym(gym, async () => {
      const rolling = await Package.create({
        name: 'Rolling',
        price: '45',
        currency: 'GBP',
        period: 'month',
        features: ['Gym floor'],
        joiningFee: 25,
        billing: { mode: 'recurring', interval: 'month', intervalCount: 1 }
      });
      // A paying member, on a card subscription.
      const payingMember = await newMember('Paying');
      const theirs = await service.createManualOrder({ user: payingMember, pkg: rolling });
      await PackageOrder.updateOne({ _id: theirs._id }, { $set: { 'payment.method': 'stripe', 'payment.stripeSubscriptionId': 'sub_paying', 'subscription.autoRenew': true } });

      // Somebody new signs in and types that member's address: still new,
      // so still charged the fee -- and not told the address has a subscription.
      const newcomer = await newMember('Newcomer');
      await payments.createPackageCheckoutSession(newcomer._id, rolling._id, { email: payingMember.email, fullName: 'New Comer' });
      assert.equal(asked.length, 1);
      assert.equal(asked[0].line_items.length, 2);
      assert.equal(asked[0].line_items[1].price_data.product_data.name, 'Joining fee');
      assert.equal((await PackageOrder.findOne({ 'payment.stripeSessionId': 'cs_who_1' }).lean()).payment.amount, 70);

      // The member themselves is known by their account whatever they type:
      // no second subscription, and nothing asked of Stripe.
      await assert.rejects(
        payments.createPackageCheckoutSession(payingMember._id, rolling._id, { email: 'typed-something-else@fee.test', fullName: 'Paying Fee' }),
        (error) => error.code === 'SUBSCRIPTION_EXISTS' && error.status === 409
      );
      assert.equal(asked.length, 1);

      // And for a one-off package their fee stays off, by the account alone.
      await payments.createPackageCheckoutSession(payingMember._id, monthly._id, { email: 'typed-something-else@fee.test', fullName: 'Paying Fee' });
      assert.equal(asked[1].line_items.length, 1);

      // A token for an account that is gone is a guest: charged the fee.
      const gone = new h.state.mongoose.Types.ObjectId();
      await payments.createPackageCheckoutSession(gone, monthly._id, { email: payingMember.email, fullName: 'Gone' });
      assert.equal(asked[2].line_items.length, 2);
    });
  } finally {
    h.setStripe(null);
  }
});

test('the checkout summary asks whether the fee is due -- for the signed-in account only, never for an email', async () => {
  const controller = h.src('gymfolio/controller/membershipController');
  const ask = (req) => h.call(controller.joiningFeeDue, req);

  await h.inGym(gym, async () => {
    const fresh = await newMember('Asking');
    const asFresh = { id: String(fresh._id), email: fresh.email, role: 'user' };
    const first = await ask({ user: asFresh });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { success: true, data: { due: true } });

    // Once they have joined, checkout leaves the fee off -- and so does the summary.
    await service.createManualOrder({ user: fresh, pkg: monthly });
    assert.equal((await ask({ user: asFresh })).body.data.due, false);

    // A guest checkout they made before the account existed counts too: the
    // account is matched by its own address, as checkout matches it.
    const guest = await newMember('Guestfirst');
    await PackageOrder.create({
      orderNumber: 'FEE-GUEST-1',
      userId: null,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
      customerInfo: { fullName: 'Guest First', email: guest.email },
      payment: { method: 'stripe', amount: 65, currency: 'GBP', status: 'paid', paidAt: new Date() },
      status: 'active'
    });
    assert.equal((await ask({ user: { id: String(guest._id), role: 'user' } })).body.data.due, false);

    // Signed out: due, as checkout charges a guest -- and no email in the
    // request is ever looked up, otherwise anyone could ask whether an
    // address has been a member here. `fresh` has joined, and it shows nothing.
    const signedOut = await ask({ user: null, query: { email: fresh.email }, body: { email: fresh.email } });
    assert.deepEqual(signedOut.body, { success: true, data: { due: true } });
    // The same for a token whose account is gone, or a malformed id.
    assert.equal((await ask({ user: { id: String(new h.state.mongoose.Types.ObjectId()) } })).body.data.due, true);
    assert.equal((await ask({ user: { id: 'not-an-id' } })).body.data.due, true);
  });

  // Public, but reads the session when there is one.
  const router = h.src('gymfolio/routes/gymfolioRoutes');
  const layer = router.stack.find((l) => l.route && l.route.path === '/membership/joining-fee-due' && l.route.methods.get);
  assert.ok(layer, 'the route is mounted');
  assert.deepEqual(layer.route.stack.map((l) => l.handle.name), ['optionalAuth', 'joiningFeeDue']);
});

// A guest's paid order is known by the address typed at checkout. An account
// only stands in for that guest once its address is confirmed
// (emailVerification.js): until then it is new, wherever the rules ask.
function guestOrder(email, { number, endInDays = 20, recurring = false } = {}) {
  const now = Date.now();
  return PackageOrder.create({
    orderNumber: number,
    userId: null,
    packageId: monthly._id,
    packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month', kind: 'membership' },
    customerInfo: { fullName: 'Guest Buyer', email },
    payment: { method: 'stripe', amount: 65, currency: 'GBP', status: 'paid', paidAt: new Date(now - 10 * 86400000), ...(recurring ? { stripeSubscriptionId: `sub_${number}` } : {}) },
    subscription: { isActive: true, startDate: new Date(now - 10 * 86400000), endDate: new Date(now + endInDays * 86400000), autoRenew: recurring },
    status: 'active'
  });
}

test('an account whose email is not confirmed does not inherit the guest who paid with that address', async () => {
  const asked = [];
  h.setStripe({
    checkout: {
      sessions: {
        create: async (params) => {
          asked.push(params);
          return { id: `cs_unproven_${asked.length}`, url: 'https://stripe.test/pay' };
        }
      }
    }
  });
  try {
    await h.inGym(gym, async () => {
      const feeDesk = h.src('gymfolio/services/feeDesk');
      const controller = h.src('gymfolio/controller/membershipController');
      const rolling = await Package.create({
        name: 'Rolling unproven',
        price: '45',
        currency: 'GBP',
        period: 'month',
        features: ['Gym floor'],
        joiningFee: 25,
        billing: { mode: 'recurring', interval: 'month', intervalCount: 1 }
      });
      await guestOrder('paid-as-guest@fee.test', { number: 'FEE-GUEST-UNPROVEN', recurring: true });

      // Somebody signs up with the guest's address and has not confirmed it.
      const claimant = await User.create({ firstName: 'Claimant', lastName: 'Fee', email: 'paid-as-guest@fee.test', role: 'user', emailVerified: false });
      const asClaimant = { id: String(claimant._id), email: claimant.email, role: 'user' };

      assert.deepEqual(await service.checkoutIdentity(claimant._id), { userId: claimant._id, email: '' });
      assert.equal((await h.call(controller.joiningFeeDue, { user: asClaimant })).body.data.due, true);
      assert.equal((await feeDesk.deskView(claimant._id)).joiningFeeDue, true);

      // Card checkout: the fee is charged, and the guest's running
      // subscription is not given away by a refusal.
      await payments.createPackageCheckoutSession(claimant._id, rolling._id, { email: claimant.email, fullName: 'Claimant Fee' });
      assert.equal(asked.length, 1);
      assert.equal(asked[0].line_items[1].price_data.product_data.name, 'Joining fee');

      // Bank transfer: the same on both counts.
      const transfer = await service.createBankTransferOrder({ user: await User.findById(claimant._id), pkg: rolling });
      assert.equal(transfer.payment.amount, 70);

      // At the desk: the fee is charged and the term starts today, not on
      // the day the guest's ends.
      const sold = await assign(claimant, monthly);
      assert.equal(sold.statusCode, 201, JSON.stringify(sold.body));
      assert.equal(sold.body.data.payment.amount, 65);
      assert.ok(Math.abs(new Date(sold.body.data.subscription.startDate) - Date.now()) < 60000, 'starts now');

      // Once the address is confirmed the account is that guest.
      const proven = await User.create({ firstName: 'Proven', lastName: 'Fee', email: 'proven-guest@fee.test', role: 'user', emailVerified: false });
      const theirs = await guestOrder('proven-guest@fee.test', { number: 'FEE-GUEST-PROVEN' });
      await User.updateOne({ _id: proven._id }, { $set: { emailVerified: true } });
      assert.equal((await feeDesk.deskView(proven._id)).joiningFeeDue, false);
      const stacked = await assign(proven, monthly);
      assert.equal(stacked.body.data.payment.amount, 40);
      assert.equal(new Date(stacked.body.data.subscription.startDate).getTime(), new Date(theirs.subscription.endDate).getTime());
    });
  } finally {
    h.setStripe(null);
  }
});

test('an order starts after its own account\'s term, never after the term of whoever\'s address was typed at checkout', async () => {
  await h.inGym(gym, async () => {
    const member = await newMember('Runs');
    const running = await service.createManualOrder({ user: member, pkg: monthly });
    const memberEnds = new Date(running.subscription.endDate).getTime();
    const paidAt = new Date();
    const typed = (userId, number) =>
      PackageOrder.create({
        orderNumber: number,
        userId,
        packageId: monthly._id,
        packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month', kind: 'membership' },
        customerInfo: { fullName: 'Typed It', email: member.email },
        payment: { method: 'stripe', amount: 65, currency: 'GBP', status: 'pending' }
      });

    // Signed in as somebody else, typing the member's address.
    const other = await newMember('Typist');
    const theirs = await service.markPaidAndActivate(await typed(other._id, 'FEE-TYPED-1'), { paidAt });
    assert.equal(new Date(theirs.subscription.startDate).getTime(), paidAt.getTime());

    // A guest typing it: a guest order starts when it is paid.
    const guest = await service.markPaidAndActivate(await typed(null, 'FEE-TYPED-2'), { paidAt });
    assert.equal(new Date(guest.subscription.startDate).getTime(), paidAt.getTime());

    // The member's own early renewal still follows on from their term.
    const own = await service.markPaidAndActivate(await typed(member._id, 'FEE-TYPED-3'), { paidAt });
    assert.equal(new Date(own.subscription.startDate).getTime(), memberEnds);

    // The model's own activation reads the same owner.
    const viaModel = await typed((await newMember('Modeltypist'))._id, 'FEE-TYPED-4');
    await viaModel.activateSubscription();
    assert.ok(new Date(viaModel.subscription.startDate).getTime() < memberEnds - 86400000);
  });
});
