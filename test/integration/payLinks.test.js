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
//   * the member's own orders carry pay_link_url on an open renewal only;
//   * a bank-transfer receipt uploaded on the link's page goes into the
//     gym's existing transfer verification: approve -> paid and renewed;
//     reject -> the member is told, and the same link takes a new receipt;
//   * a bank-transfer-only gateway ('generic') offers only that.

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
  },
  // Never reached here: no due-date charge runs in this file.
  async chargeSavedMethod() {
    throw new Error('not in these tests');
  }
};

const test = h.suite(async () => {
  // Before any model loads (helpers/onlineMethod.js).
  require('./helpers/onlineMethod')(h);
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
      period: '1 month',
      amount: 5000,
      currency: 'PKR',
      due_date: dueDate,
      last_day: await h.inGym(gym, () => T.shiftDateKey(dueDate, 3)),
      status: 'due',
      provider: 'safepay',
      online_label: 'Card, JazzCash, Easypaisa or any bank app',
      order_number: renewal.orderNumber,
      can_upload_proof: true,
      proof: { status: 'none', reason: '', submitted_at: null },
      auto_pay_available: false,
      can_save_card: false,
      banks: undefined
    }
  );
  const bank = await h.inGym(gym, () => Bank.findOne({}).lean());
  assert.deepEqual(res.body.data.banks, [
    { id: String(bank._id), bank_name: 'Meezan Bank', account_title: 'Iron Gym', account_number: '01010101', iban: 'PK36MEZN0000000001', branch: '', notes: '', qr_code_url: '/uploads/qr.png' }
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
  await h.inGym(gym, () => Settings.collection.updateOne({}, { $set: { 'billing.autoCharge.enabled': true } }));
  try {
    const on = (await send('GET', `/api/pay/${token}`)).body.data;
    assert.equal(on.can_save_card, true);
    assert.equal(on.auto_pay_available, true);
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
    await h.inGym(gym, () => Settings.collection.updateOne({}, { $set: { 'billing.autoCharge.enabled': false } }));
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
  await h.inGym(gym, () => Settings.collection.updateOne({}, { $set: { 'billing.sendVia': { email: true, sms: true, whatsapp: false, push: true } } }));
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
    await h.inGym(gym, () => Settings.collection.updateOne({}, { $unset: { 'billing.sendVia': 1 } }));
  }
});

test('the member\'s own preferences are kept: a channel they switched off is not used', async () => {
  await h.inGym(gym, async () => {
    await Settings.collection.updateOne({}, { $set: { 'billing.sendVia': { email: true, sms: true, whatsapp: true, push: true } } });
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
      await Settings.collection.updateOne({}, { $unset: { 'billing.sendVia': 1 } });
      await User.updateOne({ _id: member._id }, { $set: { 'notificationPreferences.sms': true, 'notificationPreferences.email': true } });
    });
  }
});

test('the admin order list filters by member, payment status and method, and counts every match', async () => {
  const list = (query) => send('GET', `/api/gymfolio/package-orders?${query}`, { user: staff });
  const hers = await list(`userId=${member._id}&limit=1`);
  assert.equal(hers.status, 200, hers.text);
  const all = await h.inGym(gym, () => PackageOrder.countDocuments({ userId: member._id }));
  assert.ok(all >= 2);
  assert.equal(hers.body.pagination.total, all, 'every match counted, past the page');
  assert.equal(hers.body.data.length, 1);
  const theirs = await list(`userId=${staff._id}`);
  assert.equal(theirs.body.pagination.total, 0);
  assert.equal((await list('userId=nope')).status, 400);
  const online = await list(`userId=${member._id}&paymentMethod=online&paymentStatus=pending`);
  assert.ok(online.body.data.every((o) => o.payment.method === 'online' && o.payment.status === 'pending' && String(o.userId._id || o.userId) === String(member._id)));
  assert.ok(online.body.pagination.total >= 1);
  assert.equal((await send('GET', '/api/gymfolio/package-orders', { user: member })).status, 403, 'still staff only');
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

/* --------------------- bank transfer + receipt, through the link --------------------- */

const fs = require('fs');
const path = require('path');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
const stored = [];

async function upload(token, { file = PNG, type = 'image/png', name = 'receipt.png', reference } = {}) {
  const form = new FormData();
  if (file) form.append('proof', new Blob([file], { type }), name);
  if (reference) form.append('reference', reference);
  const res = await fetch(`${base}/api/pay/${token}/proof`, { method: 'POST', body: form });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

require('node:test').after(() => {
  const root = path.resolve(__dirname, '..', '..');
  for (const url of stored) fs.promises.unlink(path.join(root, url)).catch(() => {});
});

async function freshRenewal(first) {
  return h.inGym(gym, async () => {
    const who = await User.create({ firstName: first, lastName: 'Transfer', email: `${first.toLowerCase()}@pay-links.test`, role: 'user' });
    const end = T.localInstant(T.shiftDateKey(T.dateKey(), 2), 12, 0);
    const current = await PackageOrder.create({
      orderNumber: `PAY-${first.toUpperCase()}`,
      userId: who._id,
      packageId: monthly._id,
      packageDetails: { name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: `${first} Transfer`, email: who.email },
      payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date() },
      subscription: { startDate: new Date(end.getTime() - 30 * DAY), endDate: end, isActive: true },
      status: 'active'
    });
    await job.runBillingJob();
    return { who, current, order: await PackageOrder.findOne({ 'metadata.dueFor': String(current._id) }) };
  });
}

test('a receipt uploaded on the link page goes into the gym\'s bank-transfer verification; approved, the renewal is paid', async () => {
  const { who, current, order } = await freshRenewal('Bilal');
  const token = await tokenOf(order);
  h.calls.notifications.length = 0;

  const sent = await upload(token, { reference: 'RAAST-7781' });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.body.data.proof.status, 'submitted');
  assert.ok(!Number.isNaN(Date.parse(sent.body.data.proof.submitted_at)));

  const queued = await h.inGym(gym, () => PackageOrder.findById(order._id).lean());
  assert.deepEqual([queued.status, queued.payment.method, queued.payment.status], ['pending', 'bank_transfer', 'processing']);
  assert.match(queued.payment.proof.url, /^\/uploads\/.+\.png$/);
  stored.push(queued.payment.proof.url);
  assert.equal(queued.payment.proof.reference, 'RAAST-7781');
  assert.equal(queued.metadata.proofVia, 'pay_link');
  // Staff see it where they see every transfer to confirm (the admin bell's query).
  assert.ok(await h.inGym(gym, () => PackageOrder.exists({ _id: order._id, 'payment.method': 'bank_transfer', 'payment.status': 'processing', 'payment.proof.uploadedAt': { $ne: null } })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(h.calls.notifications.some((n) => n.name === 'transferReceived' && String(n.args[0]._id) === String(order._id)), 'the member is told it arrived');

  // While it is being checked: no second payment through the link.
  const page = await send('GET', `/api/pay/${token}`);
  assert.equal(page.body.data.status, 'due');
  assert.equal(page.body.data.proof.status, 'submitted');
  const card = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
  assert.equal(card.status, 409);
  assert.match(card.body.message, /receipt is with the gym to confirm/);

  const approved = await send('POST', `/api/gymfolio/package-orders/${order._id}/approve`, { user: staff, body: {} });
  assert.equal(approved.status, 200, approved.text);
  const paid = await h.inGym(gym, () => PackageOrder.findById(order._id).lean());
  assert.deepEqual([paid.status, paid.payment.status], ['active', 'paid']);
  assert.equal(new Date(paid.subscription.startDate).getTime(), current.subscription.endDate.getTime(), 'renewed from the end of the term');
  const after = await send('GET', `/api/pay/${token}`);
  assert.deepEqual([after.body.data.status, after.body.data.proof.status], ['paid', 'approved']);
  const again = await upload(token);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ALREADY_PAID');
  void who;
});

test('a rejected receipt: the member is told with the same link, which takes a new one', async () => {
  const { order } = await freshRenewal('Sana');
  const token = await tokenOf(order);
  const first = await upload(token);
  assert.equal(first.status, 200, first.text);
  stored.push((await h.inGym(gym, () => PackageOrder.findById(order._id).lean())).payment.proof.url);

  h.calls.notifications.length = 0;
  const rejected = await send('POST', `/api/gymfolio/package-orders/${order._id}/reject`, { user: staff, body: { reason: 'The amount does not match' } });
  assert.equal(rejected.status, 200, rejected.text);
  const reopened = await h.inGym(gym, () => PackageOrder.findById(order._id).lean());
  assert.deepEqual([reopened.status, reopened.payment.method, reopened.payment.status], ['pending', 'bank_transfer', 'failed'], 'open again, not closed');
  const mine = await send('GET', '/api/gymfolio/package-orders/me', { user: await h.inGym(gym, () => User.findById(order.userId).lean()) });
  assert.equal(mine.body.data.find((o) => o.orderNumber === order.orderNumber).pay_link_url, `${SITE}/pay/${token}`, 'Pay now stays in the member portal');
  assert.equal(reopened.payment.proof.rejectionReason, 'The amount does not match');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const notice = h.calls.notifications.find((n) => n.name === 'transferRejected');
  assert.ok(notice, 'the member is told');
  assert.equal(await h.inGym(gym, () => links.payLinkUrlFor(notice.args[0])), `${SITE}/pay/${token}`, 'with the same link');

  const page = await send('GET', `/api/pay/${token}`);
  assert.equal(page.body.data.status, 'due');
  assert.deepEqual([page.body.data.proof.status, page.body.data.proof.reason], ['rejected', 'The amount does not match']);
  assert.equal(page.body.data.can_upload_proof, true);

  const second = await upload(token, { file: PDF, type: 'application/pdf', name: 'receipt.pdf' });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.data.proof.status, 'submitted');
  const queued = await h.inGym(gym, () => PackageOrder.findById(order._id).lean());
  stored.push(queued.payment.proof.url);
  assert.match(queued.payment.proof.url, /\.pdf$/);
  assert.equal(queued.payment.proof.rejectionReason, '');
  assert.equal(queued.payment.status, 'processing');
});

test('the receipt upload keeps the receipt rules and the link rules', async () => {
  const { order } = await freshRenewal('Omar');
  const token = await tokenOf(order);
  const html = await upload(token, { file: Buffer.from('<html></html>'), type: 'text/html', name: 'x.html' });
  assert.equal(html.status, 400);
  assert.equal(html.body.code, 'FILE_NOT_ALLOWED');
  const fake = await upload(token, { file: Buffer.from('<script>1</script>'), type: 'application/pdf', name: 'x.pdf' });
  assert.equal(fake.status, 400, 'a "PDF" that is not one');
  const nothing = await upload(token, { file: null });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.code, 'PROOF_REQUIRED');
  assert.equal((await upload('GPP1.nonsense')).body.code, 'LINK_INVALID');
  const old = await h.inGym(gym, () => links.issuePayLink({ _id: order._id, metadata: {} }, new Date(Date.now() - 30 * DAY)).token);
  assert.equal((await upload(old)).status, 410);

  // No bank account to transfer to: nothing to upload a receipt for.
  await h.inGym(gym, () => Bank.updateMany({}, { $set: { isActive: false } }));
  try {
    const none = await upload(token);
    assert.equal(none.status, 409);
    assert.equal(none.body.code, 'BANK_TRANSFER_UNAVAILABLE');
    assert.equal((await send('GET', `/api/pay/${token}`)).body.data.can_upload_proof, false);
  } finally {
    await h.inGym(gym, () => Bank.updateMany({}, { $set: { isActive: true } }));
  }
  const unchanged = await h.inGym(gym, () => PackageOrder.findById(order._id).lean());
  assert.deepEqual([unchanged.payment.method, unchanged.payment.status], ['online', 'pending'], 'nothing refused was recorded');
});

test('a bank-transfer-only gateway (generic) offers the transfer and the upload, and no online checkout', async () => {
  const { order } = await freshRenewal('Zara');
  const token = await tokenOf(order);
  provider.setProviderForTests({ id: 'generic', label: 'Generic', capabilities: { checkout: false, paymentLinks: true, receiptUpload: true, savedCards: false, autoCharge: false } });
  try {
    const page = await send('GET', `/api/pay/${token}`);
    assert.equal(page.body.data.provider, 'generic');
    assert.equal(page.body.data.online_label, null);
    assert.equal(page.body.data.can_upload_proof, true);
    assert.equal(page.body.data.can_save_card, false);
    const card = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
    assert.equal(card.status, 409);
    assert.equal(card.body.code, 'ONLINE_PAYMENT_UNAVAILABLE');
    const sent = await upload(token);
    assert.equal(sent.status, 200, sent.text);
    stored.push((await h.inGym(gym, () => PackageOrder.findById(order._id).lean())).payment.proof.url);
  } finally {
    provider.setProviderForTests(fakeGateway);
  }
});

// Last: it uses up the address's checkout allowance for the rest of the file.
test('opening checkouts is rate-limited per address', async () => {
  const token = await tokenOf(renewal);
  let limited = null;
  for (let i = 0; i < 25 && !limited; i += 1) {
    const res = await send('POST', `/api/pay/${token}/checkout`, { body: {} });
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'a 429 within 25 attempts');
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.match(limited.body.message, /Too many payment attempts/);
});
