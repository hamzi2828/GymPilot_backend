// scripts/backfillOrderFees.js
//
// Records the joining fee on package orders written before
// payment.joiningFee existed.
//
//   node scripts/backfillOrderFees.js --gym <slug>          # report only, changes nothing
//   node scripts/backfillOrderFees.js --gym <slug> --apply  # write the changes
//   ... --before 2026-10-01    # re-saved orders: only those created before this day
//
// Those orders added the package's fee to the list price and kept one
// total, so the accounts could not tell admission money from membership
// money: every order without the field reads 0 admission. An order's fee was
// charged when its subtotal is exactly the price plus the fee
// (orderMoney.legacyJoiningFee); what it carried is allocated like any
// payment, admission first, so a total discounted or overridden below the
// fee records only what it could.
//
// Old orders saved since (frozen, cancelled, touched by a Stripe webhook)
// had the schema's default 0 written into the field by that save, and are
// found too -- see scripts/lib/orderFees.js for how they are told from
// orders written since, and `--before` (the day this server started
// recording the fee) to narrow them further. Orders that say what they
// carried are never touched, so running it twice changes nothing the
// second time.
//
// Dry by default, like every script that rewrites orders.

require('dotenv').config();
const mongoose = require('mongoose');
const { argValue, enterContext, resolveGymContextFromArgs } = require('./lib/tenantScript');
const { planOrderFees, applyOrderFees } = require('./lib/orderFees');

const APPLY = process.argv.includes('--apply');

function readBefore() {
  const value = argValue('--before');
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    console.error(`--before takes a date as YYYY-MM-DD, not "${value}".`);
    process.exit(1);
  }
  return new Date(`${value}T00:00:00Z`);
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env.');
    process.exit(1);
  }
  const before = readBefore();

  await mongoose.connect(process.env.MONGO_URI);
  // Every gym has its own database: --gym <slug> picks which one.
  enterContext(await resolveGymContextFromArgs());

  const { candidates, updates, totals } = await planOrderFees({ before });
  const resaved = updates.filter((entry) => entry.resaved).length;

  console.log(`Cluster  : ${mongoose.connection.host}`);
  if (before) console.log(`Re-saved orders created before ${before.toISOString().slice(0, 10)} only`);
  console.log(`Orders with a joining fee on the package and none recorded: ${candidates}`);
  console.log(`... of which charged it inside their total: ${updates.length} (${resaved} saved since with a 0 in the field)`);

  if (!updates.length) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Admission money to be told apart: ${Object.entries(totals).map(([c, v]) => `${c} ${v}`).join(', ')}`);
  console.log('\nOldest first:');
  for (const { order, fee, resaved: wasSaved } of updates.slice(0, 20)) {
    const made = new Date(order.createdAt).toISOString().slice(0, 10);
    console.log(`  ${order.orderNumber}  ${made}  ${order.packageDetails.name}  total ${order.payment.amount}  -> joining fee ${fee}${wasSaved ? '  (was 0)' : ''}`);
  }
  if (updates.length > 20) console.log(`  ... and ${updates.length - 20} more`);

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to make these changes.');
    await mongoose.disconnect();
    return;
  }

  const changed = await applyOrderFees(updates);
  console.log(`\nDone. ${changed} order(s) now record their joining fee.`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
