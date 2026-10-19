// The payment methods a membership can be recorded with, and their labels.
// Pure logic, no database.

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../src/services/paymentMethods');

test('every method has a label, and the list is the one the contract names', () => {
  assert.deepEqual(M.PAYMENT_METHODS, ['stripe', 'card', 'bank_transfer', 'cash', 'jazzcash', 'easypaisa', 'wallet', 'online']);
  for (const method of M.PAYMENT_METHODS) assert.ok(M.METHOD_LABELS[method], method);
  assert.equal(M.methodLabel('stripe'), 'Card (Stripe)');
  assert.equal(M.methodLabel('card'), 'Card');
  assert.equal(M.methodLabel('bank_transfer'), 'Bank transfer');
  assert.equal(M.methodLabel('wallet'), 'Other mobile wallet');
  // Something older or foreign is shown as stored, not hidden.
  assert.equal(M.methodLabel('cheque'), 'cheque');
  assert.equal(M.methodLabel(undefined), '');
});

test('nothing sent is cash; a known desk method is kept as it is', () => {
  for (const empty of [undefined, null, '']) assert.deepEqual(M.readDeskMethod(empty), { method: 'cash', problem: null });
  for (const method of ['card', 'bank_transfer', 'cash', 'jazzcash', 'easypaisa', 'wallet']) {
    assert.deepEqual(M.readDeskMethod(method), { method, problem: null });
  }
  assert.equal(M.readDeskMethod(undefined, { fallback: 'card' }).method, 'card');
});

test('an unknown method is refused, never turned into cash', () => {
  for (const wrong of ['paypal', 'Cash', 'CARD', ' cash', 'crypto']) {
    const read = M.readDeskMethod(wrong);
    assert.equal(read.method, null, wrong);
    assert.match(read.problem, /is not a payment method this gym records/);
    assert.match(read.problem, /jazzcash \(JazzCash\)/);
  }
});

test('Stripe is not a desk method: it is only ever taken through checkout', () => {
  assert.ok(!M.DESK_METHODS.includes('stripe'));
  const read = M.readDeskMethod('stripe');
  assert.equal(read.method, null);
  assert.match(read.problem, /online checkout/);
});

test('an online payment is not a desk method either: only the gateway records one', () => {
  assert.ok(!M.DESK_METHODS.includes('online'));
  assert.deepEqual(M.GATEWAY_METHODS, ['stripe', 'online']);
  const read = M.readDeskMethod('online');
  assert.equal(read.method, null);
  assert.match(read.problem, /recorded by the payment gateway/);
  assert.doesNotMatch(M.readDeskMethod('paypal').problem, /Online payment/);
});
