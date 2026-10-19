// The daily billing job (services/billing/billingJob.js) over a renewal's
// whole life, against a real MongoDB, with the payment gateway replaced by
// fakes and every text channel recorded instead of sent:
//
//   * three days before: the "due on <date>" message with the link, once --
//     however often, or however many at once, the job runs -- telling a
//     member with an auto-pay card it will be charged;
//   * the due day: a saved card is charged first -- paid means activated
//     with one receipt and no reminder, declined means the order says so
//     and the member gets the link with "your card was declined" -- and
//     everyone else gets the due-day message;
//   * the last day: the final link to whoever has still not paid; after it,
//     nothing more;
//   * a gym with automatic charges off, or on a gateway that cannot charge
//     (the bank-transfer "generic" one), never charges a card;
//   * a message no channel took is tried again on the next run;
//   * the old expiry notice is not sent on top for a term the links cover.
//
// Time is moved by handing the job its `now`; the gyms' clocks are set to
// midday (h.middayZone) so day arithmetic never straddles midnight.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const DAY = 86400000;

let T;
let User;
let Package;
let PackageOrder;
let Bank;
let Settings;
let job;
let provider;
let links;
let messaging;
let payments;
let secretBox;
let reminders;
let tenant;

const gyms = {};
const people = {};
const terms = {};
const charges = [];
const texts = [];
let t0;

// What each fake gateway answers when asked to charge a member's card.
const chargeResults = {};

function gateway(id, { autoCharge = true, checkout = true } = {}) {
  return {
    id,
    label: id,
    capabilities: { checkout, paymentLinks: true, savedCards: autoCharge, autoCharge, receiptUpload: !checkout },
    async createCheckout() {
      return { url: `https://gateway.test/${id}`, tracker: 'trk' };
    },
    async chargeSavedMethod(args) {
      const order = await PackageOrder.findById(args.order._id);
      charges.push({ gym: tenant.currentTenantSlug(), order: order.orderNumber, userId: String(order.userId), amount: args.amount, currency: args.currency, savedMethod: args.savedMethod });
      const plan = chargeResults[String(order.userId)] || { status: 'failed', reason: 'no plan' };
      // A gateway that records the payment itself, as Safepay's does.
      if (plan.recordsItself) await payments.activateOnce(order, async () => ({ transactionId: 'trk_self' }));
      return { status: plan.status, tracker: plan.tracker || `trk_${charges.length}`, reason: plan.reason || '' };
    }
  };
}

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
  messaging = h.src('services/messaging');
  payments = h.src('services/gymfolioPaymentService');
  secretBox = h.src('services/secretBox');
  reminders = h.src('services/reminderJobs');
  tenant = h.src('platform/tenantContext');

  const byGym = {
    'billing-job-gym': gateway('safepay'),
    'billing-noauto-gym': gateway('safepay'),
    'billing-generic-gym': gateway('generic', { autoCharge: false, checkout: false })
  };
  provider.setProviderForTests(() => byGym[tenant.currentTenantSlug()] || null);
  for (const name of ['sendSms', 'sendWhatsApp']) {
    messaging[name] = async (to, body, meta) => {
      texts.push({ channel: name, gym: tenant.currentTenantSlug(), to, body, userId: String(meta.userId) });
      return { success: true };
    };
  }
  messaging.sendPush = async (userId, payload) => {
    texts.push({ channel: 'push', gym: tenant.currentTenantSlug(), userId: String(userId), body: payload.body, url: payload.url });
    return { success: true };
  };

  const zone = h.middayZone();
  for (const [slug, name, autoCharge] of [
    ['billing-job-gym', 'Iron Gym', true],
    ['billing-noauto-gym', 'Steel Gym', false],
    ['billing-generic-gym', 'Bronze Gym', true]
  ]) {
    gyms[slug] = await h.createGym(slug, { name, timezone: zone, currency: 'PKR' });
    // The billing block, written straight to the document (its schema comes
    // with the gateway work): these gyms also send by WhatsApp.
    await h.inGym(gyms[slug], () => Settings.collection.updateOne({}, { $set: { billing: { autoCharge: { enabled: autoCharge }, sendVia: { email: true, sms: false, whatsapp: true, push: true } } } }));
  }

  t0 = new Date();
  for (const [slug, names] of [
    ['billing-job-gym', ['ann', 'bob', 'cat', 'dan', 'eve']],
    ['billing-noauto-gym', ['fay']],
    ['billing-generic-gym', ['gus']]
  ]) {
    await h.inGym(gyms[slug], async () => {
      await h.ensureIndexes(PackageOrder, User);
      await Bank.create({ name: 'Meezan Bank', accountTitle: gyms[slug].name, accountNumber: '0101', iban: 'PK36MEZN0000000001' });
      const pkg = await Package.create({ name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'] });
      const end = T.localInstant(T.shiftDateKey(T.dateKey(t0), 3), 12, 0);
      for (const first of names) {
        const user = await User.create({ firstName: first[0].toUpperCase() + first.slice(1), lastName: 'Member', email: `${first}@billing-job.test`, phone: `0300${String(names.indexOf(first)).padStart(7, '0')}` });
        people[first] = user;
        terms[first] = await PackageOrder.create({
          orderNumber: `JOB-${first.toUpperCase()}`,
          userId: user._id,
          packageId: pkg._id,
          packageDetails: { name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month' },
          customerInfo: { fullName: `${user.firstName} Member`, email: user.email, phone: user.phone },
          payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date() },
          subscription: { startDate: new Date(end.getTime() - 30 * DAY), endDate: end, isActive: true },
          status: 'active'
        });
      }
    });
  }

  // Saved cards, as the gateway's webhook leaves them (token sealed).
  const card = (id, extra = {}) => ({
    id,
    provider: 'safepay',
    token: secretBox.seal(`pm_${id}`),
    customerToken: `cus_${id}`,
    brand: 'Visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2035,
    autoPay: true,
    consentAt: new Date(),
    consentText: 'I allow ...',
    createdAt: new Date(),
    ...extra
  });
  const saveCards = (slug, first, methods) => h.inGym(gyms[slug], () => User.collection.updateOne({ _id: people[first]._id }, { $set: { billing: { savedMethods: methods } } }));
  await saveCards('billing-job-gym', 'bob', [card('card_bob')]);
  await saveCards('billing-job-gym', 'cat', [card('card_cat')]);
  await saveCards('billing-job-gym', 'dan', [card('card_dan')]);
  await saveCards('billing-job-gym', 'eve', [card('card_eve', { expMonth: 1, expYear: 2020 })]);
  await saveCards('billing-noauto-gym', 'fay', [card('card_fay')]);
  await saveCards('billing-generic-gym', 'gus', [card('card_gus', { provider: 'generic' })]);
  chargeResults[String(people.bob._id)] = { status: 'paid' };
  chargeResults[String(people.cat._id)] = { status: 'failed', reason: 'TRACKER_DECLINED: do not honour' };
  chargeResults[String(people.dan._id)] = { status: 'paid', recordsItself: true };
});

const at = (days) => new Date(t0.getTime() + days * DAY);
const run = (slug, days, options = {}) => h.inGym(gyms[slug], () => job.runBillingJob({ now: at(days), ...options }));
const renewalOf = (slug, first) => h.inGym(gyms[slug], () => PackageOrder.findOne({ 'metadata.dueFor': String(terms[first]._id) }).lean());
const emailsTo = (first) => h.calls.emails.filter((e) => e.to === `${first}@billing-job.test`);
const subjects = (first) => emailsTo(first).map((e) => e.subject);
const receiptsFor = (order) => h.calls.notifications.filter((n) => n.name === 'membershipConfirmed' && String(n.args[0]._id) === String(order._id));

test('three days before: one "due on" message each with the link and the bank details, however often the job runs', async () => {
  h.calls.emails.length = 0;
  texts.length = 0;
  const first = await run('billing-job-gym', 0);
  assert.equal(first.enabled, true, JSON.stringify(first));
  assert.equal(first.autoChargeOn, true);
  assert.equal(first.counts.created, 5);
  assert.equal(first.counts.sent, 5, JSON.stringify(first.quiet));

  const dueDate = await h.inGym(gyms['billing-job-gym'], () => T.dateLabelForKey(T.shiftDateKey(T.dateKey(t0), 3)));
  const lastDay = await h.inGym(gyms['billing-job-gym'], () => T.dateLabelForKey(T.shiftDateKey(T.dateKey(t0), 6)));
  for (const who of ['ann', 'bob', 'cat', 'dan', 'eve']) assert.deepEqual(subjects(who), [`Iron Gym: your renewal is due on ${dueDate}`], who);

  const renewal = await renewalOf('billing-job-gym', 'ann');
  const url = await h.inGym(gyms['billing-job-gym'], () => links.issuePayLink(renewal).url);
  const [mail] = emailsTo('ann');
  assert.ok(mail.html.includes(url), 'the payment link');
  assert.match(mail.html, /Monthly Unlimited/);
  assert.match(mail.html, /1 month/);
  assert.match(mail.html, /PKR 5,000/);
  assert.ok(mail.html.includes(lastDay), 'the last day to pay');
  assert.match(mail.html, /Meezan Bank/);
  assert.match(mail.html, /Sent with GymsPilotPro/);
  assert.doesNotMatch(mail.html, /charge your saved card/);
  assert.match(emailsTo('bob')[0].html, /we will charge your saved card Visa •••• 4242 on the due date/);
  assert.doesNotMatch(emailsTo('eve')[0].html, /we will charge/, 'an expired card will not be charged');

  // The WhatsApp message carries the package, period, amount, both dates and the link.
  const wa = texts.find((x) => x.channel === 'sendWhatsApp' && x.userId === String(people.ann._id));
  assert.equal(
    wa.body,
    `Iron Gym: hi Ann, your Monthly Unlimited (1 month) renewal of PKR 5,000 is due on ${dueDate} (last day to pay ${lastDay}). Pay here: ${url} Or pay by bank transfer / Raast (no fee): Meezan Bank, Iron Gym, IBAN PK36MEZN0000000001.`
  );
  assert.ok(texts.some((x) => x.channel === 'push' && x.userId === String(people.ann._id) && x.url === url));
  assert.ok(!texts.some((x) => x.channel === 'sendSms'), 'SMS is off for billing by default');
  assert.equal(renewal.metadata.billingNotices, `before3@${T.shiftDateKey(T.dateKey(t0), 3)}`);

  // Again, and twice at once: nothing more.
  await run('billing-job-gym', 0);
  await Promise.all([run('billing-job-gym', 0), run('billing-job-gym', 0)]);
  await run('billing-job-gym', 1);
  assert.equal(h.calls.emails.length, 5);
});

test('a dry run says what it would do and sends, charges and writes nothing', async () => {
  h.calls.emails.length = 0;
  charges.length = 0;
  const dry = await run('billing-job-gym', 3, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(h.calls.emails.length, 0);
  assert.equal(charges.length, 0);
  assert.equal(dry.quiet.filter((row) => row.charge && row.charge.outcome === 'dry run').length, 4, 'bob, cat and dan would be charged; eve told her card expired');
  assert.equal((await renewalOf('billing-job-gym', 'bob')).payment.status, 'pending');
});

test('the due day: saved cards are charged first -- paid is activated with one receipt, declined gets the link -- the rest the due-day message', async () => {
  h.calls.emails.length = 0;
  h.calls.notifications.length = 0;
  charges.length = 0;
  const result = await run('billing-job-gym', 3);

  assert.deepEqual(charges.map((c) => c.order).sort(), [(await renewalOf('billing-job-gym', 'bob')).orderNumber, (await renewalOf('billing-job-gym', 'cat')).orderNumber, (await renewalOf('billing-job-gym', 'dan')).orderNumber].sort());
  const bobCharge = charges.find((c) => c.userId === String(people.bob._id));
  assert.equal(bobCharge.amount, 5000);
  assert.equal(bobCharge.currency, 'PKR');
  assert.equal(bobCharge.savedMethod.id, 'card_bob');
  assert.ok(secretBox.isSealed(bobCharge.savedMethod.token), 'the card as stored: the gateway opens its token');

  // Bob: charged, activated by the job (his gateway did not record it), one receipt.
  const bob = await renewalOf('billing-job-gym', 'bob');
  assert.deepEqual([bob.status, bob.payment.status], ['active', 'paid']);
  assert.equal(new Date(bob.subscription.startDate).getTime(), terms.bob.subscription.endDate.getTime(), 'continues from the end of the term');
  assert.equal(receiptsFor(bob).length, 1);
  assert.deepEqual(subjects('bob'), [], 'no reminder for a paid renewal');

  // Dan: his gateway recorded the payment itself; the job does not do it again.
  const dan = await renewalOf('billing-job-gym', 'dan');
  assert.equal(dan.payment.status, 'paid');
  assert.equal(receiptsFor(dan).length, 1);
  assert.deepEqual(subjects('dan'), []);

  // Cat: declined -- the order says so, stays open, and she gets the link.
  const cat = await renewalOf('billing-job-gym', 'cat');
  assert.deepEqual([cat.status, cat.payment.status, cat.payment.lastPaymentError], ['pending', 'failed', 'Your card was declined']);
  assert.equal(cat.metadata.lastChargeError, 'TRACKER_DECLINED: do not honour');
  assert.deepEqual(subjects('cat'), ['Iron Gym: we could not charge your saved card']);
  const catUrl = await h.inGym(gyms['billing-job-gym'], () => links.payLinkUrlFor(cat));
  assert.ok(catUrl, 'pay_link_url stays for the declined renewal');
  assert.ok(emailsTo('cat')[0].html.includes(catUrl));
  assert.match(emailsTo('cat')[0].html, /Your card was declined\./);

  // Eve: her only card has expired -- not charged, told so, with the link.
  assert.deepEqual(subjects('eve'), ['Iron Gym: we could not charge your saved card']);
  assert.match(emailsTo('eve')[0].html, /Your saved card has expired\./);
  assert.equal((await renewalOf('billing-job-gym', 'eve')).payment.lastPaymentError, 'Your saved card has expired');

  // Ann: no card -- the due-day message.
  assert.deepEqual(subjects('ann'), ['Iron Gym: your renewal is due today']);
  assert.equal(result.counts.charged, 2);
  assert.equal(result.counts.declined, 2);

  // Again the same day: no second charge, no second message.
  charges.length = 0;
  const again = await run('billing-job-gym', 3);
  await run('billing-job-gym', 4);
  assert.equal(charges.length, 0);
  assert.equal(h.calls.emails.length, 3);
  assert.equal(again.counts.sent, 0);
});

test('the last day: the final link to whoever has not paid; after it nothing more, and the link later closes', async () => {
  h.calls.emails.length = 0;
  charges.length = 0;
  await run('billing-job-gym', 6);
  for (const who of ['ann', 'cat', 'eve']) assert.deepEqual(subjects(who), ['Iron Gym: today is the last day to pay your renewal'], who);
  assert.deepEqual([...subjects('bob'), ...subjects('dan')], []);
  assert.equal(charges.length, 0, 'the charge is tried once, on the due date');

  await run('billing-job-gym', 6);
  await run('billing-job-gym', 7);
  await run('billing-job-gym', 12);
  assert.equal(h.calls.emails.length, 3);

  // A week after the last day the link ran out, and the order is closed.
  const closed = await run('billing-job-gym', 14);
  const ann = await renewalOf('billing-job-gym', 'ann');
  assert.deepEqual([ann.status, ann.metadata.closedReason], ['cancelled', 'expired']);
  assert.ok(closed.closed.some((row) => row.order === ann.orderNumber));
});

test('a gym with automatic charges off never charges a saved card: the member gets the due-day link', async () => {
  h.calls.emails.length = 0;
  charges.length = 0;
  const before = await run('billing-noauto-gym', 0);
  assert.equal(before.autoChargeOn, false);
  await run('billing-noauto-gym', 3);
  assert.equal(charges.length, 0);
  assert.deepEqual(subjects('fay'), ['Steel Gym: your renewal is due on ' + (await h.inGym(gyms['billing-noauto-gym'], () => T.dateLabelForKey(T.shiftDateKey(T.dateKey(t0), 3)))), 'Steel Gym: your renewal is due today']);
  assert.doesNotMatch(emailsTo('fay')[0].html, /we will charge/);
});

test('a gateway that cannot charge (bank transfer with receipt) never charges, even with automatic charges switched on', async () => {
  h.calls.emails.length = 0;
  charges.length = 0;
  const first = await run('billing-generic-gym', 0);
  assert.equal(first.enabled, true);
  assert.equal(first.provider, 'generic');
  assert.equal(first.autoChargeOn, false);
  await run('billing-generic-gym', 3);
  assert.equal(charges.length, 0);
  assert.equal(subjects('gus').length, 2);
  const [mail] = emailsTo('gus');
  assert.match(mail.html, /Pay by bank transfer/, 'no online checkout: the page shows the bank details');
  assert.doesNotMatch(mail.html, /Pay online|Pay now/);
  assert.match(mail.html, /Meezan Bank/);
  assert.match(mail.html, /upload a screenshot of the receipt/);
});

test('a message no channel took is tried again on the next run, and then only once', async () => {
  const slug = 'billing-noauto-gym';
  const gym = gyms[slug];
  const hal = await h.inGym(gym, async () => {
    const user = await User.create({ firstName: 'Hal', lastName: 'Member', email: 'hal@billing-job.test' });
    const pkg = await Package.findOne({});
    const end = T.localInstant(T.shiftDateKey(T.dateKey(at(20)), 3), 12, 0);
    terms.hal = await PackageOrder.create({
      orderNumber: 'JOB-HAL',
      userId: user._id,
      packageId: pkg._id,
      packageDetails: { name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'Hal Member', email: user.email },
      payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date() },
      subscription: { startDate: new Date(end.getTime() - 30 * DAY), endDate: end, isActive: true },
      status: 'active'
    });
    // Email only, and it is failing.
    await Settings.collection.updateOne({}, { $set: { 'billing.sendVia': { email: true, sms: false, whatsapp: false, push: false } } });
    return user;
  });
  h.setEmailFailure('SMTP is down');
  const errors = console.error;
  console.error = () => {};
  try {
    const failed = await run(slug, 20);
    assert.ok(failed.quiet.some((row) => row.failed), JSON.stringify(failed.quiet));
    assert.equal((await renewalOf(slug, 'hal')).metadata.billingNotices || '', '', 'given back');
  } finally {
    console.error = errors;
    h.setEmailFailure(null);
  }
  h.calls.emails.length = 0;
  await run(slug, 20);
  await run(slug, 20);
  assert.deepEqual(h.calls.emails.map((e) => e.to), [hal.email]);
  await h.inGym(gym, () => Settings.collection.updateOne({}, { $set: { 'billing.sendVia': { email: true, sms: false, whatsapp: true, push: true } } }));
});

test('the old expiry notice is not sent on top for a term the payment-link reminders cover', async () => {
  const gym = gyms['billing-noauto-gym'];
  await h.inGym(gym, async () => {
    const user = await User.create({ firstName: 'Ivy', lastName: 'Member', email: 'ivy@billing-job.test' });
    const pkg = await Package.findOne({});
    // Ends tomorrow: a 1-day expiry notice is due today.
    const end = T.localInstant(T.shiftDateKey(T.dateKey(), 1), 12, 0);
    const term = await PackageOrder.create({
      orderNumber: 'JOB-IVY',
      userId: user._id,
      packageId: pkg._id,
      packageDetails: { name: 'Monthly Unlimited', price: '5000', currency: 'PKR', period: 'month' },
      customerInfo: { fullName: 'Ivy Member', email: user.email },
      payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'paid', paidAt: new Date() },
      subscription: { startDate: new Date(end.getTime() - 30 * DAY), endDate: end, isActive: true },
      status: 'active'
    });
    await job.runBillingJob();
    assert.ok(await PackageOrder.exists({ 'metadata.dueFor': String(term._id) }));

    const covered = await reminders.sendExpiryReminders({ billingRemindersOn: true });
    assert.equal(covered.skipped.find((s) => s.order === 'JOB-IVY').reason, 'payment link reminders');
    // Without the payment-link reminders, the notice is attempted as before.
    const plain = await reminders.sendExpiryReminders({ dryRun: true });
    assert.ok(plain.sent.some((s) => s.order === 'JOB-IVY'));

    // runDaily hands the billing report over and passes the flag on.
    const daily = await reminders.runDaily({ dryRun: true });
    assert.equal(daily.billing.enabled, true);
    assert.equal(daily.memberships.skipped.find((s) => s.order === 'JOB-IVY').reason, 'payment link reminders');
  });
});
