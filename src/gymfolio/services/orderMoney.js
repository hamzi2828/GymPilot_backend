// src/gymfolio/services/orderMoney.js
//
// What an order's money is made of. `payment.amount` is one figure, but it
// can carry three things the accounts keep apart:
//
//   payment.joiningFee   the admission fee charged on THIS order (0 on a
//                        renewal, a package change, or when waived)
//   payment.trainerFee   the personal trainer's fee charged on it
//   the rest             the membership itself:
//                        amount - joiningFee - trainerFee, never below 0
//
// A discount comes off the package price only. When staff charge a
// different total (an amount override) -- or a payment covers only part of
// the order -- the money is allocated to the admission fee first, then the
// trainer's fee, then the membership: the fixed charges are settled before
// the term itself. Everything here is pure arithmetic, shared by the
// service that writes orders and the pipelines that read them
// (accounts/services/ledger.membershipPaymentStages).

const { parseAmount } = require('../../helper/money');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Splits `amount` into its parts, admission first.
 * @returns {{ joiningFee: number, trainerFee: number, membership: number }}
 */
function allocate(amount, { joiningFee = 0, trainerFee = 0 } = {}) {
  const total = Math.max(0, round2(amount));
  const admission = Math.min(Math.max(0, round2(joiningFee)), total);
  const trainer = Math.min(Math.max(0, round2(trainerFee)), round2(total - admission));
  return { joiningFee: admission, trainerFee: trainer, membership: round2(total - admission - trainer) };
}

/**
 * The joining fee a legacy order carried inside its total, or null when it
 * carried none (or already says what it carried).
 *
 * Orders written before payment.joiningFee existed added the package's fee
 * to the list price: their subtotal is exactly price + fee. Those whose
 * subtotal is the price alone did not charge it; the oldest have no
 * subtotal at all, from before joining fees existed. What was charged is
 * then allocated like any payment -- admission first -- so a discounted or
 * overridden total below the fee carries only what it could.
 */
function legacyJoiningFee(order) {
  const payment = (order && order.payment) || {};
  if (payment.joiningFee !== undefined && payment.joiningFee !== null) return null;
  const fee = round2(order.packageDetails && order.packageDetails.joiningFee);
  if (!(fee > 0)) return null;
  if (payment.subtotal === undefined || payment.subtotal === null) return null;
  const price = parseAmount(order.packageDetails && order.packageDetails.price);
  if (price === null || price === undefined) return null;
  if (Math.abs(round2(payment.subtotal) - round2(price + fee)) >= 0.01) return null;
  return allocate(payment.amount, { joiningFee: fee }).joiningFee;
}

/**
 * The money received for an order so far: the recorded amountPaid, or --
 * on an order from before part payments -- all of it once it was paid.
 */
function paidSoFar(payment = {}) {
  if (payment.amountPaid !== undefined && payment.amountPaid !== null) return round2(payment.amountPaid);
  return ['paid', 'refunded'].includes(payment.status) ? round2(payment.amount) : 0;
}

/**
 * The order's payments as parts, for adding another: its installments, or
 * -- when it has none but money was taken (paid at once, in full or in
 * part) -- that first payment as one part, dated when it was paid, so the
 * accounts keep counting it where it was received.
 */
function partsSoFar(payment = {}, { firstAt = null } = {}) {
  const parts = Array.isArray(payment.installments) ? payment.installments.map((part) => (part.toObject ? part.toObject() : { ...part })) : [];
  if (parts.length) return parts;
  const taken = paidSoFar(payment);
  if (!(taken > 0)) return [];
  const shares = allocate(taken, { joiningFee: payment.joiningFee, trainerFee: payment.trainerFee });
  return [
    {
      amount: taken,
      joiningFee: shares.joiningFee,
      trainerFee: shares.trainerFee,
      method: payment.method || '',
      at: payment.paidAt || firstAt || new Date(),
      by: null,
      note: 'Paid when the membership was sold'
    }
  ];
}

/**
 * The next part of an order's money: `amount`, with whatever is still owed
 * of the admission fee and the trainer's fee taken first.
 */
function nextPart(payment = {}, parts = [], amount) {
  const sum = (key) => parts.reduce((total, part) => total + (Number(part[key]) || 0), 0);
  const joiningOwed = Math.max(0, round2((payment.joiningFee || 0) - sum('joiningFee')));
  const trainerOwed = Math.max(0, round2((payment.trainerFee || 0) - sum('trainerFee')));
  const shares = allocate(amount, { joiningFee: joiningOwed, trainerFee: trainerOwed });
  return { amount: round2(amount), joiningFee: shares.joiningFee, trainerFee: shares.trainerFee };
}

module.exports = { round2, allocate, legacyJoiningFee, paidSoFar, partsSoFar, nextPart };
