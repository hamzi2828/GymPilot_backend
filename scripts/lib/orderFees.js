// scripts/lib/orderFees.js
//
// The work behind scripts/backfillOrderFees.js, on the gym whose context the
// caller has entered, kept apart from the script's gym selection so the
// integration tests can run it against a real database.
//
// Orders written before payment.joiningFee existed added the package's fee
// to the list price and kept one total. Such an order charged the fee when
// its subtotal is exactly the price plus the fee (orderMoney.legacyJoiningFee).
// They come in two states:
//
//   * the field missing -- never saved since;
//   * the field 0 -- saved since by code that knows the field (a freeze, a
//     cancellation, a Stripe webhook...): Mongoose writes a missing path's
//     schema default with any save(), so the order now claims it carried no
//     admission fee.
//
// A 0 is also what an order written since the split records when it charged
// no fee, so the second state is narrowed to what only an old order can be.
// Every writer since records the fee it charged, so price + fee in the
// subtotal with 0 recorded comes about in two ways only: a total of 0 (the
// fee allocated nothing, and nothing is filled in), or the fee waived with a
// trainer's fee of the same amount -- and trainers were first sold with a
// membership after the split, so an old order has no trainer's fee and no
// trainer. `before` (the day the split went live on this server) narrows it
// to orders created before then as well.

const PackageOrder = require('../../src/gymfolio/models/packageOrderModel');
const { legacyJoiningFee, round2 } = require('../../src/gymfolio/services/orderMoney');

function candidateFilter({ before = null } = {}) {
  const resaved = {
    'payment.joiningFee': 0,
    'payment.trainerFee': { $in: [0, null] },
    trainerAssignment: null
  };
  if (before) resaved.createdAt = { $lt: before };
  return {
    'packageDetails.joiningFee': { $gt: 0 },
    'payment.subtotal': { $ne: null },
    $or: [{ 'payment.joiningFee': { $exists: false } }, resaved]
  };
}

/**
 * The orders to fill in, and nothing written: `{ candidates, updates:
 * [{ order, fee, resaved }], totals: { CUR: fee } }`, oldest first.
 * `before`: a Date; re-saved orders created from then on are left alone.
 */
async function planOrderFees({ before = null } = {}) {
  // lean(): a hydrated document would fill the missing field in with its
  // default (0) and hide exactly the orders this is looking for.
  const candidates = await PackageOrder.find(candidateFilter({ before }))
    .select('orderNumber createdAt customerInfo.fullName packageDetails payment.amount payment.subtotal payment.currency payment.joiningFee')
    .sort({ createdAt: 1 })
    .lean();

  const updates = [];
  const totals = {};
  for (const order of candidates) {
    const resaved = order.payment.joiningFee !== undefined && order.payment.joiningFee !== null;
    // The 0 on a re-saved order is the default a save wrote, not what the
    // order carried: read it as the missing field it stands for.
    const fee = legacyJoiningFee(resaved ? { ...order, payment: { ...order.payment, joiningFee: undefined } } : order);
    if (!(fee > 0)) continue;
    updates.push({ order, fee, resaved });
    const currency = String(order.payment.currency || '').toUpperCase() || '?';
    totals[currency] = round2((totals[currency] || 0) + fee);
  }
  return { candidates: candidates.length, updates, totals };
}

/** Writes the plan's fees; the number of orders changed. */
async function applyOrderFees(updates) {
  if (!updates.length) return 0;
  // Conditional on the field still being as it was found (missing, or the
  // default 0), so an order written in between is left as its own code
  // wrote it.
  const result = await PackageOrder.bulkWrite(
    updates.map(({ order, fee, resaved }) => ({
      updateOne: {
        filter: { _id: order._id, 'payment.joiningFee': resaved ? 0 : { $exists: false } },
        update: { $set: { 'payment.joiningFee': fee } }
      }
    })),
    { ordered: false }
  );
  return result.modifiedCount;
}

module.exports = { candidateFilter, planOrderFees, applyOrderFees };
