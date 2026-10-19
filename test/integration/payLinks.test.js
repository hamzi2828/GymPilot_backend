// Payment links over HTTP, through the real routes, with the payment
// gateway replaced by a fake (services/billing/provider.js
// setProviderForTests) -- nothing here reaches a real gateway, SMS or
// WhatsApp provider:
//
//   * GET /api/pay/:token shows the one order it opens -- gym, first name,
//     package, amount, dates, bank details -- and nothing of the member's
//     contact details; 'paid' once paid, 'cancelled' once closed;
//   * a tampered or another gym's link is 400 LINK_INVALID, an expired one
//     410 LINK_EXPIRED (but a paid order still reads paid);
//   * POST /api/pay/:token/checkout opens the gym's checkout for that order
//     and comes back to the page; the card is saved only with consent and
//     the gym's automatic charges on; no gateway means bank details only;
//   * staff make and send a link for an unpaid order;
//   * the member's own orders carry pay_link_url on an open renewal only.

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

const DAY = 86400000;
// .test hosts are served over plain HTTP (tenantContext.isInsecureHost).
const SITE = 'http://pay-links-gym.test';

let gym;
let other;
let T;
let User;
let Package;
let PackageOrder;
let Bank;
let Settings;
let job;
let provider;
let links;
let service;
let messaging;
let monthly;
let staff;
let member;
let term;
let renewal;
let server;
let base;

const checkouts = [];
const texts = [];

const fakeGateway = {
  id: 'safepay',
  label: 'Safepay',
  capabilities: { checkout: true, paymentLinks: true, savedCards: true, autoCharge: true, wallets: true, bankApps: true },
  async createCheckout(args) {
    checkouts.push(args);
    if (fakeGateway.failNext) {
      fakeGateway.failNext = false;
      throw new Error('gateway timed out');
    }
    return { url: `https://sandbox.gateway.test/checkout/trk_${checkouts.length}`, tracker: `trk_${checkouts.length}` };
  }
};

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  User = h.src('models/user');
  Package = h.src('gymfolio/models/packageModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Bank = h.src('models/bank');
  Settings = h.src('models/settings');
  job = h.src('services/billing/billingJob');
  provider = h.src('services/billing/provider');
  links = h.src('services/billing/payLinks');
  service = h.src('gymfolio/services/membershipService');
  messaging = h.src('services/messaging');
  provider.setProviderForTests(fakeGateway);
  // Text channels: recorded, never sent.
  for (const name of ['sendSms', 'sendWhatsApp']) {
    messaging[name] = async (to, body, meta) => {
      texts.push({ channel: name, to, body, meta });
      return { success: true };
    };
  }
  messaging.sendPush = async (userId, payload) => {
    texts.push({ channel: 'push', userId: String(userId), payload });
    return { success: true };
  };

  gym = await h.createGym('pay-links-gym', { name: 'Iron Gym', timezone: h.middayZone(), currency: 'PKR' });
  other = await h.createGym('pay-links-other', { timezone: h.middayZone(), currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder, User);
    monthly = await Package.create({ name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
    await Bank.create({ name: 'Meezan Bank', accountTitle: 'Iron Gym', accountNumber: '01010101', iban: 'PK36MEZN0000000001', qrCodeUrl: '/uploads/qr.png' });
    staff = await User.create({ firstName: 'Desk', lastName: 'Staff', email: 'desk@pay-links.test', role: 'admin' });
    member = await User.create({ firstName: 'Ayesha', lastName: 'Khan', email: 'ayesha@pay-links.test', phone: '03001234567', role: 'user' });
    const end = T.localInstant(T.shiftDateKey(T.dateKey(), 2), 12, 0);
    term = await PackageOrder.create({
      orderNumber: 'PAY-TERM',
      userId: member._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'Ayesha Khan', email: member.email, phone: member.phone },
      payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date() },
      subscription: { startDate: new Date(end.getTime() - 30 * DAY), endDate: end, isActive: true },
      status: 'active'
    });
    await job.runBillingJob();
    renewal = await PackageOrder.findOne({ 'metadata.dueFor': String(term._id) });
    assert.ok(renewal, 'the job made the renewal order');
  });

  const express = require('express');
  const app = express();
  app.use(express.json());
  // The tenant gate, as resolveTenant leaves it: the gym is the site's.
  app.use((req, res, next) => {
    const target = req.headers['x-test-gym'] === 'other' ? other : gym;
    req.tenant = target;
    h.inGym(target, async () => next()).catch(next);
  });
  app.use(h.src('routes/payLinkRoutes'));
  app.use('/api/gymfolio', h.src('gymfolio/routes/gymfolioRoutes'));
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

require('node:test').after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function bearer(user) {
  const token = jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

async function send(method, path, { body, user, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: bearer(user) } : {}), ...headers },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

const tokenOf = (order) => h.inGym(gym, () => links.issuePayLink(order).token);

test('the page shows the one order its link opens, with the bank alternative, and nothing private', async () => {
  const token = await tokenOf(renewal);
  const res = await send('GET', `/api/pay/${token}`);
  assert.equal(res.status, 200, res.text);
  const dueDate = await h.inGym(gym, () => T.dateKey(term.subscription.endDate));
  assert.deepEqual(
    { ...res.body.data, banks: undefined },
    {
      gym_name: 'Iron Gym',
      member_first_name: 'Ayesha',
      package_name: 'Monthly Unlimited',
      amount: 5000,
      currency: 'PKR',
      due_date: dueDate,
      last_day: await h.inGym(gym, () => T.shiftDateKey(dueDate, 3)),
      status: 'due',
      online_label: 'Card, JazzCash, Easypaisa or any bank app',
      order_number: renewal.orderNumber,
      can_save_card: false,
      banks: undefined
    }
  );
  assert.deepEqual(res.body.data.banks, [
    { name: 'Meezan Bank', account_title: 'Iron Gym', account_number: '01010101', iban: 'PK36MEZN0000000001', branch: '', notes: '', qr_code_url: '/uploads/qr.png' }
  ]);
  assert.doesNotMatch(res.text, /ayesha@pay-links\.test|03001234567|Khan/, 'no email, phone or surname');
});

test('a tampered link, or one carried to another gym, is LINK_INVALID; an expired one is LINK_EXPIRED', async () => {
  const token = await tokenOf(renewal);
  const [v, id, exp, sig] = token.split('.');
  for (const bad of [`${v}.${id}.${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, `${v}.${id}.${Number(exp) + 86400}.${sig}`, 'nonsense']) {
    for (const [method, path] of [['GET', `/api/pay/${bad}`], ['POST', `/api/pay/${bad}/checkout`]]) {
      const res = await send(method, path, { body: {} });
      assert.equal(res.status, 400, `${method} ${bad}`);
      assert.equal(res.body.code, 'LINK_INVALID');
    }
  }
  const elsewhere = await send('GET', `/api/pay/${token}`, { headers: { 'x-test-gym': 'other' } });
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.body.code, 'LINK_INVALID');

  // A link for an order that no longer exists is no link either.
  const ghost = await h.inGym(gym, () => links.issuePayLink({ _id: '6a9e47dadf00918e9825a7ff', metadata: {} }).token);
  assert.equal((await send('GET', `/api/pay/${ghost}`)).body.code, 'LINK_INVALID');

  // Expired: an ad-hoc link issued a month ago lasted a week.
  const old = await h.inGym(gym, () => links.issuePayLink({ _id: renewal._id, metadata: {} }, new Date(Date.now() - 30 * DAY)).token);
  const gone = await send('GET', `/api/pay/${old}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, 'LINK_EXPIRED');
  assert.equal(gone.body.data.status, 'expired');
  assert.equal(gone.body.data.online_label, null, 'nothing to pay through');
  const late = await send('POST', `/api/pay/${old}/checkout`, { body: {} });
  assert.equal(late.status, 410);
  assert.equal(late.body.code, 'LINK_EXPIRED');
});

test('Pay now opens the gym checkout for that order and comes back to the page', async () => {
  const token = await tokenOf(renewal);
  checkouts.length = 0;
  const res = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.url, 'https://sandbox.gateway.test/checkout/trk_1');
  assert.equal(res.body.save_card, false);
  const [args] = checkouts;
  assert.equal(String(args.order._id), String(renewal._id));
  assert.equal(args.amount, 5000);
  assert.equal(args.currency, 'PKR');
  assert.deepEqual(args.customer, { name: 'Ayesha Khan', email: 'ayesha@pay-links.test', phone: '03001234567' });
  assert.equal(args.returnUrl, `${SITE}/pay/${token}?done=1`);
  assert.equal(args.cancelUrl, `${SITE}/pay/${token}`);
  assert.equal(args.saveCard, false);
});

test('the card is saved only with consent and with the gym\'s automatic charges switched on', async () => {
  const token = await tokenOf(renewal);
  checkouts.length = 0;
  // Consent, but the gym has not switched automatic charges on.
  let res = await send('POST', `/api/pay/${token}/checkout`, { body: { saveCard: true, autoPayConsent: true } });
  assert.equal(res.body.save_card, false);
  await h.inGym(gym, () => Settings.updateOne({}, { $set: { 'billing.autoCharge.enabled': true } }));
  try {
    assert.equal((await send('GET', `/api/pay/${token}`)).body.data.can_save_card, true);
    // On, but no consent ticked.
    res = await send('POST', `/api/pay/${token}/checkout`, { body: { saveCard: true } });
    assert.equal(res.body.save_card, false);
    res = await send('POST', `/api/pay/${token}/checkout`, { body: { saveCard: true, autoPayConsent: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.save_card, true);
    assert.deepEqual(checkouts.map((c) => c.saveCard), [false, false, true]);
    const stored = await h.inGym(gym, () => PackageOrder.findById(renewal._id).lean());
    assert.equal(stored.metadata.autoPayConsent, 'true');
    assert.ok(!Number.isNaN(Date.parse(stored.metadata.autoPayConsentAt)));
  } finally {
    await h.inGym(gym, () => Settings.updateOne({}, { $set: { 'billing.autoCharge.enabled': false } }));
  }
});

test('a gateway that fails is a 502 the page can retry; no gateway means bank details only', async () => {
  const token = await tokenOf(renewal);
  fakeGateway.failNext = true;
  const failed = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'CHECKOUT_FAILED');

  provider.setProviderForTests(null);
  try {
    const page = await send('GET', `/api/pay/${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.data.status, 'due');
    assert.equal(page.body.data.online_label, null);
    assert.equal(page.body.data.banks.length, 1);
    const res = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ONLINE_PAYMENT_UNAVAILABLE');
  } finally {
    provider.setProviderForTests(fakeGateway);
  }
});

test('the member\'s own orders carry pay_link_url on the open renewal only, also after a declined card', async () => {
  const mine = async () => {
    const res = await send('GET', '/api/gymfolio/package-orders/me', { user: member });
    assert.equal(res.status, 200, res.text);
    return Object.fromEntries(res.body.data.map((o) => [o.orderNumber, o]));
  };
  const token = await tokenOf(renewal);
  let orders = await mine();
  assert.equal(orders[renewal.orderNumber].pay_link_url, `${SITE}/pay/${token}`);
  assert.equal(orders['PAY-TERM'].pay_link_url, null);
  assert.equal(orders[renewal.orderNumber].metadata.dueDate, renewal.metadata.get('dueDate'));

  await h.inGym(gym, () =>
    PackageOrder.updateOne({ _id: renewal._id }, { $set: { 'payment.status': 'failed', 'payment.lastPaymentError': 'Your card was declined' } })
  );
  orders = await mine();
  assert.equal(orders[renewal.orderNumber].pay_link_url, `${SITE}/pay/${token}`);
  assert.equal(orders[renewal.orderNumber].payment.lastPaymentError, 'Your card was declined');
  assert.equal((await send('GET', `/api/pay/${token}`)).body.data.status, 'due', 'still payable after a decline');
  await h.inGym(gym, () => PackageOrder.updateOne({ _id: renewal._id }, { $set: { 'payment.status': 'pending', 'payment.lastPaymentError': '' } }));
});

test('staff make a link for an unpaid order and send it on the gym\'s billing channels', async () => {
  await h.inGym(gym, () => Settings.updateOne({}, { $set: { 'billing.sendVia': { email: true, sms: true, whatsapp: false, push: true } } }));
  h.calls.emails.length = 0;
  texts.length = 0;
  try {
    const quiet = await send('POST', `/api/gymfolio/package-orders/${renewal._id}/pay-link`, { user: staff, body: {} });
    assert.equal(quiet.status, 200, quiet.text);
    const token = await tokenOf(renewal);
    assert.equal(quiet.body.url, `${SITE}/pay/${token}`);
    assert.equal(quiet.body.data.url, quiet.body.url);
    assert.ok(!Number.isNaN(Date.parse(quiet.body.expires_at)));
    assert.equal(quiet.body.sent, undefined, 'not asked to send');
    assert.equal(h.calls.emails.length, 0);

    const sent = await send('POST', `/api/gymfolio/package-orders/${renewal._id}/pay-link`, { user: staff, body: { send: true } });
    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(sent.body.sent, { email: true, sms: true, whatsapp: false, push: true });
    const [email] = h.calls.emails;
    assert.equal(email.to, 'ayesha@pay-links.test');
    assert.match(email.subject, /^Iron Gym: your payment link$/);
    assert.ok(email.html.includes(`${SITE}/pay/${token}`), 'the link is in the email');
    assert.match(email.html, /Meezan Bank/);
    assert.match(email.html, /PK36MEZN0000000001/);
    assert.match(email.html, /Sent with GymsPilotPro/);
    assert.match(email.html, /Pay now/);
    const sms = texts.find((t) => t.channel === 'sendSms');
    assert.equal(sms.to, '03001234567');
    assert.match(sms.body, /^Iron Gym: hi Ayesha, your payment link for Monthly Unlimited \(1 month\), PKR 5,000, due \d{2} \w{3} \d{4} \(last day to pay \d{2} \w{3} \d{4}\): http:\/\/pay-links-gym\.test\/pay\/GPP1\./);
    assert.match(sms.body, /Or pay by bank transfer \/ Raast \(no fee\): Meezan Bank, Iron Gym, IBAN PK36MEZN0000000001\./);
    const push = texts.find((t) => t.channel === 'push');
    assert.equal(push.userId, String(member._id));
    assert.equal(push.payload.title, 'Iron Gym');
    assert.equal(push.payload.url, `${SITE}/pay/${token}`);
  } finally {
    await h.inGym(gym, () => Settings.updateOne({}, { $unset: { 'billing.sendVia': 1 } }));
  }
});

test('the member\'s own preferences are kept: a channel they switched off is not used', async () => {
  await h.inGym(gym, async () => {
    await Settings.updateOne({}, { $set: { 'billing.sendVia': { email: true, sms: true, whatsapp: true, push: true } } });
    await User.updateOne({ _id: member._id }, { $set: { 'notificationPreferences.sms': false, 'notificationPreferences.email': false } });
  });
  h.calls.emails.length = 0;
  texts.length = 0;
  try {
    const res = await send('POST', `/api/gymfolio/package-orders/${renewal._id}/pay-link`, { user: staff, body: { send: true } });
    assert.deepEqual(res.body.sent, { email: false, sms: false, whatsapp: true, push: true });
    assert.equal(res.body.data.skipped.email, 'member has email off');
    assert.equal(res.body.data.skipped.sms, 'member has sms off');
    assert.equal(h.calls.emails.length, 0);
    assert.deepEqual(texts.map((t) => t.channel).sort(), ['push', 'sendWhatsApp']);
  } finally {
    await h.inGym(gym, async () => {
      await Settings.updateOne({}, { $unset: { 'billing.sendVia': 1 } });
      await User.updateOne({ _id: member._id }, { $set: { 'notificationPreferences.sms': true, 'notificationPreferences.email': true } });
    });
  }
});

test('staff cannot link a paid or closed order; members cannot make links; a bad id is not found', async () => {
  const paidOrder = await h.inGym(gym, () => PackageOrder.findById(term._id));
  const paid = await send('POST', `/api/gymfolio/package-orders/${paidOrder._id}/pay-link`, { user: staff, body: {} });
  assert.equal(paid.status, 409);
  assert.equal(paid.body.code, 'ALREADY_PAID');
  const memberTry = await send('POST', `/api/gymfolio/package-orders/${renewal._id}/pay-link`, { user: member, body: {} });
  assert.equal(memberTry.status, 403);
  const missing = await send('POST', '/api/gymfolio/package-orders/not-an-id/pay-link', { user: staff, body: {} });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'ORDER_NOT_FOUND');
});

test('once paid the link reads paid -- even past its expiry -- and checkout says so; a closed order reads cancelled', async () => {
  const token = await tokenOf(renewal);
  await h.inGym(gym, async () => {
    const doc = await PackageOrder.findById(renewal._id);
    await service.markPaidAndActivate(doc, { paidAt: new Date(), transactionId: 'trk_paid' });
  });
  const page = await send('GET', `/api/pay/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.status, 'paid');
  assert.equal(page.body.data.online_label, null);
  const again = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.status, again.body.url], ['paid', null]);
  const old = await h.inGym(gym, () => links.issuePayLink({ _id: renewal._id, metadata: {} }, new Date(Date.now() - 30 * DAY)).token);
  assert.equal((await send('GET', `/api/pay/${old}`)).body.data.status, 'paid', 'paid wins over expired');
  const mine = await send('GET', '/api/gymfolio/package-orders/me', { user: member });
  assert.equal(mine.body.data.find((o) => o.orderNumber === renewal.orderNumber).pay_link_url, null, 'no longer due once paid');

  // A renewal closed because the member renewed at the desk instead.
  const closed = await h.inGym(gym, async () => {
    const order = await PackageOrder.create({
      orderNumber: 'PAY-CLOSED',
      userId: member._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'Ayesha Khan' },
      payment: { method: 'online', amount: 5000, currency: 'pkr', status: 'failed' },
      status: 'cancelled',
      metadata: { dueFor: '6a9e47dadf00918e9825a7aa', dueDate: T.dateKey(), lastDay: T.dateKey(), closedReason: 'superseded' }
    });
    return links.issuePayLink(order).token;
  });
  const shut = await send('GET', `/api/pay/${closed}`);
  assert.equal(shut.status, 200);
  assert.equal(shut.body.data.status, 'cancelled');
  const refused = await send('POST', `/api/pay/${closed}/checkout`, { body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'LINK_CANCELLED');
});

test('opening checkouts is rate-limited per address', async () => {
  const token = await tokenOf(renewal);
  let limited = null;
  for (let i = 0; i < 25 && !limited; i += 1) {
    const res = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'a 429 within 25 attempts');
  assert.equal(limited.body.code, 'RATE_LIMITED');
});
