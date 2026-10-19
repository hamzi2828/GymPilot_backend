// scripts/sendReminders.js
//
// The daily job: expire lapsed memberships, send renewal payment links (and
// charge saved cards on the due date, where the gym does), warn members whose
// membership is about to run out, and remind everyone booked into a class
// tomorrow.
//
//   node scripts/sendReminders.js            # report only, sends nothing
//   node scripts/sendReminders.js --send     # actually send
//
// Dry by default, because the failure mode of getting this wrong is emailing
// every member of the gym something they did not need.
//
// Run it once a day from whatever scheduler the host has (cron, Task
// Scheduler, a CI job). On Vercel, where there is no such thing, use the
// /api/jobs/reminders endpoint instead -- see index.js.

require('dotenv').config();
const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('./lib/tenantScript');
const { runDaily, EXPIRY_NOTICE_DAYS } = require('../src/services/reminderJobs');

const SEND = process.argv.includes('--send');

function report(title, result) {
  console.log(`\n${title}`);
  console.log(`  sent: ${result.counts.sent}   skipped: ${result.counts.skipped}`);
  for (const row of result.sent.slice(0, 25)) {
    console.log(`    -> ${row.to}  ${row.class || `${row.days} day notice`}`);
  }
  if (result.sent.length > 25) console.log(`    ... and ${result.sent.length - 25} more`);

  // Skips are the interesting half when something looks wrong: "no email
  // address" and "already sent" are very different problems.
  const reasons = {};
  for (const row of result.skipped) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  for (const [reason, n] of Object.entries(reasons)) console.log(`    skipped ${n}: ${reason}`);
}

// The payment-link reminders and due-date card charges (services/billing/).
function reportBilling(billing) {
  console.log('\nPayment link reminders');
  if (!billing) return;
  if (billing.error) {
    console.log(`  failed: ${billing.error}`);
    return;
  }
  console.log(`  ${billing.enabled ? 'on' : `off: ${billing.reason}`}   gateway: ${billing.provider || 'none (bank details only)'}   auto-charge: ${billing.autoChargeOn ? 'on' : 'off'}`);
  const c = billing.counts || {};
  console.log(`  renewal orders made: ${c.created || 0}   closed: ${c.closed || 0}   messages: ${c.sent || 0}   cards charged: ${c.charged || 0}   declined: ${c.declined || 0}`);
  for (const row of (billing.created || []).slice(0, 25)) {
    console.log(`    + ${row.order} -> ${row.package} ${row.amount}, due ${row.dueDate}, last day ${row.lastDay}`);
  }
  for (const row of (billing.sent || []).slice(0, 25)) console.log(`    -> ${row.order}  ${row.message}${row.milestone ? ` (${row.milestone})` : ''}`);
  for (const row of billing.closed || []) console.log(`    x ${row.order}  ${row.reason}`);
  // "package no longer on sale" is the one the gym has to act on.
  const reasons = {};
  for (const row of [...(billing.skipped || []), ...(billing.quiet || [])]) {
    const why = row.reason || row.skipped;
    if (why) reasons[why] = (reasons[why] || 0) + 1;
  }
  for (const [reason, n] of Object.entries(reasons)) console.log(`    skipped ${n}: ${reason}`);
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  // Every gym has its own database: --gym <slug> picks which one.
  enterContext(await resolveGymContextFromArgs());
  console.log(`Cluster         : ${mongoose.connection.host}`);
  console.log(`Expiry notices  : ${EXPIRY_NOTICE_DAYS.join(', ')} days before`);
  console.log(`Mode            : ${SEND ? 'SENDING' : 'dry run (nothing will be sent)'}`);

  const result = await runDaily({ dryRun: !SEND });

  if (SEND) console.log(`\nMemberships expired: ${result.expired.expired}`);
  reportBilling(result.billing);
  report('Membership expiry notices', result.memberships);
  report(`Class reminders for ${result.classes.date}`, result.classes);

  if (!SEND) {
    console.log('\nDry run — nothing was sent. Re-run with --send to send for real.');
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
