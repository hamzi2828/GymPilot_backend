process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithTenant } = require('../../src/platform/tenantContext');
const { issueQrToken, verifyQrToken } = require('../../src/attendance/services/qrToken');

const gymA = { _id: '000000000000000000000001', slug: 'a', database: { name: 'gympilot_unit_a' } };
const gymB = { _id: '000000000000000000000002', slug: 'b', database: { name: 'gympilot_unit_b' } };
const personId = '6a9e47dadf00918e9825a73e';

test('a QR token verifies for the gym that issued it and nobody else', async () => {
  const { token, expiresAt } = await runWithTenant(gymA, () => issueQrToken({ personType: 'member', personId }));
  assert.match(token, /^GPQ1\.member\./);
  assert.ok(expiresAt.getTime() > Date.now());

  await runWithTenant(gymA, () => {
    assert.deepEqual(verifyQrToken(token), { personType: 'member', personId });
    // Always a different last character: a signature that already ended in
    // 'x' made the old "tamper" a no-op (about one run in 64).
    const tampered = token.slice(0, -1) + (token.endsWith('x') ? 'y' : 'x');
    assert.equal(verifyQrToken(tampered), null, 'tampered signature');
    assert.equal(verifyQrToken('GPQ1.member.notanid.1.sig'), null);
  });

  await runWithTenant(gymB, () => {
    assert.equal(verifyQrToken(token), null, 'another gym cannot honour it');
  });
});

test('an expired token is refused', async () => {
  await runWithTenant(gymA, () => {
    const { token } = issueQrToken({ personType: 'staff', personId });
    const parts = token.split('.');
    parts[3] = String(Math.floor(Date.now() / 1000) - 10);
    assert.equal(verifyQrToken(parts.join('.')), null);
  });
});
