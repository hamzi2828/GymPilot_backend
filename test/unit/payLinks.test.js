// Payment link tokens (services/billing/payLinks.js): what one looks like,
// that it opens its own order in its own gym and nothing else, that any
// change to it is caught, when it expires (a week after the last day to pay,
// at the end of the gym's day), and which orders show one to the member.
// Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithTenant } = require('../../src/platform/tenantContext');
const T = require('../../src/attendance/services/timeUtils');
const links = require('../../src/services/billing/payLinks');

const karachi = { _id: '000000000000000000000001', slug: 'iron', name: 'Iron Gym', domains: [{ host: 'iron.example.pk', isPrimary: true }], locale: { timezone: 'Asia/Karachi' }, database: { name: 'gympilot_unit_iron' } };
const london = { _id: '000000000000000000000002', slug: 'steel', domains: [{ host: 'steel.example.co.uk', isPrimary: true }], locale: { timezone: 'Europe/London' }, database: { name: 'gympilot_unit_steel' } };
const ORDER = '6a9e47dadf00918e9825a701';

const order = (extra = {}) => ({
  _id: ORDER,
  orderNumber: 'PKG26100001',
  status: 'pending',
  payment: { method: 'online', status: 'pending', amount: 5000, currency: 'pkr' },
  metadata: { dueFor: '6a9e47dadf00918e9825a700', dueDate: '2026-10-22', lastDay: '2026-10-25' },
  ...extra
});

const inGym = (gym, fn) => runWithTenant(gym, fn);

test('a link is GPP1, the order id, an expiry and a 24-character signature, on the gym site /pay page', async () => {
  await inGym(karachi, () => {
    const { token, url, expiresAt } = links.issuePayLink(order());
    const [version, id, exp, sig] = token.split('.');
    assert.equal(version, 'GPP1');
    assert.equal(id, ORDER);
    assert.match(sig, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(url, `https://iron.example.pk/pay/${token}`);
    assert.equal(expiresAt.getTime(), Number(exp) * 1000);
    assert.equal(links.issuePayLink(order()).token, token, 'the same order keeps the same link');
  });
});

test('it expires at the end of the gym\'s day, a week after the last day to pay', async () => {
  await inGym(karachi, () => {
    const { expiresAt } = links.issuePayLink(order());
    // 2026-10-25 + 7 = 2026-11-01, 23:59:59 in Karachi (UTC+5) = 18:59:59Z.
    assert.equal(expiresAt.toISOString(), '2026-11-01T18:59:59.000Z');
    assert.equal(T.dateKey(expiresAt), '2026-11-01');
  });
  await inGym(london, () => {
    // The same dates in London, where 1 November is back on GMT.
    assert.equal(links.issuePayLink(order()).expiresAt.toISOString(), '2026-11-01T23:59:59.000Z');
  });
  await inGym(karachi, () => {
    // No last day (a link staff sent for an ordinary unpaid order): a week from today.
    const now = new Date('2026-10-19T07:00:00Z');
    const { expiresAt } = links.issuePayLink(order({ metadata: {} }), now);
    assert.equal(T.dateKey(expiresAt), '2026-10-26');
  });
});

test('a good link verifies for its gym and names its order; past its expiry it is expired, still naming it', async () => {
  await inGym(karachi, () => {
    const { token, expiresAt } = links.issuePayLink(order());
    const now = expiresAt.getTime() - 1000;
    assert.deepEqual(links.verifyPayToken(token, now), { ok: true, orderId: ORDER, expiresAt });
    assert.deepEqual(links.verifyPayToken(token, expiresAt.getTime() + 1), { ok: false, reason: 'expired', orderId: ORDER, expiresAt });
  });
});

test('another gym, a changed order, a changed expiry or a changed signature is invalid -- never expired', async () => {
  const { token } = await inGym(karachi, () => links.issuePayLink(order()));
  const [version, id, exp, sig] = token.split('.');
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  await inGym(london, () => assert.deepEqual(links.verifyPayToken(token, 0), { ok: false, reason: 'invalid' }, 'another gym'));
  await inGym(karachi, () => {
    const tampered = [
      [version, '6a9e47dadf00918e9825a702', exp, sig],
      [version, id, String(Number(exp) + 86400 * 365), sig],
      [version, id, exp, flip(sig)],
      ['GPP2', id, exp, sig]
    ].map((parts) => parts.join('.'));
    for (const bad of tampered) assert.deepEqual(links.verifyPayToken(bad, Date.now() + 10 * 365 * 86400000), { ok: false, reason: 'invalid' }, bad);
    for (const junk of ['', null, undefined, 'GPP1', `${token}.extra`, token.slice(0, -1), 'x'.repeat(5000)]) {
      assert.deepEqual(links.verifyPayToken(junk), { ok: false, reason: 'invalid' }, String(junk).slice(0, 20));
    }
  });
});

test('without a signing secret nothing is issued and nothing verifies', async () => {
  const { token } = await inGym(karachi, () => links.issuePayLink(order()));
  const saved = { qr: process.env.QR_TOKEN_SECRET, jwt: process.env.JWT_SECRET };
  delete process.env.QR_TOKEN_SECRET;
  delete process.env.JWT_SECRET;
  try {
    await inGym(karachi, () => {
      assert.throws(() => links.issuePayLink(order()), /QR_TOKEN_SECRET/);
      assert.deepEqual(links.verifyPayToken(token), { ok: false, reason: 'invalid' });
    });
  } finally {
    if (saved.qr !== undefined) process.env.QR_TOKEN_SECRET = saved.qr;
    if (saved.jwt !== undefined) process.env.JWT_SECRET = saved.jwt;
  }
});

test('the member sees "Pay now" only on an open renewal, while its link works', async () => {
  await inGym(karachi, () => {
    const now = new Date('2026-10-20T07:00:00Z');
    assert.match(links.payLinkUrlFor(order(), now), /^https:\/\/iron\.example\.pk\/pay\/GPP1\./);
    // A declined automatic charge leaves it open: the link stays.
    assert.ok(links.payLinkUrlFor(order({ payment: { status: 'failed', amount: 5000, currency: 'pkr', method: 'online' } }), now));
    assert.equal(links.payLinkUrlFor(order({ status: 'active', payment: { status: 'paid' } }), now), null, 'paid');
    assert.equal(links.payLinkUrlFor(order({ status: 'cancelled', payment: { status: 'failed' } }), now), null, 'closed');
    assert.equal(links.payLinkUrlFor(order({ metadata: {} }), now), null, 'not a renewal');
    assert.equal(links.payLinkUrlFor(order(), new Date('2026-11-02T07:00:00Z')), null, 'link expired');

    const [a, b] = links.withPayLinks([order(), { _id: 'x', toJSON: () => ({ _id: 'x', status: 'active' }) }], now);
    assert.ok(a.pay_link_url);
    assert.deepEqual(b, { _id: 'x', status: 'active', pay_link_url: null });
  });
});
