// Which caller gets to activate a Stripe-paid order, and how a claim that
// fails is handed back. Pure decisions; the database calls that apply them
// are in gymfolioPaymentService.
const test = require('node:test');
const assert = require('node:assert/strict');

const claim = require('../../src/gymfolio/services/activationClaim');

test('a claim is refused once paid, while another caller holds it, or once the sale was undone; allowed otherwise', () => {
  assert.equal(claim.canClaimActivation('paid'), false);
  assert.equal(claim.canClaimActivation('processing'), false);
  // Refunded money is not a payment to activate on, however late the event.
  assert.equal(claim.canClaimActivation('refunded'), false);
  assert.equal(claim.canClaimActivation('cancelled'), false);
  // A checkout that expired or a card that was declined can still be paid.
  for (const status of ['pending', 'failed', '', undefined, null]) {
    assert.equal(claim.canClaimActivation(status), true, `${status} can be claimed`);
  }
});

test('the claim filter and update express exactly that rule for the database', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const filter = claim.claimFilter('order-1', now);
  assert.equal(filter._id, 'order-1');
  const [byStatus, stale] = filter.$or;
  assert.equal(filter.$or.length, 2);
  assert.deepEqual([...byStatus['payment.status'].$nin].sort(), ['cancelled', 'paid', 'processing', 'refunded']);
  // ...or a card order's claim that nothing has touched for ten minutes.
  assert.deepEqual(stale, { 'payment.status': 'processing', 'payment.method': 'stripe', updatedAt: { $lt: new Date('2026-10-09T09:50:00Z') } });
  assert.equal(claim.STALE_CLAIM_MS, 10 * 60 * 1000);
  assert.deepEqual([...claim.UNDONE_STATUSES].sort(), ['cancelled', 'refunded']);
  assert.deepEqual(claim.claimUpdate(), { $set: { 'payment.status': 'processing' } });
  assert.equal(claim.CLAIMED_STATUS, 'processing');
});

test('a claim left by a request that died is taken over after ten minutes, and not a moment sooner', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const minutesAgo = (n) => new Date(now.getTime() - n * 60 * 1000);
  const claimed = (updatedAt, method = 'stripe') => ({ payment: { status: 'processing', method }, updatedAt });

  // Held a moment ago: somebody is activating it right now.
  assert.equal(claim.claimable(claimed(minutesAgo(1)), now), false);
  assert.equal(claim.claimable(claimed(minutesAgo(10)), now), false);
  // Untouched for longer than any activation takes: its request is gone.
  assert.equal(claim.claimable(claimed(minutesAgo(11)), now), true);
  assert.equal(claim.claimable(claimed(minutesAgo(3 * 24 * 60)), now), true);
  // An order with no record of when it was last written is not guessed at.
  assert.equal(claim.claimable(claimed(undefined), now), false);

  // A bank transfer's 'processing' is a receipt waiting to be checked,
  // however long that takes: never a claim, never taken over.
  assert.equal(claim.claimable(claimed(minutesAgo(600), 'bank_transfer'), now), false);
  assert.equal(claim.held(claimed(minutesAgo(600), 'bank_transfer')), false);

  // The statuses that could always be claimed still can; the settled ones never.
  for (const status of ['pending', 'failed']) assert.equal(claim.claimable({ payment: { status, method: 'stripe' } }, now), true, status);
  for (const status of ['paid', 'refunded', 'cancelled']) {
    assert.equal(claim.claimable({ payment: { status, method: 'stripe' }, updatedAt: minutesAgo(600) }, now), false, status);
  }
});

test('held says whether another caller has the order, live or stale', () => {
  assert.equal(claim.held({ payment: { status: 'processing', method: 'stripe' } }), true);
  for (const status of ['pending', 'paid', 'failed', 'refunded', 'cancelled']) assert.equal(claim.held({ payment: { status, method: 'stripe' } }), false, status);
  assert.equal(claim.held(null), false);
  assert.equal(claim.held({}), false);
});

test('a stale claim taken over and failed again is released to pending, so the next retry can win it', () => {
  // The winner of a takeover read 'processing' as the status before its claim.
  assert.deepEqual(claim.releaseUpdate(claim.CLAIMED_STATUS), { $set: { 'payment.status': 'pending' } });
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
