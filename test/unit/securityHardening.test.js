// Audit-trail redaction, rate-limit keys and the one view of a user's own
// account. Pure logic apart from the audit model, which runs against a
// tenant context that never touches the network.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const { clientKey } = require('../../src/middleware/rateLimit');
const { publicUserView } = require('../../src/services/userView');

const gym = { _id: '000000000000000000000001', slug: 'a', database: { name: 'gympilot_unit_a' } };

test('the audit trail keeps credentials hidden and personal data redacted, at any depth', async () => {
  const AdminAuditLog = require('../../src/models/adminAuditLogModel');
  const summary = await runWithTenant(gym, () =>
    AdminAuditLog.summariseBody({
      firstName: 'Ann',
      password: 'hunter2',
      stripe: { secretKey: 'sk_test_1', enabled: true },
      medical: { conditions: 'asthma' },
      medicalNotes: 'private',
      staffNotes: 'private too',
      emergencyContact: { name: 'Bob', phone: '0123' },
      dateOfBirth: '1990-01-01',
      dob: '1990-01-01',
      address: '1 High Street',
      documents: [{ name: 'passport.pdf' }],
      payroll: { accountNumber: '12345678', iban: 'GB00', salary: 1000 },
      parq: { answers: [true] },
      injuries: 'knee',
      allergies: 'nuts',
      tags: ['vip'],
      nested: { deeper: { nationalId: 'X1', health: 'ok', fine: 'kept' } },
      title: 'x'.repeat(200)
    })
  );

  assert.equal(summary.firstName, 'Ann');
  assert.equal(summary.password, '[hidden]');
  assert.equal(summary.stripe.secretKey, '[hidden]');
  assert.equal(summary.stripe.enabled, true);
  for (const key of ['medical', 'medicalNotes', 'staffNotes', 'emergencyContact', 'dateOfBirth', 'dob', 'address', 'documents', 'parq', 'injuries', 'allergies']) {
    assert.equal(summary[key], '[redacted]', key);
  }
  assert.equal(summary.payroll.accountNumber, '[redacted]');
  assert.equal(summary.payroll.iban, '[redacted]');
  assert.equal(summary.payroll.salary, 1000);
  assert.equal(summary.nested.deeper.nationalId, '[redacted]');
  assert.equal(summary.nested.deeper.health, '[redacted]');
  assert.equal(summary.nested.deeper.fine, 'kept');
  assert.equal(summary.tags, '[1 items]');
  assert.equal(summary.title.length, 120);
  assert.equal(await runWithTenant(gym, () => AdminAuditLog.summariseBody(null)), null);
});

test('rate limits are keyed on req.ip, never on a header the caller wrote', () => {
  assert.equal(clientKey({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '198.51.100.1' } }), '203.0.113.9');
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '198.51.100.1' }, socket: { remoteAddress: '203.0.113.7' } }), '203.0.113.7');
  assert.equal(clientKey({ headers: {} }), 'unknown');
  // IPv6 collapses to the subscriber prefix, so one /64 is one bucket.
  const a = clientKey({ ip: '2001:db8:85a3:8d3:1319:8a2e:370:7348' });
  const b = clientKey({ ip: '2001:db8:85a3:8d3:ffff:ffff:ffff:ffff' });
  assert.equal(a, b);
  assert.notEqual(a, clientKey({ ip: '2001:db8:85a3:1111:1319:8a2e:370:7348' }));
});

test('a member sees their own account without the staff-only and credential fields', () => {
  const user = {
    _id: 'u1',
    firstName: 'Ann',
    lastName: 'Lee',
    email: 'ann@example.com',
    username: 'annlee123',
    role: 'user',
    phone: '0123',
    avatarUrl: '/uploads/a.png',
    password: 'hash',
    passwordResetTokenHash: 'h',
    passwordResetExpiresAt: new Date(),
    passwordChangedAt: new Date(),
    twoFactor: { enabled: true, pending: { challengeId: 'c', codeHash: 'x', attempts: 1 } },
    consents: { biometric: { given: true } },
    notificationPreferences: { email: true },
    staffNotes: 'do not renew',
    medical: { conditions: 'asthma', notes: 'staff only' },
    documents: [{ name: 'id.pdf' }],
    automation: { absentNudgedAt: new Date() },
    waiver: { signedAt: new Date(), version: '1.0', signature: 'Ann Lee', ip: '203.0.113.9' },
    employment: { isStaff: true, jobTitle: 'Coach', payroll: { salary: 1000, accountNumber: '1' } },
    addresses: [],
    tags: ['vip']
  };

  const view = publicUserView(user);
  for (const key of ['password', 'passwordResetTokenHash', 'passwordResetExpiresAt', 'passwordChangedAt', 'staffNotes', 'medical', 'documents', 'automation']) {
    assert.equal(key in view, false, `${key} is not returned`);
  }
  assert.deepEqual(view.twoFactor, { enabled: true });
  assert.equal('ip' in view.waiver, false);
  assert.equal(view.waiver.signature, 'Ann Lee');
  assert.equal('payroll' in view.employment, false);
  assert.equal(view.employment.jobTitle, 'Coach');
  // Everything the website and the app read is still there.
  for (const key of ['_id', 'firstName', 'lastName', 'email', 'username', 'role', 'phone', 'avatarUrl', 'consents', 'notificationPreferences', 'addresses', 'tags']) {
    assert.ok(key in view, key);
  }
  assert.equal(publicUserView(null), null);
  // A document works the same way as a plain object.
  assert.equal(publicUserView({ toObject: () => ({ ...user }) }).twoFactor.enabled, true);
});
