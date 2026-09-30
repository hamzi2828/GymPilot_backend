// scripts/backfillOrderFees.js
//
// Records the joining fee on package orders written before
// payment.joiningFee existed.
//
//   node scripts/backfillOrderFees.js --gym <slug>          # report only, changes nothing
//   node scripts/backfillOrderFees.js --gym <slug> --apply  # write the changes
//
// Those orders added the package's fee to the list price and kept one
// total, so the accounts could not tell admission money from membership
// money: every order without the field reads 0 admission. An order's fee was
// charged when its subtotal is exactly the price plus the fee
// (orderMoney.legacyJoiningFee); what it carried is allocated like any
// payment, admission first, so a total discounted or overridden below the
// fee records only what it could. Orders that already say what they carried
// are never touched, so running it twice changes nothing the second time.
//
// Dry by default, like every script that rewrites orders.

require('dotenv').config();
const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('./lib/tenantScript');
const PackageOrder = require('../src/gymfolio/models/packageOrderModel');
const { legacyJoiningFee, round2 } = require('../src/gymfolio/services/orderMoney');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  // Every gym has its own database: --gym <slug> picks which one.
  enterContext(await resolveGymContextFromArgs());

  // lean(): a hydrated document would fill the missing field in with its
  // default (0) and hide exactly the orders this is looking for.
  const candidates = await PackageOrder.find({
    'payment.joiningFee': { $exists: false },
    'packageDetails.joiningFee': { $gt: 0 },
    'payment.subtotal': { $ne: null }
  })
    .select('orderNumber createdAt customerInfo.fullName packageDetails payment.amount payment.subtotal payment.currency payment.joiningFee')
    .sort({ createdAt: 1 })
    .lean();

  const updates = [];
  const totals = {};
  for (const order of candidates) {
    const fee = legacyJoiningFee(order);
    if (!(fee > 0)) continue;
    updates.push({ order, fee });
    const currency = String(order.payment.currency || '').toUpperCase() || '?';
    totals[currency] = round2((totals[currency] || 0) + fee);
  }

  console.log(`Cluster  : ${mongoose.connection.host}`);
  console.log(`Orders with a joining fee on the package and none recorded: ${candidates.length}`);
  console.log(`... of which charged it inside their total: ${updates.length}`);

  if (!updates.length) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Admission money to be told apart: ${Object.entries(totals).map(([c, v]) => `${c} ${v}`).join(', ')}`);
  console.log('\nOldest first:');
  for (const { order, fee } of updates.slice(0, 20)) {
    const made = new Date(order.createdAt).toISOString().slice(0, 10);
    console.log(`  ${order.orderNumber}  ${made}  ${order.packageDetails.name}  total ${order.payment.amount}  -> joining fee ${fee}`);
  }
  if (updates.length > 20) console.log(`  ... and ${updates.length - 20} more`);

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to make these changes.');
    await mongoose.disconnect();
    return;
  }

  // Conditional on the field still being missing, so an order written in
  // between is left as its own code wrote it.
  const result = await PackageOrder.bulkWrite(
    updates.map(({ order, fee }) => ({
      updateOne: {
        filter: { _id: order._id, 'payment.joiningFee': { $exists: false } },
        update: { $set: { 'payment.joiningFee': fee } }
      }
    })),
    { ordered: false }
  );
  console.log(`\nDone. ${result.modifiedCount} order(s) now record their joining fee.`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
