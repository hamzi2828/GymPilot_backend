// Which caller gets to activate a Stripe-paid order, and how a claim that
// fails is handed back. Pure decisions; the database calls that apply them
// are in gymfolioPaymentService.
const test = require('node:test');
const assert = require('node:assert/strict');

const claim = require('../../src/gymfolio/services/activationClaim');

test('a claim is refused once paid or while another caller holds it, and allowed otherwise', () => {
  assert.equal(claim.canClaimActivation('paid'), false);
  assert.equal(claim.canClaimActivation('processing'), false);
  for (const status of ['pending', 'failed', 'cancelled', 'refunded', '', undefined, null]) {
    assert.equal(claim.canClaimActivation(status), true, `${status} can be claimed`);
  }
});

test('the claim filter and update express exactly that rule for the database', () => {
  const filter = claim.claimFilter('order-1');
  assert.equal(filter._id, 'order-1');
  assert.deepEqual([...filter['payment.status'].$nin].sort(), ['paid', 'processing']);
  assert.deepEqual(claim.claimUpdate(), { $set: { 'payment.status': 'processing' } });
  assert.equal(claim.CLAIMED_STATUS, 'processing');
});

test('a release only touches an order still held, and restores the status it had', () => {
  assert.deepEqual(claim.releaseFilter('order-1'), { _id: 'order-1', 'payment.status': 'processing' });
  assert.deepEqual(claim.releaseUpdate('pending'), { $set: { 'payment.status': 'pending' } });
  assert.deepEqual(claim.releaseUpdate('failed'), { $set: { 'payment.status': 'failed' } });
  // Never release INTO a state that would block the retry: a paid or
  // processing "previous" status cannot have won the claim in the first place.
  assert.deepEqual(claim.releaseUpdate('paid'), { $set: { 'payment.status': 'pending' } });
  assert.deepEqual(claim.releaseUpdate('processing'), { $set: { 'payment.status': 'pending' } });
  assert.deepEqual(claim.releaseUpdate(undefined), { $set: { 'payment.status': 'pending' } });
});

test('simulated race: of two callers only the first wins, the second sees the order as taken', () => {
  // A minimal stand-in for findOneAndUpdate with the claim filter.
  const order = { _id: 'o1', payment: { status: 'pending' } };
  const attempt = () => {
    if (!claim.canClaimActivation(order.payment.status)) return null;
    const before = { ...order.payment };
    order.payment.status = claim.CLAIMED_STATUS;
    return before;
  };
  const first = attempt();
  const second = attempt();
  assert.deepEqual(first, { status: 'pending' });
  assert.equal(second, null);
  // The winner finishes: paid. A late third caller is refused too.
  order.payment.status = 'paid';
  assert.equal(attempt(), null);
});
