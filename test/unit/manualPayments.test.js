// A payment taken outside Stripe, recorded by hand: where it moves the
// paid-until date, what the form is refused for, what is written, and that a
// second click is the same payment. No database: the statics are stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const PlatformPayment = require('../../src/platform/models/platformPaymentModel');
const { addCycle, nextPaidUntil, paymentTerms, validatePayment, recordPayment, ManualPaymentError } = require('../../src/platform/services/manualPayments');

const now = new Date('2026-10-09T09:30:00Z');
const day = (iso) => new Date(`${iso}T00:00:00Z`);

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

function gymBilledByHand(subscription = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    slug: 'iron-works',
    status: 'active',
    subscription: { status: 'expired', billingCycle: 'monthly', amount: 8000, currency: 'PKR', currentPeriodEnd: day('2026-09-20'), startedAt: day('2026-08-20'), ...subscription }
  };
}

const form = (fields = {}) => ({ amount: 8000, method: 'jazzcash', receivedAt: '2026-10-08', reference: 'TID-4471', note: '', requestId: 'req-0001-abcd', ...fields });

/** The payments collection and the gym write, stood in for. */
function world({ rows = [], gymWriteFails = false } = {}) {
  const calls = { created: [], gymWrites: [], removed: [] };
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => String(row[key]) === String(value));
  const restore = [
    stub(PlatformPayment, {
      findOne: (filter) => ({ lean: async () => rows.find((row) => match(row, filter)) || null }),
      create: async (doc) => {
        const row = { _id: new mongoose.Types.ObjectId(), createdAt: now, ...doc };
        rows.push(row);
        calls.created.push(row);
        return row;
      },
      deleteOne: async (filter) => {
        calls.removed.push(filter);
        return { deletedCount: 1 };
      }
    }),
    stub(Gym, {
      updateOne: async (filter, update) => {
        if (gymWriteFails) throw new Error('database unreachable');
        calls.gymWrites.push({ filter, update });
        return { matchedCount: 1 };
      }
    })
  ];
  return { calls, rows, restore: () => restore.reverse().forEach((fn) => fn()) };
}

test('a cycle on is the same day next month or next year, or the last day the month has', () => {
  assert.deepEqual(addCycle(day('2026-10-09'), 'monthly'), day('2026-11-09'));
  assert.deepEqual(addCycle(day('2026-10-09'), 'yearly'), day('2027-10-09'));
  assert.deepEqual(addCycle(day('2026-01-31'), 'monthly'), day('2026-02-28'));
  assert.deepEqual(addCycle(day('2026-12-15'), 'monthly'), day('2027-01-15'));
  assert.deepEqual(addCycle(day('2028-02-29'), 'yearly'), day('2029-02-28'));
});

test('paid until moves one cycle on from the later of today and the date already paid until', () => {
  // Lapsed: a full cycle from today, not one that is half over.
  assert.deepEqual(nextPaidUntil({ billingCycle: 'monthly', currentPeriodEnd: day('2026-09-20') }, now), { from: day('2026-10-09'), paidUntil: day('2026-11-09') });
  // Paying early (the rest of a trial included) loses nothing.
  assert.deepEqual(nextPaidUntil({ billingCycle: 'monthly', currentPeriodEnd: day('2026-10-20') }, now), { from: day('2026-10-20'), paidUntil: day('2026-11-20') });
  assert.deepEqual(nextPaidUntil({ billingCycle: 'yearly', currentPeriodEnd: null }, now).paidUntil, day('2027-10-09'));
  assert.deepEqual(nextPaidUntil(null, now).paidUntil, day('2026-11-09'));
});

test('the form starts from the bill and the next date; a gym that pays by card cannot be billed by hand', () => {
  const terms = paymentTerms(gymBilledByHand(), now);
  assert.equal(terms.canRecord, true);
  assert.equal(terms.amount, 8000);
  assert.equal(terms.currency, 'PKR');
  assert.deepEqual(terms.paidUntil, day('2026-11-09'));
  assert.deepEqual(terms.methods.map((m) => m.value), ['bank_transfer', 'jazzcash', 'easypaisa', 'cash', 'other']);

  const card = paymentTerms(gymBilledByHand({ stripeSubscriptionId: 'sub_1' }), now);
  assert.equal(card.canRecord, false);
  assert.match(card.reason, /pays by card through Stripe/);
});

test('what the form is refused for, in words', () => {
  const gym = gymBilledByHand();
  const first = (fields) => validatePayment(form(fields), gym, now).errors[0];
  assert.equal(validatePayment(form(), gym, now).errors.length, 0);
  assert.equal(first({ amount: '' }), 'Enter the amount received');
  assert.equal(first({ amount: -5 }), 'Enter the amount received');
  assert.equal(first({ method: 'cheque' }), 'Choose how it was paid');
  assert.equal(first({ receivedAt: 'yesterday-ish' }), 'The date received is not a valid date');
  assert.equal(first({ receivedAt: '2026-10-12' }), 'The date received cannot be in the future');
  assert.match(first({ reference: ' ' }), /Enter the JazzCash reference/);
  // Cash has no transaction id to ask for.
  assert.equal(validatePayment(form({ method: 'cash', reference: '' }), gym, now).errors.length, 0);
  assert.equal(first({ paidUntil: '2026-10-01' }), 'Paid until must be a date in the future');
  assert.match(validatePayment(form({ paidUntil: '2026-10-15' }), gymBilledByHand({ currentPeriodEnd: day('2026-10-20') }), now).errors[0], /already paid until 2026-10-20/);
  assert.match(first({ requestId: '' }), /request id/);

  // Left alone, paid until is one cycle on; typed, it is what was typed.
  assert.deepEqual(validatePayment(form(), gym, now).data.periodTo, day('2026-11-09'));
  assert.deepEqual(validatePayment(form({ paidUntil: '2026-12-01' }), gym, now).data.periodTo, day('2026-12-01'));
});

test('a payment is kept, moves the paid-until date and brings a lapsed gym back', async () => {
  const gym = gymBilledByHand({ status: 'expired', pastDueSince: day('2026-09-21'), notices: { pastDue: day('2026-09-21'), expired: day('2026-09-28') } });
  const actor = { _id: new mongoose.Types.ObjectId(), email: 'admin@gympilot.test' };
  const w = world();
  try {
    const { payment, duplicate } = await recordPayment({ gym, input: form({ note: ' paid from the owner\'s account ' }), actor, now });
    assert.equal(duplicate, false);
    assert.equal(payment.amount, 8000);
    assert.equal(payment.currency, 'PKR');
    assert.equal(payment.method, 'jazzcash');
    assert.equal(payment.reference, 'TID-4471');
    assert.equal(payment.note, "paid from the owner's account");
    assert.deepEqual(payment.receivedAt, day('2026-10-08'));
    assert.deepEqual(payment.periodFrom, day('2026-09-20'));
    assert.deepEqual(payment.periodTo, day('2026-11-09'));
    assert.equal(payment.statusBefore, 'expired');
    assert.equal(payment.recordedBy.email, 'admin@gympilot.test');
    assert.equal(String(payment.gymId), String(gym._id));

    assert.equal(w.calls.gymWrites.length, 1);
    const set = w.calls.gymWrites[0].update.$set;
    assert.equal(set['subscription.status'], 'active');
    assert.deepEqual(set['subscription.currentPeriodEnd'], day('2026-11-09'));
    assert.equal(set['subscription.pastDueSince'], null);
    assert.equal(set['subscription.cancelledAt'], null);
    // A new period: its reminders can go out again.
    assert.equal(set['subscription.notices.pastDue'], null);
    assert.equal(set['subscription.notices.expired'], null);
    // Named fields only: nothing else on the subscription is rewritten.
    assert.ok(Object.keys(set).every((key) => key.startsWith('subscription.')));
    assert.ok(!('subscription.startedAt' in set), 'it started when it started');
    assert.ok(!('subscription.amount' in set));
  } finally {
    w.restore();
  }
});

test('a second click on Save is the same payment: nothing is recorded or moved twice', async () => {
  const gym = gymBilledByHand();
  const w = world();
  try {
    const first = await recordPayment({ gym, input: form(), now });
    // The page still holds the gym as it was before the first click landed.
    const second = await recordPayment({ gym, input: form(), now });
    assert.equal(second.duplicate, true);
    assert.equal(String(second.payment._id), String(first.payment._id));
    assert.equal(w.calls.created.length, 1);
    assert.equal(w.calls.gymWrites.length, 1);

    // Two clicks that raced: the unique index refuses the loser, which answers with the winner.
    const restore = stub(PlatformPayment, {
      findOne: (() => {
        let asked = 0;
        return () => ({ lean: async () => ((asked += 1) === 1 ? null : first.payment) });
      })(),
      create: async () => {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
    });
    try {
      const raced = await recordPayment({ gym, input: form({ reference: '' , method: 'cash' }), now });
      assert.equal(raced.duplicate, true);
      assert.equal(w.calls.gymWrites.length, 1);
    } finally {
      restore();
    }
  } finally {
    w.restore();
  }
});

test('the same transfer typed in again is refused; so is a gym that pays by card', async () => {
  const gym = gymBilledByHand();
  const w = world();
  try {
    await recordPayment({ gym, input: form(), now });
    const paidUp = { ...gym, subscription: { ...gym.subscription, status: 'active', currentPeriodEnd: day('2026-11-09') } };
    await assert.rejects(recordPayment({ gym: paidUp, input: form({ requestId: 'req-0002-efgh' }), now }), (error) => {
      assert.ok(error instanceof ManualPaymentError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'DUPLICATE_REFERENCE');
      assert.match(error.message, /JazzCash payment with reference "TID-4471" is already recorded/);
      return true;
    });
    await assert.rejects(recordPayment({ gym: gymBilledByHand({ stripeSubscriptionId: 'sub_1' }), input: form({ requestId: 'req-0003-ijkl' }), now }), (error) => error.status === 409 && error.code === 'STRIPE_BILLED');
    await assert.rejects(recordPayment({ gym, input: form({ requestId: 'req-0004-mnop', amount: 0 }), now }), (error) => error.status === 400 && error.code === 'INVALID_PAYMENT');
    assert.equal(w.calls.created.length, 1);
    assert.equal(w.calls.gymWrites.length, 1);
  } finally {
    w.restore();
  }
});

test('a payment that could not move the date is not left on record', async () => {
  const w = world({ gymWriteFails: true });
  try {
    await assert.rejects(recordPayment({ gym: gymBilledByHand(), input: form(), now }), /database unreachable/);
    assert.equal(w.calls.created.length, 1);
    assert.deepEqual(w.calls.removed, [{ _id: w.calls.created[0]._id }]);
  } finally {
    w.restore();
  }
});
