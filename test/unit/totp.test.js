// Authenticator-app codes (platform/totp.js) against the RFC's own numbers:
// RFC 4226 appendix D for HOTP, RFC 6238 appendix B for TOTP (SHA-1, cut to
// six digits as apps show them), plus the ±1 step window, replay refusal and
// the one-time backup codes.

const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../../src/platform/totp');

// The RFCs' key: the ASCII bytes "12345678901234567890".
const RFC_KEY = Buffer.from('12345678901234567890');
const RFC_SECRET = totp.base32Encode(RFC_KEY);

test('base32 round-trips and matches RFC 4648', () => {
  assert.equal(totp.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.deepEqual(totp.base32Decode('mzxw 6ytb-oi======'), Buffer.from('foobar'));
  assert.deepEqual(totp.base32Decode(RFC_SECRET), RFC_KEY);
  assert.throws(() => totp.base32Decode('not base32!'));
  assert.match(totp.generateSecret(), /^[A-Z2-7]{32}$/);
});

test('HOTP matches RFC 4226 appendix D', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(totp.hotp(RFC_SECRET, counter), code));
});

test('TOTP matches RFC 6238 appendix B (SHA-1), as eight and six digits', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(totp.totp(RFC_SECRET, seconds * 1000, 8), code, `T=${seconds}`);
    assert.equal(totp.totp(RFC_SECRET, seconds * 1000), code.slice(-6), `T=${seconds}, six digits`);
  }
});

test('a code is good for one step either side of now, and no further', () => {
  const now = 1111111111 * 1000;
  const step = totp.stepAt(now);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, now), { timeMs: now }), step);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, now - 30000), { timeMs: now }), step - 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, now + 30000), { timeMs: now }), step + 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, now - 60000), { timeMs: now }), null);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, now + 60000), { timeMs: now }), null);
  assert.equal(totp.verifyTotp(RFC_SECRET, '12345', { timeMs: now }), null);
  assert.equal(totp.verifyTotp(RFC_SECRET, 'abcdef', { timeMs: now }), null);
  assert.equal(totp.verifyTotp('', '123456', { timeMs: now }), null);
});

test('a code from a step already used is refused', () => {
  const now = 1234567890 * 1000;
  const code = totp.totp(RFC_SECRET, now);
  const step = totp.verifyTotp(RFC_SECRET, code, { timeMs: now });
  assert.equal(totp.verifyTotp(RFC_SECRET, code, { timeMs: now, afterStep: step }), null);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, now + 30000), { timeMs: now, afterStep: step }), step + 1);
});

test('the otpauth URL is what authenticator apps read', () => {
  const url = new URL(totp.otpauthUrl({ secret: 'JBSWY3DPEHPK3PXP', account: 'owner@example.com', issuer: 'GymsPilotPro' }));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(decodeURIComponent(url.pathname), '/GymsPilotPro:owner@example.com');
  assert.equal(url.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(url.searchParams.get('issuer'), 'GymsPilotPro');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
});

test('backup codes: ten, shown once, kept as hashes, matched however typed', () => {
  const { codes, hashes } = totp.generateBackupCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hashes.some((hash) => codes.includes(hash)));

  assert.equal(totp.matchBackupCode(hashes, codes[3]), 3);
  assert.equal(totp.matchBackupCode(hashes, ` ${codes[3].toUpperCase().replace('-', '')} `), 3);
  assert.equal(totp.matchBackupCode(hashes, 'aaaaa-aaaaa'), -1);
  assert.equal(totp.matchBackupCode(hashes, '123456'), -1);
});
