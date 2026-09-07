// scripts/expireMemberships.js
//
// Marks every membership whose end date has passed as expired.
//
//   node scripts/expireMemberships.js          # report only, changes nothing
//   node scripts/expireMemberships.js --apply  # write the changes
//
// The request path already sweeps this (see membershipExpiry.sweepIfDue), so
// this script is for two other cases: a real cron on a host that has one, and
// the first run after deploying the fix, when a backlog of orders that lapsed
// months ago is waiting to be corrected.
//
// Dry by default. A script that rewrites order statuses the moment it is run
// is not something anyone should be able to do by pressing up-arrow twice.

require('dotenv').config();
const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('./lib/tenantScript');
const { expireLapsedOrders, countLapsed } = require('../src/gymfolio/services/membershipExpiry');
const PackageOrder = require('../src/gymfolio/models/packageOrderModel');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  // Every gym has its own database: --gym <slug> picks which one.
  enterContext(await resolveGymContextFromArgs());

  const now = new Date();
  const pending = await countLapsed(now);

  console.log(`Cluster  : ${mongoose.connection.host}`);
  console.log(`As at    : ${now.toISOString()}`);
  console.log(`Lapsed but still marked active: ${pending}`);

  if (pending === 0) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Show what would change before changing it, so the operator can spot a
  // wrong date or a package whose period was mis-typed.
  const sample = await PackageOrder.find({
    'payment.status': 'paid',
    status: 'active',
    'subscription.endDate': { $ne: null, $lt: now }
  })
    .select('orderNumber customerInfo.email packageDetails.name subscription.endDate')
    .sort({ 'subscription.endDate': 1 })
    .limit(20)
    .lean();

  console.log('\nOldest first:');
  for (const order of sample) {
    const ended = order.subscription.endDate.toISOString().slice(0, 10);
    const name = (order.packageDetails && order.packageDetails.name) || '—';
    console.log(`  ${order.orderNumber}  ${ended}  ${name}  ${order.customerInfo.email}`);
  }
  if (pending > sample.length) {
    console.log(`  ... and ${pending - sample.length} more`);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to make these changes.');
    await mongoose.disconnect();
    return;
  }

  const { expired } = await expireLapsedOrders(now);
  console.log(`\nDone. ${expired} membership(s) marked expired.`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
