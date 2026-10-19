// Payment links and the due-date charge end to end, through the REAL
// gateway registry (services/payments) and its Safepay provider, against the
// local stand-in for Safepay's API (helpers/fakeSafepay.js) -- nothing here
// reaches Safepay:
//
//   * a renewal's link opens a Safepay checkout for exactly what it owes,
//     coming back to the link's page; paid with "save my card" ticked, the
//     member has an auto-pay card, listed on GET /api/billing/me/saved-methods;
//   * on the next due date the daily job charges that card: paid -> the
//     renewal is activated once; a card Safepay declines -> the renewal says
//     so, stays open, and the member is sent the link;
//   * a renewal closed because the member renewed at the desk is still
//     activated if a Safepay checkout opened before that is paid after it;
//   * with the bank-transfer gateway ('generic') chosen instead, the link
//     offers the transfer and receipt only, and nothing is ever charged.
//
// It needs the gateway work (services/payments, helpers/fakeSafepay.js) and
// skips until that is merged.

const fs = require('fs');
const path = require('path');
const nodeTest = require('node:test');

const READY =
  fs.existsSync(path.join(__dirname, 'helpers', 'fakeSafepay.js')) &&
  fs.existsSync(path.join(__dirname, '..', '..', 'src', 'services', 'payments', 'index.js'));

if (!READY) {
  nodeTest('payment links through the real Safepay provider', { skip: 'needs the payment-gateway work (services/payments) merged' }, () => {});
} else {
  run();
}

function run() {
  const assert = require('node:assert/strict');
  const jwt = require('jsonwebtoken');
  const h = require('./helpers/harness');
  const { createFakeSafepay } = require('./helpers/fakeSafepay');

  const SECRET = 'sec_paylinks_secret';
  const PUBLIC = 'pub_paylinks_key';
  const DAY = 86400000;
  const SITE = 'http://paylinks-safepay-gym.test';

  let fake;
  let gym;
  let T;
  let User;
  let PackageOrder;
  let Settings;
  let job;
  let links;
  let safepay;
  let pkg;
  let server;
  let base;
  let t0;
  const people = {};
  const terms = {};

  const test = h.suite(async () => {
    require('./helpers/onlineMethod')(h);
    fake = await createFakeSafepay({ secretKey: SECRET, publicKey: PUBLIC }).start();
    process.env.SAFEPAY_API_BASE_URL = fake.base;
    T = h.src('attendance/services/timeUtils');
    User = h.src('models/user');
    PackageOrder = h.src('gymfolio/models/packageOrderModel');
    Settings = h.src('models/settings');
    job = h.src('services/billing/billingJob');
    links = h.src('services/billing/payLinks');
    safepay = h.src('services/safepay');
    const Package = h.src('gymfolio/models/packageModel');
    const Bank = h.src('models/bank');
    gym = await h.createGym('paylinks-safepay-gym', {
      name: 'Iron Gym',
      timezone: h.middayZone(),
      currency: 'PKR',
      settings: {
        safepay: { enabled: true, environment: 'sandbox', publicKey: PUBLIC, secretKey: SECRET, webhookSecret: 'whsec_x' },
        onlinePayments: { provider: 'safepay' },
        billing: { autoCharge: { enabled: true } }
      }
    });
    t0 = new Date();
    await h.inGym(gym, async () => {
      await h.ensureIndexes(PackageOrder, User);
      await Bank.create({ name: 'Meezan Bank', accountTitle: 'Iron Gym', accountNumber: '0101', iban: 'PK36MEZN0000000001' });
      pkg = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
      const end = T.localInstant(T.shiftDateKey(T.dateKey(t0), 3), 12, 0);
      for (const first of ['Ayesha', 'Bilal', 'Cara']) {
        const user = await User.create({ firstName: first, lastName: 'Khan', email: `${first.toLowerCase()}@paylinks-safepay.test`, phone: '03331234567', role: 'user' });
        people[first] = user;
        terms[first] = await PackageOrder.create({
          orderNumber: `SP-${first.toUpperCase()}`,
          userId: user._id,
          packageId: pkg._id,
          packageDetails: { name: 'Monthly', price: '5000', currency: 'PKR', period: 'month' },
          customerInfo: { fullName: `${first} Khan`, email: user.email, phone: user.phone },
          payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date() },
          subscription: { startDate: new Date(end.getTime() - 30 * DAY), endDate: end, isActive: true },
          status: 'active'
        });
      }
    });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.tenant = gym;
      h.inGym(gym, async () => next()).catch(next);
    });
    app.use(h.src('routes/payLinkRoutes'));
    app.use('/api/gymfolio', h.src('gymfolio/routes/gymfolioRoutes'));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  nodeTest.after(async () => {
    delete process.env.SAFEPAY_API_BASE_URL;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fake) await fake.stop();
  });

  const at = (days) => new Date(t0.getTime() + days * DAY);
  const runJob = (days) => h.inGym(gym, () => job.runBillingJob({ now: at(days) }));
  const renewalFor = (termOrder) => h.inGym(gym, () => PackageOrder.findOne({ 'metadata.dueFor': String(termOrder._id) }));

  async function call(method, url, { body, user } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer ${jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;
    const res = await fetch(base + url, { method, headers, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  // The member pays the link's checkout with "save my card" ticked; Safepay's
  // answer is applied as its webhook would apply it.
  async function payWithSavedCard(first, cardToken) {
    const renewal = await renewalFor(terms[first]);
    const token = await h.inGym(gym, () => links.issuePayLink(renewal).token);
    const page = await call('GET', `/api/pay/${token}`);
    assert.equal(page.status, 200);
    assert.deepEqual([page.body.data.provider, page.body.data.online_label, page.body.data.auto_pay_available], ['safepay', 'Card, JazzCash, Easypaisa or any bank app', true]);
    const opened = await call('POST', `/api/pay/${token}/checkout`, { body: { saveCard: true, autoPayConsent: true } });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.save_card, true);
    const url = new URL(opened.body.url);
    assert.equal(url.origin, fake.base);
    assert.equal(url.searchParams.get('redirect_url'), `${SITE}/pay/${token}?done=1`);
    const tracker = url.searchParams.get('tracker');
    assert.equal(fake.tracker(tracker).amount, 500000, 'exactly what the renewal owes, in paisa');
    fake.pay(tracker, { saveCard: { token: cardToken, last4: '4242', scheme: 1 } });
    await h.inGym(gym, () => safepay.applyTrackerPayment(renewal._id, tracker, { amountMinor: 500000, currency: 'PKR' }));
    const paid = await renewalFor(terms[first]);
    assert.deepEqual([paid.status, paid.payment.status], ['active', 'paid']);
    assert.equal((await call('GET', `/api/pay/${token}`)).body.data.status, 'paid');
    return paid;
  }

  test('a renewal paid through its link saves the card with consent; the member sees it', async () => {
    const made = await runJob(0);
    assert.equal(made.provider, 'safepay');
    assert.equal(made.autoChargeOn, true);
    terms.Ayesha2 = await payWithSavedCard('Ayesha', 'pm_ayesha');
    terms.Bilal2 = await payWithSavedCard('Bilal', 'pm_bilal');
    const cards = await call('GET', '/api/billing/me/saved-methods', { user: people.Ayesha });
    assert.equal(cards.status, 200);
    assert.deepEqual(cards.body.data.map((c) => [c.brand, c.last4, c.auto_pay]), [['Visa', '4242', true]]);
    assert.match(cards.body.data[0].consent_text, /^I allow .*Visa •••• 4242 for my membership \(5,000 PKR every month\)/);
  });

  test('a checkout opened before the member renewed at the desk still activates when it is paid after', async () => {
    const renewal = await renewalFor(terms.Cara);
    assert.ok(renewal, 'made by the first run');
    const token = await h.inGym(gym, () => links.issuePayLink(renewal).token);
    const opened = await call('POST', `/api/pay/${token}/checkout`, { body: {} });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const tracker = new URL(opened.body.url).searchParams.get('tracker');

    const membership = h.src('gymfolio/services/membershipService');
    await h.inGym(gym, async () => membership.renew(await PackageOrder.findById(terms.Cara._id), { paymentMethod: 'cash' }));
    const closed = await renewalFor(terms.Cara);
    assert.deepEqual([closed.status, closed.payment.status, closed.metadata.get('closedReason')], ['cancelled', 'failed', 'superseded']);
    assert.equal((await call('GET', `/api/pay/${token}`)).body.data.status, 'cancelled');

    // The member had already paid on Safepay's page: the payment lands, and counts.
    fake.pay(tracker);
    await h.inGym(gym, () => safepay.applyTrackerPayment(renewal._id, tracker, { amountMinor: 500000, currency: 'PKR' }));
    const paid = await renewalFor(terms.Cara);
    assert.deepEqual([paid.status, paid.payment.status], ['active', 'paid'], 'the member gets the term they paid for');
  });

  test('the next due date: the saved card is charged -- paid activates once, a decline leaves the renewal open with the link', async () => {
    fake.state.declined.add('pm_bilal');
    h.calls.emails.length = 0;
    h.calls.notifications.length = 0;
    // The renewed terms end a calendar month after the first ones did.
    const dueDays = Math.round((new Date(terms.Ayesha2.subscription.endDate).getTime() - t0.getTime()) / DAY);
    const lead = await runJob(dueDays - 3);
    assert.equal(lead.counts.created, 2, JSON.stringify(lead.skipped));
    assert.ok(h.calls.emails.some((e) => e.to === people.Ayesha.email && /due on/.test(e.subject)), 'told three days before');
    h.calls.emails.length = 0;
    const result = await runJob(dueDays);
    assert.equal(result.counts.charged, 1, JSON.stringify(result.quiet));
    assert.equal(result.counts.declined, 1);

    const ayesha = await renewalFor(terms.Ayesha2);
    assert.deepEqual([ayesha.status, ayesha.payment.status, ayesha.payment.provider], ['active', 'paid', 'safepay']);
    assert.equal(ayesha.payment.safepay.trackers[0].kind, 'auto');
    assert.equal(h.calls.notifications.filter((n) => n.name === 'membershipConfirmed' && String(n.args[0]._id) === String(ayesha._id)).length, 1, 'one receipt');

    const bilal = await renewalFor(terms.Bilal2);
    assert.deepEqual([bilal.status, bilal.payment.status, bilal.payment.lastPaymentError], ['pending', 'failed', 'Your card was declined']);
    assert.ok(await h.inGym(gym, () => links.payLinkUrlFor(bilal)), 'still payable by its link');
    assert.ok(h.calls.emails.some((e) => e.to === people.Bilal.email && /could not charge your saved card/.test(e.subject)));
    assert.ok(!h.calls.emails.some((e) => e.to === people.Ayesha.email), 'nothing to chase once paid');

    const charges = fake.callsTo('POST', '/order/payments/v3/').length;
    await runJob(dueDays);
    assert.equal(fake.callsTo('POST', '/order/payments/v3/').length, charges, 'charged once');
  });

  test('with the bank-transfer gateway chosen, the link offers only the transfer and receipt, and no card is charged', async () => {
    await h.inGym(gym, () => Settings.updateOne({ isActive: true }, { $set: { 'onlinePayments.provider': 'generic' } }));
    try {
      const bilal = await renewalFor(terms.Bilal2);
      const token = await h.inGym(gym, () => links.issuePayLink(bilal).token);
      const page = await call('GET', `/api/pay/${token}`);
      assert.deepEqual([page.body.data.provider, page.body.data.online_label, page.body.data.can_upload_proof, page.body.data.auto_pay_available], ['generic', null, true, false]);
      assert.equal((await call('POST', `/api/pay/${token}/checkout`, { body: {} })).body.code, 'ONLINE_PAYMENT_UNAVAILABLE');

      fake.state.declined.delete('pm_bilal');
      const before = fake.state.calls.length;
      const result = await runJob(Math.round((new Date(terms.Bilal2.subscription.endDate).getTime() - t0.getTime()) / DAY) + 1);
      assert.equal(result.provider, 'generic');
      assert.equal(result.autoChargeOn, false);
      assert.equal(fake.state.calls.length, before, 'Safepay is not called at all');
    } finally {
      await h.inGym(gym, () => Settings.updateOne({ isActive: true }, { $set: { 'onlinePayments.provider': 'safepay' } }));
    }
  });
}
