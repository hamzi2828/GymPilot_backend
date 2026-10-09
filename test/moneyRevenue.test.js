// Membership revenue: every payment counts once in the period it arrived --
// the first payment and each renewal -- and a refund comes off once, in the
// period it was given. Pure logic, no database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/accounts/services/ledger');

const range = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') };

test('a fully refunded sale nets to nothing, not to minus the sale', () => {
  // The payment stays in revenue; the refund is taken off once.
  const result = L.netResult({ revenue: { GBP: 100 }, refunds: { GBP: 100 }, spent: {} }, 'GBP');
  assert.equal(result.gross_income, 0);
  assert.equal(result.net, 0);
  assert.equal(result.margin, null);
});

test('a partial refund takes off only what went back, and spending comes off net', () => {
  const result = L.netResult({ revenue: { GBP: 250 }, refunds: { GBP: 30 }, spent: { GBP: 20 } }, 'GBP');
  assert.equal(result.gross_income, 220);
  assert.equal(result.expenses, 20);
  assert.equal(result.net, 200);
  assert.equal(result.margin, 90.9);
});

test('money in another currency is never netted against the base currency', () => {
  const result = L.netResult({ revenue: { GBP: 100, PKR: 5000 }, refunds: { PKR: 5000 }, spent: { PKR: 100 } }, 'GBP');
  assert.equal(result.gross_income, 100);
  assert.equal(result.net, 100);
});

test('the payments pipeline counts renewals as payments of their own', () => {
  const stages = L.membershipPaymentStages(range);
  const [match, project, unwind, cut, shape] = stages;

  // Orders are found by any payment in range: the first one or a renewal.
  const clauses = match.$match.$and;
  assert.deepEqual(clauses[0], { 'payment.status': { $in: ['paid', 'refunded'] } });
  const paths = clauses[clauses.length - 1].$or.map((clause) => Object.keys(clause)[0]);
  assert.deepEqual(paths, ['payment.paidAt', 'createdAt', 'subscription.renewals.at', 'payment.installments.at']);

  // Each order becomes its first payment (or its parts, when it was paid in
  // parts) plus one entry per renewal, and only the entries inside the
  // range are kept.
  const [own, renewals] = project.$project.entries.$concatArrays;
  const [, , [initial]] = own.$cond;
  assert.equal(initial.kind, 'initial');
  // What was taken: all of it on an order from before part payments.
  assert.deepEqual(initial.amount, { $ifNull: ['$payment.amountPaid', '$payment.amount'] });
  assert.equal(renewals.$map.in.kind, 'renewal');
  assert.equal(renewals.$map.in.amount, '$$renewal.amount');
  assert.equal(renewals.$map.in.at, '$$renewal.at');
  assert.deepEqual(unwind, { $unwind: '$entries' });
  // ...less the first payment of a membership imported already paid: that
  // money was taken in the gym's old system, not on the day of the import.
  // Its later parts and renewals stay.
  assert.equal(project.$project.imported, 1);
  assert.deepEqual(cut, {
    $match: { 'entries.at': { $gte: range.start, $lt: range.end }, $nor: [{ imported: true, 'entries.kind': 'initial' }] }
  });
  assert.equal(shape.$project.at, '$entries.at');
});

test('the payments pipeline keeps a caller\'s filters beside its own', () => {
  const [match] = L.membershipPaymentStages(range, { $or: [{ orderNumber: /x/ }] }, { statuses: ['pending'] });
  const clauses = match.$match.$and;
  assert.deepEqual(clauses[0], { 'payment.status': { $in: ['pending'] } });
  // The caller's own $or is not overwritten by the range's.
  assert.equal(clauses.length, 3);
  assert.ok(clauses[1].$or[0].orderNumber instanceof RegExp);
});

test('an order whose paidAt was overwritten by a renewal is read from createdAt', () => {
  // Older renewals moved payment.paidAt onto themselves; those orders fall
  // back to createdAt for their first payment so the renewal is not counted
  // twice and the original sale is not lost.
  const expr = L.firstPaymentAtExpr();
  assert.equal(expr.$cond[1], '$createdAt');
  assert.deepEqual(expr.$cond[2], { $ifNull: ['$payment.paidAt', '$createdAt'] });
  assert.equal(expr.$cond[0].$anyElementTrue[0].$map.input.$ifNull[0], '$subscription.renewals');
});

test('refunds are dated when the money went back and sized by what went back', () => {
  const [match, project, cut] = L.membershipRefundStages(range);
  assert.deepEqual(match.$match.$and[0], { 'payment.status': 'refunded' });
  assert.deepEqual(match.$match.$and[1].$or[0], { 'refund.at': { $gte: range.start, $lt: range.end } });
  assert.deepEqual(project.$project.amount, { $ifNull: ['$refund.amount', { $ifNull: ['$payment.amount', 0] }] });
  assert.equal(project.$project.at.$ifNull[0], '$refund.at');
  assert.deepEqual(cut, { $match: { at: { $gte: range.start, $lt: range.end } } });
});
