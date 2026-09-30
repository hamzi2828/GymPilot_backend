// The sound and the words the front desk and the web kiosk give a member's
// punch (punchService memberAlert), and the gym's voice settings behind them,
// without a database: which verdicts are a problem, which only a warning,
// which get the "fee expired" message and which get the sound alone, the
// defaults a gym that never saved anything hears, and the settings endpoint's
// refusals that come before any read. Then a balance owing on the package:
// read only from a paid order, a warning (never a refusal), and one line with
// whatever else the desk has to say. The same against a real MongoDB -- the
// settings round trip and the punch payload -- is in
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

// ---------------------------------------------------------------------------
// Balance due
// ---------------------------------------------------------------------------

const { memberWarning, moneyLabel } = require('../../src/attendance/services/punchService');
const { membershipFromOrders } = require('../../src/attendance/services/peopleDirectory');

function owing(status, balanceDue, { endIn = 20, currency = 'GBP' } = {}) {
  const v = visit(status, { endIn });
  v.membership.balanceDue = balanceDue;
  v.membership.currency = currency;
  return v;
}

test('money owing on a running membership is a warning, and the gym asks for it', () => {
  assert.deepEqual(memberAlert(owing('membership_active', 25), VOICE_DEFAULTS), {
    level: 'warning',
    speech: 'Please clear your balance'
  });
  assert.equal(memberWarning(owing('membership_active', 25)), 'Balance due £25');
  // Nothing owed, nothing said -- and a negative or missing balance is nothing.
  assert.deepEqual(memberAlert(owing('membership_active', 0), VOICE_DEFAULTS), { level: 'ok', speech: null });
  assert.deepEqual(memberAlert(owing('membership_active', -5), VOICE_DEFAULTS), { level: 'ok', speech: null });
  assert.equal(memberWarning(owing('membership_active', 0)), null);
  assert.equal(memberWarning(visit('membership_active')), null, 'a visit from before the field');
});

test('money owing on top of another warning: both said, both on the one line', () => {
  assert.deepEqual(memberAlert(owing('membership_expiring', 25, { endIn: 3 }), VOICE_DEFAULTS), {
    level: 'warning',
    speech: 'Your fee expires soon. Please clear your balance.'
  });
  assert.equal(memberWarning(owing('membership_expiring', 25, { endIn: 3 })), 'EXPIRES IN 3 DAYS · Balance due £25');

  // It never softens a problem.
  assert.deepEqual(memberAlert(owing('membership_frozen', 25), VOICE_DEFAULTS), {
    level: 'problem',
    speech: 'Please clear your balance'
  });
  assert.deepEqual(memberAlert(owing('membership_expired', 25, { endIn: -3 }), VOICE_DEFAULTS), {
    level: 'problem',
    speech: 'Fee expired, please renew. Please clear your balance.'
  });
  assert.equal(memberWarning(owing('membership_expired', 25, { endIn: -3 })), 'MEMBERSHIP EXPIRED · Balance due £25');

  // Voice off: the warning sound and the line stay, the words go.
  assert.deepEqual(memberAlert(owing('membership_active', 25), voiceSettings({ enabled: false })), { level: 'warning', speech: null });
});

test('the amount is written in its own currency, pence only when there are some', () => {
  assert.equal(moneyLabel(25, 'GBP'), '£25');
  assert.equal(moneyLabel(2500, 'pkr'), 'PKR 2,500');
  assert.equal(moneyLabel(12.5, 'USD'), 'US$12.50');
  assert.equal(memberWarning(owing('membership_active', 2500, { currency: 'PKR' })), 'Balance due PKR 2,500');
});

test("the membership carries what is still owed on a paid order -- and only a paid one's", () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const user = { _id: '0000000000000000000000c1', email: 'owes@example.test' };
  const order = (payment, extra = {}) => ({
    _id: '0000000000000000000000d1',
    userId: user._id,
    customerInfo: { email: user.email },
    packageDetails: { name: 'Monthly' },
    subscription: { endDate: new Date(now.getTime() + 20 * DAY) },
    status: 'active',
    createdAt: new Date(now.getTime() - 10 * DAY),
    payment,
    ...extra
  });

  const owes = membershipFromOrders([order({ status: 'paid', balanceDue: 25, currency: 'gbp' })], null, now);
  assert.equal(owes.status, 'active');
  assert.equal(owes.balanceDue, 25);
  assert.equal(owes.currency, 'GBP');

  assert.equal(membershipFromOrders([order({ status: 'paid', currency: 'gbp' })], null, now).balanceDue, 0, 'from before the field');
  assert.equal(membershipFromOrders([order({ status: 'paid', balanceDue: -3 })], null, now).balanceDue, 0);

  // An order not paid at all owes its whole price; the desk hears that as
  // "awaiting payment", not as a balance.
  const pending = membershipFromOrders([], order({ status: 'pending', balanceDue: 40 }, { status: 'pending' }), now);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.balanceDue, 0);
});

// A paid membership sold to start later (the desk's "start after N days"),
// scanned before its first day: stored as 'membership_pending' with the date
// it starts. Paid, so a warning rather than a problem, and the date said
// aloud -- none of the gym's fee messages is true of it.
function startsLater({ startsOn = new Date('2026-10-05T00:00:00Z'), balanceDue = 0 } = {}) {
  return {
    personType: 'member',
    status: 'membership_pending',
    membership: { status: 'pending', startsOn, endDate: new Date('2026-11-05T00:00:00Z'), balanceDue, currency: 'GBP' }
  };
}

test('a membership that starts later: the warning sound, its start date said and written, never "awaiting payment"', async () => {
  await runWithTenant(gym, () => {
    assert.deepEqual(memberAlert(startsLater(), VOICE_DEFAULTS), { level: 'warning', speech: 'Your membership starts on 5 October' });
    assert.equal(memberWarning(startsLater()), 'MEMBERSHIP STARTS ON 05 OCT 2026 — paid, not started yet');

    // With money owing on it too: one line, both said.
    assert.equal(memberWarning(startsLater({ balanceDue: 20 })), 'MEMBERSHIP STARTS ON 05 OCT 2026 · Balance due £20');
    assert.deepEqual(memberAlert(startsLater({ balanceDue: 20 }), VOICE_DEFAULTS), {
      level: 'warning',
      speech: 'Your membership starts on 5 October. Please clear your balance.'
    });

    // The voice off: the sound and the line stay, the words go.
    assert.deepEqual(memberAlert(startsLater(), voiceSettings({ enabled: false })), { level: 'warning', speech: null });

    // A transfer still awaited is what it always was.
    assert.equal(memberWarning(visit('membership_pending')), 'PAYMENT NOT CONFIRMED — check the transfer before admitting');
  });
});
