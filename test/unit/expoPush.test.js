// Expo push from services/messaging.js: token shape, reading Expo's tickets,
// and batching -- with fetch stubbed, so nothing leaves the machine.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const messaging = require('../../src/services/messaging');

test('only Expo push tokens are accepted', () => {
  assert.ok(messaging.isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'));
  assert.ok(messaging.isExpoPushToken('ExpoPushToken[abc-123_DEF]'));
  assert.ok(messaging.isExpoPushToken('  ExponentPushToken[abc]  '), 'whitespace is trimmed');
  assert.equal(messaging.isExpoPushToken('ExponentPushToken[]'), false);
  assert.equal(messaging.isExpoPushToken('ExponentPushToken[a b]'), false);
  assert.equal(messaging.isExpoPushToken('fcm:abc'), false);
  assert.equal(messaging.isExpoPushToken(''), false);
  assert.equal(messaging.isExpoPushToken(null), false);
});

test('tickets are read in order and dead devices are named', () => {
  const batch = [{ to: 'ExponentPushToken[a]' }, { to: 'ExponentPushToken[b]' }, { to: 'ExponentPushToken[c]' }];
  const tickets = [
    { status: 'ok', id: '1' },
    { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
    { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }
  ];
  const outcome = messaging.expoTicketOutcomes(batch, tickets);
  assert.equal(outcome.sent, 1);
  assert.equal(outcome.failed, 2);
  assert.deepEqual(outcome.dead, ['ExponentPushToken[b]']);
  assert.equal(outcome.lastError, 'too big');

  // A short or missing ticket list counts the rest as failed, not as sent.
  const short = messaging.expoTicketOutcomes(batch, [{ status: 'ok' }]);
  assert.equal(short.sent, 1);
  assert.equal(short.failed, 2);
  assert.deepEqual(messaging.expoTicketOutcomes(batch, undefined).sent, 0);
});

test('sends go to Expo a hundred at a time and dead tokens come back', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, size: body.length, headers: init.headers, first: body[0] });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: body.map((message, index) =>
          // The 7th token of the second batch has uninstalled the app.
          calls.length === 2 && index === 6
            ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
            : { status: 'ok', id: `${calls.length}-${index}` }
        )
      })
    };
  };
  try {
    const tokens = Array.from({ length: 250 }, (_, i) => `ExponentPushToken[t${i}]`);
    const result = await messaging.expoSend(tokens, { title: 'Class tomorrow', body: 'Yoga at 18:00', url: '/classes', data: { kind: 'booking' } });

    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.size),
      [100, 100, 50]
    );
    assert.ok(calls.every((c) => c.url === messaging.EXPO_PUSH_API));
    assert.equal(calls[0].first.to, 'ExponentPushToken[t0]');
    assert.equal(calls[0].first.title, 'Class tomorrow');
    assert.equal(calls[0].first.body, 'Yoga at 18:00');
    assert.deepEqual(calls[0].first.data, { url: '/classes', kind: 'booking' });

    assert.equal(result.sent, 249);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.dead, ['ExponentPushToken[t106]']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a batch Expo refuses outright is counted as failed and the rest still go', async () => {
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async (url, init) => {
    call += 1;
    const body = JSON.parse(init.body);
    if (call === 1) return { ok: false, status: 429, json: async () => ({ errors: [{ message: 'Too many requests' }] }) };
    return { ok: true, status: 200, json: async () => ({ data: body.map(() => ({ status: 'ok' })) }) };
  };
  try {
    const tokens = Array.from({ length: 120 }, (_, i) => `ExponentPushToken[t${i}]`);
    const result = await messaging.expoSend(tokens, { title: 'x', body: 'y' });
    assert.equal(result.failed, 100);
    assert.equal(result.sent, 20);
    assert.equal(result.lastError, 'Too many requests');
    assert.deepEqual(result.dead, []);
  } finally {
    global.fetch = originalFetch;
  }
});
