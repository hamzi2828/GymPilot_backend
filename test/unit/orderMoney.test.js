// What an order's money is made of: admission fee, trainer's fee and the
// membership, allocated admission first -- and how the accounts pipeline
// reads it back. Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../src/gymfolio/services/orderMoney');
const L = require('../../src/accounts/services/ledger');

test('a full payment carries each fee whole and the membership as the rest', () => {
  assert.deepEqual(M.allocate(95, { joiningFee: 25, trainerFee: 30 }), { joiningFee: 25, trainerFee: 30, membership: 40 });
  assert.deepEqual(M.allocate(40), { joiningFee: 0, trainerFee: 0, membership: 40 });
});

test('less than the fees settles admission first, then the trainer, then the membership', () => {
  assert.deepEqual(M.allocate(20, { joiningFee: 25, trainerFee: 30 }), { joiningFee: 20, trainerFee: 0, membership: 0 });
  assert.deepEqual(M.allocate(40, { joiningFee: 25, trainerFee: 30 }), { joiningFee: 25, trainerFee: 15, membership: 0 });
  assert.deepEqual(M.allocate(0, { joiningFee: 25 }), { joiningFee: 0, trainerFee: 0, membership: 0 });
  // Pennies do not drift.
  assert.deepEqual(M.allocate(10.3, { joiningFee: 0.1, trainerFee: 0.2 }), { joiningFee: 0.1, trainerFee: 0.2, membership: 10 });
});

test('the parts are never negative, whatever is sent', () => {
  assert.deepEqual(M.allocate(-5, { joiningFee: 25 }), { joiningFee: 0, trainerFee: 0, membership: 0 });
  assert.deepEqual(M.allocate(50, { joiningFee: -10, trainerFee: 'x' }), { joiningFee: 0, trainerFee: 0, membership: 50 });
});

function legacy({ price = '40', fee = 25, subtotal = 65, amount = 65, joiningFee } = {}) {
  const payment = { amount, subtotal };
  if (joiningFee !== undefined) payment.joiningFee = joiningFee;
  return { packageDetails: { price, joiningFee: fee }, payment };
}

test('a legacy order whose subtotal is price + fee charged the fee', () => {
  assert.equal(M.legacyJoiningFee(legacy()), 25);
  // Formatted prices read like the order did.
  assert.equal(M.legacyJoiningFee(legacy({ price: 'Rs 4,000', fee: 1000, subtotal: 5000, amount: 5000 })), 1000);
  // Discounted below the fee: only what the total could carry.
  assert.equal(M.legacyJoiningFee(legacy({ amount: 10 })), 10);
});

test('a legacy order that did not charge it, or already says, is left alone', () => {
  assert.equal(M.legacyJoiningFee(legacy({ subtotal: 40, amount: 40 })), null, 'subtotal is the price alone');
  assert.equal(M.legacyJoiningFee(legacy({ subtotal: null })), null, 'from before subtotals');
  assert.equal(M.legacyJoiningFee(legacy({ fee: 0, subtotal: 40 })), null, 'no fee on the package');
  assert.equal(M.legacyJoiningFee(legacy({ joiningFee: 0 })), null, 'already recorded (as none)');
  assert.equal(M.legacyJoiningFee(legacy({ joiningFee: 25 })), null, 'already recorded');
  assert.equal(M.legacyJoiningFee(legacy({ price: 'free-ish' })), null, 'an unreadable price is not guessed at');
});

test('the payments pipeline gives every payment its admission, trainer and membership shares', () => {
  const range = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') };
  const stages = L.membershipPaymentStages(range);
  const [, project, , , shape] = stages;
  const [own, renewals] = project.$project.entries.$concatArrays;

  // Paid in parts: each part as a payment of its own, the first 'initial'.
  const [hasParts, parts, [whole]] = own.$cond;
  assert.deepEqual(hasParts, { $gt: [{ $size: { $ifNull: ['$payment.installments', []] } }, 0] });
  const part = parts.$map.in.$let.in;
  assert.deepEqual(part.kind, { $cond: [{ $eq: ['$$i', 0] }, 'initial', 'installment'] });
  assert.deepEqual(part.admission, { $ifNull: ['$$part.joiningFee', 0] });
  assert.deepEqual(part.trainerFee, { $ifNull: ['$$part.trainerFee', 0] });
  // A part paid another way says so; otherwise the order's method.
  assert.equal(part.method.$cond[2], '$payment.method');

  // Paid at once: admission first out of what was taken.
  assert.equal(whole.kind, 'initial');
  assert.deepEqual(whole.admission, { $min: [{ $ifNull: ['$payment.joiningFee', 0] }, { $ifNull: ['$payment.amountPaid', '$payment.amount'] }] });

  // A renewal carries neither fee.
  assert.equal(renewals.$map.in.admission, 0);
  assert.equal(renewals.$map.in.trainerFee, 0);

  // The row: membership is what is left, and the method is the payment's own.
  assert.deepEqual(shape.$project.method, { $ifNull: ['$entries.method', '$method'] });
  assert.deepEqual(shape.$project.membership.$round[0], {
    $subtract: [{ $ifNull: ['$entries.amount', 0] }, { $add: [{ $ifNull: ['$entries.admission', 0] }, { $ifNull: ['$entries.trainerFee', 0] }] }]
  });
});
