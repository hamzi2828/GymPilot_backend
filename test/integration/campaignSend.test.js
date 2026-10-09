// Sending an email campaign a batch at a time, against a real MongoDB, to an
// audience where most members have no email address: the ones without one
// are skipped (counted and logged once), and the sends move on to everyone
// who has one instead of taking the same unreachable batch every call.
//
// And the same for the other channels, in a second gym: SMS to phone numbers
// stored as members type them (the log files them normalised, and "already
// sent" has to match that), and push to an audience where most members have
// no device. The SMS gateway and Expo are a stand-in for fetch; nothing
// leaves the machine.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let User;
let Campaign;
let MessageLog;
let campaigns;
let notify;
let messaging;
let MobilePushToken;
let textGym;

const LOCAL_PHONES = 60;
const OTHER_PHONES = ['0301-1234567', '+92 302 1234567', '00923031234567', '3041234567'];
const NO_PHONE = 2;

const WITHOUT_EMAIL = 60;
const WITH_EMAIL = 5;

const test = h.suite(async () => {
  User = h.src('models/user');
  Campaign = h.src('models/campaignModel');
  MessageLog = h.src('models/messageLogModel');
  campaigns = h.src('services/campaignService');
  notify = h.src('services/gymNotifications');
  messaging = h.src('services/messaging');
  MobilePushToken = h.src('models/mobilePushTokenModel');

  gym = await h.createGym('campaign-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, MessageLog);
    // The phone-only members first, so they are the head of every batch.
    for (let i = 0; i < WITHOUT_EMAIL; i++) {
      await User.create({ firstName: `Phone${i}`, lastName: 'Only', phone: `0300 ${String(i).padStart(7, '0')}` });
    }
    for (let i = 0; i < WITH_EMAIL; i++) {
      await User.create({ firstName: `Mail${i}`, lastName: 'Member', email: `mail${i}@campaign-gym.test` });
    }
  });

  // A gym in Pakistan on a plain HTTP SMS gateway, with phone numbers the
  // way a front desk types them.
  textGym = await h.createGym('campaign-text-gym', {
    settings: { messaging: { defaultCountryCode: '+92', sms: { provider: 'http', webhookUrl: 'https://sms-gateway.invalid/send' } } }
  });
  await h.inGym(textGym, async () => {
    await h.ensureIndexes(User, MessageLog, MobilePushToken);
    for (let i = 0; i < LOCAL_PHONES; i++) {
      await User.create({ firstName: `Local${i}`, lastName: 'Member', phone: `0300 ${String(i).padStart(7, '0')}` });
    }
    for (const [i, phone] of OTHER_PHONES.entries()) {
      await User.create({ firstName: `Other${i}`, lastName: 'Member', phone });
    }
    // Nothing to text: a phone cell with no number in it, and no phone at all.
    await User.create({ firstName: 'Ask', lastName: 'Desk', phone: 'n/a' });
    await User.create({ firstName: 'Mail', lastName: 'Only', email: 'mail.only@campaign-text-gym.test' });
  });
});

// The harness stubs every notification export, brand() included; a
// campaign email needs the gym's name and links.
async function withBrand(fn) {
  const stubbed = notify.brand;
  notify.brand = async () => ({
    siteName: 'Campaign Gym',
    accountUrl: 'https://campaign-gym.test/user-detail',
    timetableUrl: 'https://campaign-gym.test/timetable',
    renewUrl: 'https://campaign-gym.test/packages'
  });
  try {
    return await fn();
  } finally {
    notify.brand = stubbed;
  }
}
const send = (campaign, since, where = gym) => withBrand(() => h.inGym(where, () => campaigns.sendBatch(campaign, { limit: 50, since })));

// The SMS gateway and Expo's push service, answering yes to everything and
// keeping what they were sent.
async function withProviders(fn) {
  const real = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const answer = String(url) === messaging.EXPO_PUSH_API ? { data: body.map(() => ({ status: 'ok' })) } : { id: `gw-${requests.length}` };
    return { ok: true, status: 200, json: async () => answer };
  };
  try {
    return await fn(requests);
  } finally {
    global.fetch = real;
  }
}

// The panel's loop: send until the answer is done, at most `most` times.
async function sendAll(campaign, where, most) {
  const totals = { sent: 0, failed: 0, skipped: 0 };
  let result = null;
  let calls = 0;
  while (calls < most) {
    calls += 1;
    result = await send(campaign, campaign.startedAt, where);
    totals.sent += result.sent;
    totals.failed += result.failed;
    totals.skipped += result.skipped;
    if (result.done) break;
  }
  return { result, totals, calls };
}

test('members with no email are skipped once and everyone with one is emailed', async () => {
  const campaign = await h.inGym(gym, () =>
    Campaign.create({ title: 'Holiday hours', channel: 'email', subject: 'Holiday hours', body: 'Hi {{firstName}}, we close early on Friday.', status: 'sending', startedAt: new Date() })
  );
  const before = h.calls.emails.length;

  const totals = { sent: 0, failed: 0, skipped: 0 };
  let result = null;
  let calls = 0;
  // The panel calls send until it answers done. Four calls of 50 is plenty
  // for 65 people; a stuck queue never gets there.
  while (calls < 4) {
    calls += 1;
    result = await send(campaign, campaign.startedAt);
    totals.sent += result.sent;
    totals.failed += result.failed;
    totals.skipped += result.skipped;
    if (result.done) break;
  }

  assert.equal(result.done, true, `still not done after ${calls} calls: ${JSON.stringify(result)}`);
  assert.equal(result.targeted, WITHOUT_EMAIL + WITH_EMAIL);
  assert.deepEqual(totals, { sent: WITH_EMAIL, failed: 0, skipped: WITHOUT_EMAIL });

  const sentTo = h.calls.emails.slice(before).map((e) => e.to).sort();
  assert.deepEqual(sentTo, Array.from({ length: WITH_EMAIL }, (_, i) => `mail${i}@campaign-gym.test`).sort());

  const logged = await h.inGym(gym, () => MessageLog.countDocuments({ campaignId: campaign._id, status: 'skipped' }));
  assert.equal(logged, WITHOUT_EMAIL, 'one skipped row per member, not one per call');

  // Asked again (a retry pass), nobody is written to twice and the skipped
  // members are not counted again.
  const again = await send(campaign, new Date());
  assert.equal(again.done, true);
  assert.equal(again.sent, 0);
  assert.equal(again.skipped, 0);
  assert.equal(h.calls.emails.length - before, WITH_EMAIL);
});

test('an SMS campaign texts every member once, however their number was typed', async () => {
  const campaign = await h.inGym(textGym, () =>
    Campaign.create({ title: 'Eid hours', channel: 'sms', body: 'Hi {{firstName}}, we are closed on Eid day.', status: 'sending', startedAt: new Date() })
  );
  await withProviders(async (requests) => {
    const withPhone = LOCAL_PHONES + OTHER_PHONES.length;
    // Two calls of 50 reach 64 people. A queue that never recognises who it
    // has texted sends the first 50 again on every call and never ends.
    const { result, totals, calls } = await sendAll(campaign, textGym, 4);
    assert.equal(result.done, true, `still not done after ${calls} calls: ${JSON.stringify(result)}`);
    assert.equal(calls, 2);
    assert.deepEqual(totals, { sent: withPhone, failed: 0, skipped: NO_PHONE });

    const texted = requests.map((r) => r.body.to);
    assert.equal(texted.length, withPhone, 'one text each');
    assert.equal(new Set(texted).size, withPhone, 'nobody texted twice');
    assert.ok(texted.includes('+923000000007'), 'a local number goes out with the country code');
    for (const to of ['+923011234567', '+923021234567', '+923031234567', '+923041234567']) assert.ok(texted.includes(to), to);

    // Asked again (a retry pass): nobody is texted twice.
    const again = await send(campaign, new Date(), textGym);
    assert.equal(again.done, true);
    assert.equal(again.sent, 0);
    assert.equal(requests.length, withPhone);
  });
});

test('a push campaign leaves out members with no device and reaches the ones behind them', async () => {
  const everyone = LOCAL_PHONES + OTHER_PHONES.length + NO_PHONE;
  // The last three members in the list have the app; the 63 ahead of them
  // have no device at all.
  const withApp = await h.inGym(textGym, async () => {
    const users = await User.find({ firstName: { $in: ['Other3', 'Ask', 'Mail'] } }).select('_id').lean();
    for (const [i, user] of users.entries()) await MobilePushToken.create({ userId: user._id, token: `ExponentPushToken[campaign-${i}]`, platform: 'android' });
    return users.map((user) => String(user._id));
  });
  assert.equal(withApp.length, 3);

  const campaign = await h.inGym(textGym, () =>
    Campaign.create({ title: 'New class', channel: 'push', subject: 'New class', body: 'Spin starts Monday.', status: 'sending', startedAt: new Date() })
  );
  await withProviders(async (requests) => {
    const { result, totals, calls } = await sendAll(campaign, textGym, 4);
    assert.equal(result.done, true, `still not done after ${calls} calls: ${JSON.stringify(result)}`);
    assert.equal(calls, 1, 'the members without a device do not take up a batch');
    assert.deepEqual(totals, { sent: 3, failed: 0, skipped: everyone - 3 });
    assert.equal(requests.length, 3);

    const rows = await h.inGym(textGym, () => MessageLog.find({ campaignId: campaign._id }).select('to status error').lean());
    assert.deepEqual(rows.filter((r) => r.status === 'sent').map((r) => r.to).sort(), [...withApp].sort());
    assert.equal(rows.filter((r) => r.status === 'skipped' && r.error === 'no device').length, everyone - 3);

    // A retry pass does not count or log them again.
    const again = await send(campaign, new Date(), textGym);
    assert.equal(again.done, true);
    assert.deepEqual([again.sent, again.skipped], [0, 0]);
    assert.equal(requests.length, 3);
  });
});

test('the audience preview counts who a send would reach: a real number to text, a device to push to', async () => {
  const controller = h.src('controller/messagingController');
  const everyone = LOCAL_PHONES + OTHER_PHONES.length + NO_PHONE;
  const audienceOf = (channel, where = textGym) =>
    h.inGym(where, async () => {
      const campaign = await Campaign.create({ title: `Preview ${channel}`, channel, subject: 'Preview', body: 'Hello.', status: 'draft' });
      const res = await h.call(controller.campaignAudience, { params: { id: String(campaign._id) } });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      return res.body.data;
    });

  // Text: "n/a" in the phone cell is nobody to text, and numbers are shown
  // as they will be sent.
  for (const channel of ['sms', 'whatsapp']) {
    const data = await audienceOf(channel);
    assert.equal(data.total, everyone, channel);
    assert.equal(data.reachable, LOCAL_PHONES + OTHER_PHONES.length, channel);
    assert.equal(data.preview.length, 10);
    assert.ok(data.preview.every((row) => /^\+92\d{10}$/.test(row.address)), JSON.stringify(data.preview));
  }

  // Push: only the three members with the app (the push test above), not
  // every member with an account.
  const push = await audienceOf('push');
  assert.equal(push.total, everyone);
  assert.equal(push.reachable, 3);
  assert.deepEqual(push.preview.map((row) => row.name).sort(), ['Ask Desk', 'Mail Only', 'Other3 Member']);

  // Email is as it was: everyone with an address.
  const email = await audienceOf('email', gym);
  assert.equal(email.total, WITHOUT_EMAIL + WITH_EMAIL);
  assert.equal(email.reachable, WITH_EMAIL);
  assert.ok(email.preview.every((row) => /@campaign-gym\.test$/.test(row.address)));
});
