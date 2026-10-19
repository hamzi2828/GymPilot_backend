// Confirming, rejecting and re-sending the receipt of a bank transfer,
// without a database: each is one conditional update on the order as it is
// stored -- still awaiting payment or review, and not held by an approval
// under way -- and a refusal says what the order has become. Model statics
// are stood in for; the races themselves are run against a real MongoDB in
// test/integration/bankTransfer.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const PackageOrder = require('../../src/gymfolio/models/packageOrderModel');
const service = require('../../src/gymfolio/services/membershipService');

function stub(target, methods) {
  const saved = {};
  for (const [name, fn] of Object.entries(methods)) {
    saved[name] = target[name];
    target[name] = fn;
  }
  return () => {
    for (const [name, fn] of Object.entries(saved)) target[name] = fn;
  };
}

/**
 * Runs `fn` with every conditional update finding nothing (somebody got
 * there first) and the order then reading back as `storedStatus`.
 */
async function refusedBecause(storedStatus, fn) {
  const writes = [];
  await runWithTenant({ _id: 'unit-transfer-gym', slug: 'transfer-gym', database: { name: 'gympilot_unit_transfer_gym' }, domains: [] }, async () => {
    const restore = stub(PackageOrder, {
      findOneAndUpdate: async (filter, update) => {
        writes.push({ filter, update });
        return null;
      },
      findById: () => ({ select: () => ({ lean: async () => (storedStatus ? { payment: { status: storedStatus } } : null) }) })
    });
    try {
      await fn(writes);
    } finally {
      restore();
    }
  });
  return writes;
}

// The caller's copy, read before the order moved on: still awaiting review.
const staleCopy = () => ({ _id: 'order-1', payment: { method: 'bank_transfer', status: 'processing', proof: { url: '/uploads/receipt.png' } } });
const now = new Date('2026-10-09T10:00:00Z');

test('approve, reject and a new receipt all act only on an order still awaiting payment or review, and not held', async () => {
  const calls = {
    approve: () => service.approveTransfer(staleCopy(), { by: null, now }),
    reject: () => service.rejectTransfer(staleCopy(), { by: null, reason: 'No such transfer', now }),
    proof: () => service.submitTransferProof(staleCopy(), { reference: 'REF', now })
  };
  for (const [name, call] of Object.entries(calls)) {
    const writes = await refusedBecause('paid', async () => {
      await assert.rejects(call(), (error) => error.name === 'MembershipError' && error.code === 'ALREADY_PAID' && error.status === 400);
    });
    assert.equal(writes.length, 1, name);
    const { filter } = writes[0];
    assert.equal(filter._id, 'order-1');
    assert.deepEqual(filter['payment.status'], { $in: ['pending', 'processing'] }, name);
    // No approval holds it, or only one that died more than ten minutes ago.
    assert.deepEqual(filter.$or, [{ 'payment.proof.reviewedAt': null }, { 'payment.proof.reviewedAt': { $lt: new Date('2026-10-09T09:50:00Z') } }], name);
  }
});

test('the approval claims the order by writing the review, before anything is activated', async () => {
  const staff = new mongoose.Types.ObjectId();
  const writes = await refusedBecause('paid', async () => {
    await assert.rejects(service.approveTransfer(staleCopy(), { by: staff, now }));
  });
  assert.deepEqual(writes[0].update, {
    $set: { 'payment.proof.reviewedAt': now, 'payment.proof.reviewedBy': staff, 'payment.proof.rejectionReason': '' }
  });
  // Nothing about the payment or the membership is written by the claim itself.
  assert.equal(Object.keys(writes[0].update.$set).some((key) => key === 'payment.status' || key === 'status'), false);
});

test('a refusal says what became of the order, in words the desk or the member can act on', async () => {
  const cases = [
    ['paid', 400, 'ALREADY_PAID', /^This order is already paid$/],
    ['refunded', 409, 'ORDER_CLOSED', /^This order was refunded, so it cannot be opened again\. Start a new order for the package instead\.$/],
    ['failed', 409, 'ORDER_CLOSED', /^This order is closed: its payment was not accepted\. It cannot be opened again; start a new order for the package instead\.$/],
    // Cancelled before it was paid: closed for good, and said so.
    ['cancelled', 409, 'ORDER_CLOSED', /^This order was cancelled, so no transfer can be sent or confirmed for it\. Start a new order for the package instead\.$/],
    [null, 409, 'ORDER_CLOSED', /^This order is closed/],
    // Still reviewable, so the update lost to an approval holding it.
    ['processing', 409, 'REVIEW_IN_PROGRESS', /^Somebody else is confirming this payment right now\. Reload the order in a moment\.$/],
    ['pending', 409, 'REVIEW_IN_PROGRESS', /^Somebody else is confirming/]
  ];
  for (const [stored, status, code, message] of cases) {
    await refusedBecause(stored, async () => {
      for (const call of [
        () => service.approveTransfer(staleCopy(), { now }),
        () => service.rejectTransfer(staleCopy(), { now }),
        () => service.submitTransferProof(staleCopy(), { reference: 'REF', now })
      ]) {
        await assert.rejects(call(), (error) => {
          assert.deepEqual([error.status, error.code], [status, code], String(stored));
          assert.match(error.message, message);
          return true;
        });
      }
    });
  }
});

test('a rejection closes the order in the same write, and a receipt keeps the file already sent', async () => {
  const rejected = await refusedBecause('paid', async () => {
    await assert.rejects(service.rejectTransfer(staleCopy(), { by: 'not-an-id', reason: 'No such transfer', now }));
  });
  const set = rejected[0].update.$set;
  assert.deepEqual([set['payment.status'], set.status, set['payment.proof.rejectionReason']], ['failed', 'cancelled', 'No such transfer']);
  // Who did it is an account id or nothing, never a string that fails the write.
  assert.equal(set['payment.proof.reviewedBy'], null);
  assert.deepEqual(set.cancellation, { cancelledAt: now, reason: 'No such transfer', by: null, source: 'staff' });

  const proof = await refusedBecause('paid', async () => {
    await assert.rejects(service.submitTransferProof(staleCopy(), { reference: 'REF-2', note: 'second try', now }));
  });
  assert.deepEqual(proof[0].update.$set, {
    'payment.proof': { url: '/uploads/receipt.png', note: 'second try', reference: 'REF-2', uploadedAt: now, reviewedAt: null, reviewedBy: null, rejectionReason: '' },
    'payment.status': 'processing',
    status: 'pending'
  });

  // An order that was never a transfer takes no receipt at all.
  const none = await refusedBecause('pending', async () => {
    const cash = { _id: 'order-2', payment: { method: 'cash', status: 'pending' } };
    await assert.rejects(service.submitTransferProof(cash, { reference: 'REF', now }), /This order was not paid by bank transfer/);
  });
  assert.equal(none.length, 0);
});
