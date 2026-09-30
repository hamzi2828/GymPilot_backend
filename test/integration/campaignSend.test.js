// Sending an email campaign a batch at a time, against a real MongoDB, to an
// audience where most members have no email address: the ones without one
// are skipped (counted and logged once), and the sends move on to everyone
// who has one instead of taking the same unreachable batch every call.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let User;
let Campaign;
let MessageLog;
let campaigns;
let notify;

const WITHOUT_EMAIL = 60;
const WITH_EMAIL = 5;

const test = h.suite(async () => {
  User = h.src('models/user');
  Campaign = h.src('models/campaignModel');
  MessageLog = h.src('models/messageLogModel');
  campaigns = h.src('services/campaignService');
  notify = h.src('services/gymNotifications');

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
const send = (campaign, since) => withBrand(() => h.inGym(gym, () => campaigns.sendBatch(campaign, { limit: 50, since })));

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
