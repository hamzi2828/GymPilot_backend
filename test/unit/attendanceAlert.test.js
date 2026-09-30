// The sound and the words the front desk and the web kiosk give a member's
// punch (punchService memberAlert), and the gym's voice settings behind them,
// without a database: which verdicts are a problem, which only a warning,
// which get the "fee expired" message and which get the sound alone, the
// defaults a gym that never saved anything hears, and the settings endpoint's
// refusals that come before any read. The same against a real MongoDB --
// the settings round trip and the punch payload -- is in
// test/integration/attendance.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const { memberAlert, voiceSettings, VOICE_DEFAULTS } = require('../../src/attendance/services/punchService');
const corrections = require('../../src/attendance/controller/attendanceCorrectionController');
const Settings = require('../../src/models/settings');

const gym = { _id: '0000000000000000000000b4', slug: 'unit-gym-alerts', database: { name: 'gympilot_unit_gym_alerts' }, locale: { timezone: 'UTC' } };

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY);

// A member's visit as the punch stores it: the verdict, and the membership
// snapshot it was reached from.
function visit(status, { endIn = 20, personType = 'member' } = {}) {
  return { personType, status, membership: { status: 'active', endDate: endIn === null ? null : inDays(endIn) } };
}

async function call(handler, req) {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  await handler({ params: {}, body: {}, query: {}, user: { id: '0000000000000000000000a1' }, ...req }, res);
  return res;
}

test('a gym that never saved its voice settings hears the defaults; a blank message is the default again', () => {
  assert.deepEqual(voiceSettings(undefined), VOICE_DEFAULTS);
  assert.deepEqual(voiceSettings({}), VOICE_DEFAULTS);
  assert.equal(VOICE_DEFAULTS.expiredMessage, 'Fee expired, please renew');
  assert.equal(VOICE_DEFAULTS.expiringMessage, 'Your fee expires soon');
  assert.equal(VOICE_DEFAULTS.balanceDueMessage, 'Please clear your balance');
  assert.equal(VOICE_DEFAULTS.enabled, true);

  const own = voiceSettings({ enabled: false, expiredMessage: '  Fees due, see reception  ', expiringMessage: '   ' });
  assert.equal(own.enabled, false);
  assert.equal(own.expiredMessage, 'Fees due, see reception');
  assert.equal(own.expiringMessage, VOICE_DEFAULTS.expiringMessage, 'blank is the default');
  assert.equal(own.balanceDueMessage, VOICE_DEFAULTS.balanceDueMessage);
});

test('the settings row holds the voice with the same defaults', async () => {
  await runWithTenant(gym, () => {
    assert.equal(Settings.schema.path('attendance.voice.enabled').defaultValue, true);
    assert.equal(Settings.schema.path('attendance.voice.expiredMessage').defaultValue, VOICE_DEFAULTS.expiredMessage);
    assert.equal(Settings.schema.path('attendance.voice.expiringMessage').defaultValue, VOICE_DEFAULTS.expiringMessage);
    assert.equal(Settings.schema.path('attendance.voice.balanceDueMessage').defaultValue, VOICE_DEFAULTS.balanceDueMessage);
  });
});

test('nothing owed and in date: the ordinary sound and no words', () => {
  assert.deepEqual(memberAlert(visit('membership_active'), VOICE_DEFAULTS), { level: 'ok', speech: null });
});

test('expired, no package or a failed card: the problem sound and "fee expired"', () => {
  for (const status of ['membership_expired', 'membership_none', 'membership_past_due']) {
    assert.deepEqual(memberAlert(visit(status), VOICE_DEFAULTS), { level: 'problem', speech: 'Fee expired, please renew' }, status);
  }
  // Cancelled and run out is as over as expired.
  assert.deepEqual(memberAlert(visit('membership_cancelled', { endIn: -2 }), VOICE_DEFAULTS), {
    level: 'problem',
    speech: 'Fee expired, please renew'
  });
});

test('frozen, suspended and awaiting payment: the problem sound, and no "renew" the member does not owe', () => {
  for (const status of ['membership_frozen', 'membership_suspended', 'membership_pending']) {
    assert.deepEqual(memberAlert(visit(status), VOICE_DEFAULTS), { level: 'problem', speech: null }, status);
  }
});

test('running out -- expiring, or cancelled with days left -- is a warning, not a problem', () => {
  assert.deepEqual(memberAlert(visit('membership_expiring', { endIn: 3 }), VOICE_DEFAULTS), {
    level: 'warning',
    speech: 'Your fee expires soon'
  });
  assert.deepEqual(memberAlert(visit('membership_cancelled', { endIn: 5 }), VOICE_DEFAULTS), {
    level: 'warning',
    speech: 'Your fee expires soon'
  });
});

test("the gym's own words are spoken; with the voice off only the sound is left", () => {
  const own = voiceSettings({ expiredMessage: 'Fees due, see reception' });
  assert.equal(memberAlert(visit('membership_expired'), own).speech, 'Fees due, see reception');

  const off = voiceSettings({ enabled: false });
  assert.deepEqual(memberAlert(visit('membership_expired'), off), { level: 'problem', speech: null });
  assert.deepEqual(memberAlert(visit('membership_expiring', { endIn: 3 }), off), { level: 'warning', speech: null });
});

test('staff have no membership and no alert', () => {
  assert.equal(memberAlert(visit('late', { personType: 'staff' }), VOICE_DEFAULTS), null);
  assert.equal(memberAlert(null, VOICE_DEFAULTS), null);
});

test('the settings endpoint refuses a voice it cannot store, before anything is read', async () => {
  await runWithTenant(gym, async () => {
    const expect = async (body, pattern) => {
      const res = await call(corrections.updateSettings, { body });
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.equal(res.body.success, false);
      assert.match(res.body.message, pattern);
    };

    await expect({}, /Nothing to change/);
    await expect({ voice: 'loud' }, /voice must be an object/);
    await expect({ voice: [] }, /voice must be an object/);
    await expect({ voice: { enabled: 'yes' } }, /voice.enabled must be true or false/);
    await expect({ voice: { expiredMessage: 42 } }, /voice.expiredMessage must be text/);
    await expect({ voice: { balanceDueMessage: 'x'.repeat(201) } }, /under 200 characters/);
    await expect({ voice: {} }, /Nothing to change/);
    // One bad field refuses the whole request: nothing half-saved.
    await expect({ memberScanOut: true, voice: { enabled: 'no' } }, /voice.enabled/);
  });
});
