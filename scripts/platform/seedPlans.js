// The price list the platform sells: four plans, priced for Pakistan.
//
//   node scripts/platform/seedPlans.js            -- show what would change
//   node scripts/platform/seedPlans.js --apply    -- write it
//
// Plans are matched by slug, so running this twice changes nothing the second
// time. Gyms already on a plan keep the amount and currency agreed with them
// -- this only changes what the next gym is quoted -- and any gym on a plan is
// listed at the end so nobody is repriced by surprise.
//
// Every plan is the whole product. What separates them is size (how many
// members, staff, trainers and classes), how quickly we answer, and whether
// we do the move-in for you. That is the promise the website makes, so the
// feature lists here must not quietly contradict it.

const mongoose = require('mongoose');
const { connect, hasFlag } = require('../lib/tenantScript');
const PlatformPlan = require('../../src/platform/models/platformPlanModel');
const Gym = require('../../src/platform/models/gymModel');

// Priced for the market rather than converted from a dollar list. Yearly is
// ten months, so paying for a year up front saves two.
const PLANS = [
  {
    slug: 'basic',
    name: 'Basic',
    description: 'For a new studio or a single room finding its feet.',
    price: { monthly: 2500, yearly: 25000, currency: 'PKR' },
    limits: { maxMembers: 150, maxStaff: 3, maxTrainers: 3, maxClasses: 15 },
    trialDays: 14,
    order: 1,
    features: [
      'Up to 150 members',
      '3 staff, 3 trainers, 15 classes a week',
      'Your own website and member phone app',
      'Billing, class booking, messaging and reports',
      'Email support'
    ]
  },
  {
    slug: 'starter',
    name: 'Starter',
    description: 'For studios and single-room gyms getting off spreadsheets.',
    price: { monthly: 4900, yearly: 49000, currency: 'PKR' },
    limits: { maxMembers: 300, maxStaff: 5, maxTrainers: 5, maxClasses: 30 },
    trialDays: 14,
    order: 2,
    features: [
      'Up to 300 members',
      '5 staff, 5 trainers, 30 classes a week',
      'Everything in Basic, member app included',
      'Email support'
    ]
  },
  {
    slug: 'growth',
    name: 'Growth',
    description: 'For busy gyms with a full timetable, a PT team and a front desk.',
    price: { monthly: 8900, yearly: 89000, currency: 'PKR' },
    limits: { maxMembers: 1500, maxStaff: 20, maxTrainers: 20, maxClasses: 0 },
    trialDays: 14,
    order: 3,
    features: [
      'Up to 1,500 members',
      '20 staff, 20 trainers, as many classes as you like',
      'Everything in Starter, member app included',
      'Your members brought over for you',
      'Priority support'
    ]
  },
  {
    slug: 'pro',
    name: 'Pro',
    description: 'For clubs running several rooms, a big team and their own books.',
    price: { monthly: 12000, yearly: 120000, currency: 'PKR' },
    limits: { maxMembers: 0, maxStaff: 0, maxTrainers: 0, maxClasses: 0 },
    trialDays: 30,
    order: 4,
    features: [
      'Unlimited members, staff and trainers',
      'As many classes and rooms as you run',
      'Everything in Growth, member app included',
      'Set up and moved in with you',
      'Phone and WhatsApp support'
    ]
  }
];

const money = (n, currency) => `${currency} ${Number(n || 0).toLocaleString('en-US')}`;

async function main() {
  await connect();
  const apply = hasFlag('--apply');

  for (const wanted of PLANS) {
    const existing = await PlatformPlan.findOne({ slug: wanted.slug });

    if (!existing) {
      console.log(`\n${wanted.name} (${wanted.slug}) -- new`);
      console.log(`  ${money(wanted.price.monthly, wanted.price.currency)}/mo, ${money(wanted.price.yearly, wanted.price.currency)}/yr`);
      if (apply) {
        await PlatformPlan.create(wanted);
        console.log('  created');
      }
      continue;
    }

    console.log(`\n${existing.name} (${existing.slug})`);
    console.log(`  price  ${money(existing.price.monthly, existing.price.currency)}/mo, ${money(existing.price.yearly, existing.price.currency)}/yr`);
    console.log(`     ->  ${money(wanted.price.monthly, wanted.price.currency)}/mo, ${money(wanted.price.yearly, wanted.price.currency)}/yr`);

    const added = wanted.features.filter((f) => !(existing.features || []).includes(f));
    const gone = (existing.features || []).filter((f) => !wanted.features.includes(f));
    added.forEach((f) => console.log(`  + ${f}`));
    gone.forEach((f) => console.log(`  - ${f}`));

    if (apply) {
      existing.name = wanted.name;
      existing.description = wanted.description;
      existing.price = wanted.price;
      existing.limits = wanted.limits;
      existing.features = wanted.features;
      existing.trialDays = wanted.trialDays;
      existing.order = wanted.order;
      await existing.save();
      console.log('  written');
    }
  }

  const onPlans = await Gym.find({ plan: { $ne: null } }).select('slug subscription').lean();
  console.log(`\nGyms already on a plan: ${onPlans.length}`);
  for (const gym of onPlans) {
    const sub = gym.subscription || {};
    console.log(`  ${gym.slug}: ${money(sub.amount, sub.currency || '-')} ${sub.billingCycle || ''} (${sub.status || '-'}) -- left as agreed`);
  }

  console.log(apply ? '\nDone.\n' : '\nDry run. Re-run with --apply to write.\n');
}

main()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
