// The rotating desk code (services/deskCode.js): what it looks like, that it
// verifies for the gym and desk token it was issued to and nobody else, the
// minute it is good for and the few seconds of grace after, and the two ways a
// phone hands it over -- the bare code or the check-in page's address. Pure
// logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithTenant } = require('../../src/platform/tenantContext');
const {
  issueDeskCode,
  verifyDeskCode,
  codeFrom,
  VALID_SECONDS,
  GRACE_SECONDS,
  REFRESH_AFTER_SECONDS,
  CHECKIN_PATH
} = require('../../src/attendance/services/deskCode');

const gymA = { _id: '000000000000000000000001', slug: 'a', database: { name: 'gympilot_unit_a' } };
const gymB = { _id: '000000000000000000000002', slug: 'b', database: { name: 'gympilot_unit_b' } };
const deskA = '6a9e47dadf00918e9825a701';
const deskB = '6a9e47dadf00918e9825a702';

test('a code is GPD1, the desk token, a minute ahead, and a 24-character signature', async () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const { code, expiresAt } = await runWithTenant(gymA, () => issueDeskCode(deskA, now));
  const [version, id, exp, sig] = code.split('.');
  assert.equal(version, 'GPD1');
  assert.equal(id, deskA);
  assert.equal(Number(exp), now / 1000 + 60);
  assert.match(sig, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(expiresAt.getTime(), now + 60000);
  assert.deepEqual([VALID_SECONDS, GRACE_SECONDS, REFRESH_AFTER_SECONDS, CHECKIN_PATH], [60, 5, 20, '/checkin']);
});

test('a good code verifies for its gym and names its desk token', async () => {
  await runWithTenant(gymA, () => {
    const { code } = issueDeskCode(deskA);
    assert.deepEqual(verifyDeskCode(code), { ok: true, deskTokenId: deskA });
  });
});

test('past its minute it is expired, with five seconds of grace for the trip', async () => {
  await runWithTenant(gymA, () => {
    const issuedAt = Date.now();
    const { code, expiresAt } = issueDeskCode(deskA, issuedAt);
    const exp = expiresAt.getTime();
    assert.equal(verifyDeskCode(code, exp - 1000).ok, true, 'in its last second');
    assert.equal(verifyDeskCode(code, exp + 4000).ok, true, 'four seconds late');
    assert.equal(verifyDeskCode(code, exp + 5000).ok, true, 'at the end of the grace');
    assert.deepEqual(verifyDeskCode(code, exp + 5001), { ok: false, reason: 'expired' });
    assert.deepEqual(verifyDeskCode(code, exp + 3600000), { ok: false, reason: 'expired' });
  });
});

test('a tampered code is invalid -- never "expired", whatever its time says', async () => {
  await runWithTenant(gymA, () => {
    const { code } = issueDeskCode(deskA);
    const [version, id, exp, sig] = code.split('.');
    // Always a different last character: a signature that already ended in
    // 'x' would make the tamper a no-op (about one run in 64).
    const flipped = sig.slice(0, -1) + (sig.endsWith('x') ? 'y' : 'x');
    assert.deepEqual(verifyDeskCode([version, id, exp, flipped].join('.')), { ok: false, reason: 'invalid' });
    assert.deepEqual(verifyDeskCode([version, id, String(Number(exp) + 3600), sig].join('.')), { ok: false, reason: 'invalid' }, 'expiry pushed out');
    assert.deepEqual(verifyDeskCode([version, id, String(Number(exp) - 3600), sig].join('.')), { ok: false, reason: 'invalid' }, 'expiry pulled back');
    assert.deepEqual(verifyDeskCode(['GPD2', id, exp, sig].join('.')), { ok: false, reason: 'invalid' });
    for (const junk of ['', null, undefined, 'GPD1', 'GPD1.x.1.y', 'GPQ1.member.6a9e47dadf00918e9825a701.1.sig', 42, {}]) {
      assert.deepEqual(verifyDeskCode(junk), { ok: false, reason: 'invalid' }, String(junk));
    }
  });
});

test("another gym's code is invalid here, even one that would have expired", async () => {
  const fresh = await runWithTenant(gymB, () => issueDeskCode(deskA).code);
  const old = await runWithTenant(gymB, () => issueDeskCode(deskA, Date.now() - 3600000).code);
  await runWithTenant(gymA, () => {
    assert.deepEqual(verifyDeskCode(fresh), { ok: false, reason: 'invalid' });
    assert.deepEqual(verifyDeskCode(old), { ok: false, reason: 'invalid' });
  });
});

test('a code cannot be moved to another desk token', async () => {
  await runWithTenant(gymA, () => {
    const { code } = issueDeskCode(deskA);
    const moved = code.replace(deskA, deskB);
    assert.deepEqual(verifyDeskCode(moved), { ok: false, reason: 'invalid' });
    assert.deepEqual(verifyDeskCode(issueDeskCode(deskB).code), { ok: true, deskTokenId: deskB });
  });
});

test('the phone may send the bare code or the check-in address that carries it', async () => {
  await runWithTenant(gymA, () => {
    const { code } = issueDeskCode(deskA);
    const url = `https://irongym.example/checkin?c=${encodeURIComponent(code)}`;
    assert.equal(codeFrom(url), code);
    assert.equal(codeFrom(`  ${code}  `), code);
    assert.equal(codeFrom(`https://irongym.example/checkin?x=1&c=${code}#top`), code);
    assert.equal(verifyDeskCode(url).ok, true);
    assert.equal(verifyDeskCode(`irongym.example/checkin?c=${code}`).ok, true, 'without a scheme');
    assert.deepEqual(verifyDeskCode('https://irongym.example/checkin'), { ok: false, reason: 'invalid' });
    assert.deepEqual(verifyDeskCode('https://irongym.example/checkin?c=%E0%A4%A'), { ok: false, reason: 'invalid' }, 'broken escapes');
  });
});
