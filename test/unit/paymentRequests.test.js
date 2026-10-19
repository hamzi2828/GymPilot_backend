// A gym's bank-transfer receipt for GymsPilotPro, as plain functions: what
// the super admin's list and the gym's Billing tab are shown, and the
// emails the owner gets -- the reason a receipt was rejected is the super
// admin's text, so it is escaped. No database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const requests = require('../../src/platform/services/paymentRequests');

const gymId = new mongoose.Types.ObjectId();
const row = (fields = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  gymId,
  gymSlug: 'iron-works',
  gymName: 'Iron Works',
  amount: 8000,
  currency: 'PKR',
  billingCycle: 'monthly',
  receiptUrl: '/uploads/iron-works/receipt.png',
  reference: 'IBFT-1',
  note: '',
  submittedAt: new Date('2026-10-18T09:00:00Z'),
  submittedBy: { id: 'u1', email: 'owner@iron.test', name: 'Ali Raza' },
  status: 'pending',
  reason: '',
  reviewedAt: null,
  reviewedBy: { id: null, email: '' },
  paymentId: null,
  ...fields
});

test("the super admin's list shows every field, the reviewer only once reviewed", () => {
  const pending = requests.publicRequest(row());
  assert.deepEqual(Object.keys(pending).sort(), ['amount', 'billingCycle', 'currency', 'gymId', 'gymName', 'gymSlug', 'id', 'note', 'paymentId', 'reason', 'receiptUrl', 'reference', 'reviewedAt', 'reviewedBy', 'status', 'submittedAt', 'submittedBy'].sort());
  assert.equal(pending.reviewedBy, null);
  assert.equal(pending.submittedAt, '2026-10-18T09:00:00.000Z');
  const reviewer = new mongoose.Types.ObjectId();
  const paymentId = new mongoose.Types.ObjectId();
  const approved = requests.publicRequest(row({ status: 'approved', reviewedAt: new Date('2026-10-19T00:00:00Z'), reviewedBy: { id: reviewer, email: 'admin@gpp.test' }, paymentId }));
  assert.deepEqual(approved.reviewedBy, { id: String(reviewer), email: 'admin@gpp.test' });
  assert.equal(approved.paymentId, String(paymentId));
});

test("the gym's Billing tab is told pending, or rejected with why -- and nothing for an approved one", () => {
  assert.equal(requests.gymView(null), null);
  assert.deepEqual(requests.gymView(row()), { status: 'pending', reason: '', submitted_at: '2026-10-18T09:00:00.000Z', amount: 8000 });
  assert.deepEqual(requests.gymView(row({ status: 'rejected', reason: 'Wrong amount' })).reason, 'Wrong amount');
  assert.equal(requests.gymView(row({ status: 'approved', reason: 'ignored' })).status, null);
});

test('the owner emails name the gym and link to its Billing tab; a rejection reason is escaped', () => {
  const gym = { name: 'Iron <Works>', slug: 'iron-works', domains: [{ host: 'ironworks.com', isPrimary: true }], owner: { firstName: 'Ali', email: 'ali@iron.test' }, subscription: { currentPeriodEnd: new Date('2026-12-01T00:00:00Z') } };
  const thanks = requests.approvedEmail({ gym, request: row() });
  assert.match(thanks.subject, /payment received/);
  assert.match(thanks.html, /PKR 8,000/);
  assert.match(thanks.html, /https:\/\/ironworks\.com\/admin\/settings\?tab=billing/);
  assert.doesNotMatch(thanks.html, /<Works>/);

  const sorry = requests.rejectedEmail({ gym, request: row({ status: 'rejected', reason: '<script>alert(1)</script> wrong bank' }) });
  assert.match(sorry.subject, /could not confirm/);
  assert.doesNotMatch(sorry.html, /<script>/);
  assert.match(sorry.html, /&lt;script&gt;/);
  assert.match(sorry.html, /Upload receipt/);
});

test('the subscription after a payment is shown with an ISO paid-until date', () => {
  assert.deepEqual(requests.subscriptionView({ subscription: { status: 'active', billingCycle: 'yearly', currentPeriodEnd: new Date('2027-01-01T00:00:00Z'), amount: 80000, currency: 'pkr' } }), {
    status: 'active',
    billingCycle: 'yearly',
    currentPeriodEnd: '2027-01-01T00:00:00.000Z',
    amount: 80000,
    currency: 'PKR'
  });
});
