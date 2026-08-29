// Seeder/createAccounts.js
//
// Books for a development gym: a year of running costs and an equipment
// register, so the accounts screens have something honest to show.
//
//   node Seeder/createAccounts.js             seed (12 months of costs)
//   node Seeder/createAccounts.js --months 6  a shorter history
//   node Seeder/createAccounts.js --reset     delete only what this seeded
//
// The currency is taken from whatever the gym's PAID sales are actually
// denominated in, falling back to the settings currency. Seeding costs in a
// currency the income is not in would produce a P&L whose two halves cannot be
// subtracted -- technically correct and completely useless to look at.

require('dotenv').config();
const mongoose = require('mongoose');

const Expense = require('../src/accounts/models/expenseModel');
const Asset = require('../src/accounts/models/assetModel');
const PackageOrder = require('../src/gymfolio/models/packageOrderModel');
const Settings = require('../src/models/settings');
const User = require('../src/models/user');
const T = require('../src/attendance/services/timeUtils');
const L = require('../src/accounts/services/ledger');

const SEED_NOTE = 'seeded:createAccounts';

let rngState = 20260830;
function random() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function randomInt(min, max) {
  return min + Math.floor(random() * (max - min + 1));
}
function vary(base, percent) {
  return Math.round(base * (1 + (random() * 2 - 1) * percent));
}

// ---------------------------------------------------------------------------
// What a gym pays for every month, and roughly what it costs relative to rent.
// Amounts are scaled from one number so the whole set stays plausible whatever
// currency this ends up in.
// ---------------------------------------------------------------------------

const MONTHLY = [
  { title: 'Premises rent',              category: 'rent',        share: 1.00, method: 'bank_transfer', vendor: 'Property Management', recurring: true },
  { title: 'Electricity',                category: 'utilities',   share: 0.34, method: 'online',        vendor: 'Power Utility',       recurring: true },
  { title: 'Water & sanitation',         category: 'utilities',   share: 0.05, method: 'online',        vendor: 'Water Board',         recurring: true },
  { title: 'Internet & phone',           category: 'utilities',   share: 0.04, method: 'card',          vendor: 'Telecom',             recurring: true },
  { title: 'Gym management software',    category: 'software',    share: 0.06, method: 'card',          vendor: 'SaaS Vendor',         recurring: true },
  { title: 'Cleaning supplies & towels', category: 'supplies',    share: 0.08, method: 'cash',          vendor: 'Local Supplier',      recurring: true },
  { title: 'Public liability insurance', category: 'insurance',   share: 0.09, method: 'bank_transfer', vendor: 'Insurer',             recurring: true }
];

// The costs that only show up some months -- which is what makes a trend line
// worth looking at rather than a flat repeat of the same figure.
const OCCASIONAL = [
  { title: 'Treadmill belt replacement',   category: 'maintenance',  share: 0.12, method: 'cash',          vendor: 'Fitness Service Co', chance: 0.35 },
  { title: 'Air conditioning service',     category: 'maintenance',  share: 0.09, method: 'bank_transfer', vendor: 'HVAC Services',      chance: 0.30 },
  { title: 'Social media advertising',     category: 'marketing',    share: 0.16, method: 'card',          vendor: 'Ad Platform',        chance: 0.55 },
  { title: 'Printed flyers & banners',     category: 'marketing',    share: 0.06, method: 'cash',          vendor: 'Print Shop',         chance: 0.25 },
  { title: 'Protein & drinks restock',     category: 'refreshments', share: 0.11, method: 'cash',          vendor: 'Wholesaler',         chance: 0.60 },
  { title: 'Trade licence renewal',        category: 'licenses',     share: 0.07, method: 'online',        vendor: 'City Council',       chance: 0.12 },
  { title: 'Equipment deep clean',         category: 'maintenance',  share: 0.05, method: 'cash',          vendor: 'Cleaning Crew',      chance: 0.30 },
  { title: 'Staff uniforms',               category: 'supplies',     share: 0.07, method: 'card',          vendor: 'Apparel Supplier',   chance: 0.15 }
];

// The register. Life years are left to the model's per-category defaults, and
// service intervals are only set on the things that genuinely need servicing --
// a rack of dumbbells does not have a maintenance schedule.
const ASSETS = [
  { name: 'Commercial treadmill',        category: 'cardio',       qty: 6, cost: 3.6, months: 26, service: 120, condition: 'good',  location: 'Cardio floor' },
  { name: 'Upright exercise bike',       category: 'cardio',       qty: 4, cost: 1.4, months: 26, service: 180, condition: 'good',  location: 'Cardio floor' },
  { name: 'Rowing machine',              category: 'cardio',       qty: 3, cost: 1.7, months: 20, service: 180, condition: 'good',  location: 'Cardio floor' },
  { name: 'Cross trainer',               category: 'cardio',       qty: 3, cost: 2.1, months: 32, service: 150, condition: 'fair',  location: 'Cardio floor' },
  { name: 'Power rack',                  category: 'strength',     qty: 4, cost: 2.4, months: 30, service: 365, condition: 'good',  location: 'Strength area' },
  { name: 'Cable crossover machine',     category: 'strength',     qty: 2, cost: 3.1, months: 30, service: 180, condition: 'good',  location: 'Strength area' },
  { name: 'Leg press machine',           category: 'strength',     qty: 2, cost: 2.8, months: 34, service: 240, condition: 'fair',  location: 'Strength area' },
  { name: 'Lat pulldown machine',        category: 'strength',     qty: 2, cost: 1.9, months: 34, service: 240, condition: 'good',  location: 'Strength area' },
  { name: 'Smith machine',               category: 'strength',     qty: 1, cost: 2.6, months: 18, service: 240, condition: 'new',   location: 'Strength area' },
  { name: 'Dumbbell set 2.5–50 kg',      category: 'free_weights', qty: 1, cost: 5.2, months: 36, service: 0,   condition: 'good',  location: 'Free weights' },
  { name: 'Olympic barbell',             category: 'free_weights', qty: 8, cost: 0.5, months: 36, service: 0,   condition: 'good',  location: 'Free weights' },
  { name: 'Bumper plate set',            category: 'free_weights', qty: 4, cost: 1.1, months: 36, service: 0,   condition: 'good',  location: 'Free weights' },
  { name: 'Adjustable bench',            category: 'free_weights', qty: 6, cost: 0.6, months: 28, service: 0,   condition: 'fair',  location: 'Free weights' },
  { name: 'Kettlebell set',              category: 'functional',   qty: 1, cost: 1.3, months: 22, service: 0,   condition: 'good',  location: 'Functional zone' },
  { name: 'Battle ropes & sled',         category: 'functional',   qty: 1, cost: 0.9, months: 22, service: 0,   condition: 'good',  location: 'Functional zone' },
  { name: 'Yoga mats & blocks',          category: 'studio',       qty: 1, cost: 0.4, months: 14, service: 0,   condition: 'good',  location: 'Studio 1' },
  { name: 'Studio sound system',         category: 'studio',       qty: 1, cost: 1.6, months: 24, service: 365, condition: 'good',  location: 'Studio 1' },
  { name: 'Air conditioning unit',       category: 'facility',     qty: 4, cost: 1.8, months: 40, service: 90,  condition: 'fair',  location: 'Throughout' },
  { name: 'Locker bank (20 door)',       category: 'facility',     qty: 3, cost: 1.2, months: 40, service: 0,   condition: 'good',  location: 'Changing rooms' },
  { name: 'Wall mirrors, installed',     category: 'facility',     qty: 1, cost: 1.4, months: 40, service: 0,   condition: 'good',  location: 'Throughout' },
  { name: 'Water cooler',                category: 'facility',     qty: 2, cost: 0.3, months: 16, service: 180, condition: 'good',  location: 'Main floor' },
  { name: 'Reception desk & seating',    category: 'furniture',    qty: 1, cost: 1.1, months: 40, service: 0,   condition: 'good',  location: 'Reception' },
  { name: 'Fingerprint reader & desk PC', category: 'technology',  qty: 2, cost: 0.7, months: 8,  service: 365, condition: 'new',   location: 'Reception' },
  { name: 'CCTV system (8 camera)',      category: 'technology',   qty: 1, cost: 0.9, months: 30, service: 365, condition: 'good',  location: 'Throughout' },
  { name: 'Wall-mounted TV screens',     category: 'technology',   qty: 4, cost: 0.4, months: 30, service: 0,   condition: 'fair',  location: 'Cardio floor' },
  { name: 'Spin bike (retired)',         category: 'cardio',       qty: 2, cost: 1.2, months: 58, service: 0,   condition: 'unusable', location: 'Storage', status: 'retired' }
];

async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set. Add it to .env first.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected to ${mongoose.connection.name}`);
}

// The currency the gym's money is actually in, preferring what the sales say
// over what the settings claim -- the two can disagree, and the sales are the
// half with real transactions behind them.
async function workingCurrency() {
  const byCurrency = await PackageOrder.aggregate([
    { $match: { 'payment.status': 'paid' } },
    { $group: { _id: '$payment.currency', total: { $sum: '$payment.amount' } } },
    { $sort: { total: -1 } }
  ]);

  if (byCurrency.length && byCurrency[0]._id) {
    const fromSales = String(byCurrency[0]._id).toUpperCase();
    const settings = await Settings.findOne().select('currency').lean();
    const configured = settings && settings.currency ? String(settings.currency).toUpperCase() : null;

    if (configured && configured !== fromSales) {
      console.log(
        `  note: sales are in ${fromSales} but Settings says ${configured}. ` +
          `Seeding costs in ${fromSales} so the P&L can be subtracted; fix the setting to make it official.`
      );
    }
    return fromSales;
  }

  return await L.baseCurrency();
}

// A monthly figure that makes the seeded gym roughly break even, so the reports
// show a business rather than a bonfire. Derived from real revenue where there
// is some.
async function monthlyScale(currency) {
  const [row] = await PackageOrder.aggregate([
    { $match: { 'payment.status': 'paid', 'payment.currency': currency.toLowerCase() } },
    { $group: { _id: null, total: { $sum: '$payment.amount' }, n: { $sum: 1 } } }
  ]);

  // Rent is the unit everything else is a share of, at ~45% of monthly revenue.
  const monthlyRevenue = row && row.total ? row.total : 1000;
  return Math.max(50, Math.round(monthlyRevenue * 0.45));
}

async function nextReferenceFactory() {
  const counters = new Map();

  return async function next(date) {
    const prefix = `EXP-${T.dateKey(date).slice(0, 7).replace('-', '')}-`;
    if (!counters.has(prefix)) {
      const last = await Expense.findOne({ reference: new RegExp('^' + prefix) })
        .sort({ reference: -1 })
        .select('reference')
        .lean();
      const parsed = last ? parseInt(String(last.reference).slice(prefix.length), 10) : 0;
      counters.set(prefix, Number.isNaN(parsed) ? 0 : parsed);
    }
    const sequence = counters.get(prefix) + 1;
    counters.set(prefix, sequence);
    return prefix + String(sequence).padStart(4, '0');
  };
}

async function seedExpenses(currency, months) {
  const scale = await monthlyScale(currency);
  const nextReference = await nextReferenceFactory();
  const today = T.dateKey();
  const rows = [];

  const staff = await User.find({ 'employment.isStaff': true, isActive: true })
    .select('firstName lastName employment.payroll')
    .lean();

  for (let back = months - 1; back >= 0; back--) {
    const [year, month] = today.slice(0, 7).split('-').map(Number);
    let y = year;
    let m = month - back;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    const monthKey = `${y}-${String(m).padStart(2, '0')}`;
    const isCurrentMonth = monthKey === today.slice(0, 7);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();

    const dayFor = (preferred) => {
      const day = Math.min(preferred, lastDay);
      const key = `${monthKey}-${String(day).padStart(2, '0')}`;
      // Never file a cost in the future.
      return key > today ? today : key;
    };

    for (const template of MONTHLY) {
      const dateKey = dayFor(randomInt(1, 8));
      if (dateKey > today) continue;

      // The current month's bills may not be settled yet -- which is what the
      // "pending" half of the expenses screen is for.
      const pending = isCurrentMonth && random() < 0.4;

      rows.push({
        reference: await nextReference(L.localInstant(dateKey, 12, 0)),
        title: template.title,
        category: template.category,
        amount: vary(scale * template.share, 0.08),
        currency,
        incurredOn: L.localInstant(dateKey, 12, 0),
        paidOn: pending ? null : L.localInstant(dateKey, 12, 0),
        status: pending ? 'pending' : 'paid',
        paymentMethod: template.method,
        vendor: template.vendor,
        recurring: { isRecurring: true, cycle: 'monthly' },
        notes: SEED_NOTE
      });
    }

    for (const template of OCCASIONAL) {
      if (random() > template.chance) continue;
      const dateKey = dayFor(randomInt(3, 27));
      if (dateKey > today) continue;

      rows.push({
        reference: await nextReference(L.localInstant(dateKey, 12, 0)),
        title: template.title,
        category: template.category,
        amount: vary(scale * template.share, 0.25),
        currency,
        incurredOn: L.localInstant(dateKey, 12, 0),
        paidOn: L.localInstant(dateKey, 12, 0),
        status: 'paid',
        paymentMethod: template.method,
        vendor: template.vendor,
        recurring: { isRecurring: false, cycle: 'monthly' },
        notes: SEED_NOTE
      });
    }

    // Wages, per person, from their own rate -- so the salaries line agrees
    // with what the Staff tab says they are paid.
    for (const person of staff) {
      const payroll = (person.employment && person.employment.payroll) || {};
      if ((payroll.basis || 'salaried') !== 'salaried' || !payroll.salary) continue;

      const dateKey = dayFor(lastDay);
      if (dateKey > today) continue;

      const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
      const pending = isCurrentMonth;

      rows.push({
        reference: await nextReference(L.localInstant(dateKey, 12, 0)),
        title: `Salary — ${name}`,
        category: 'salaries',
        amount: Number(payroll.salary),
        currency: String(payroll.currency || currency).toUpperCase(),
        incurredOn: L.localInstant(dateKey, 12, 0),
        paidOn: pending ? null : L.localInstant(dateKey, 12, 0),
        status: pending ? 'pending' : 'paid',
        paymentMethod: 'bank_transfer',
        vendor: name,
        staffId: person._id,
        staffName: name,
        recurring: { isRecurring: true, cycle: 'monthly' },
        notes: SEED_NOTE
      });
    }
  }

  if (!rows.length) {
    console.log('Expenses: nothing to insert');
    return;
  }

  await Expense.insertMany(rows);
  console.log(
    `Expenses: ${rows.length} rows over ${months} months ` +
      `(${rows.filter((r) => r.status === 'pending').length} still unpaid)`
  );
}

async function seedAssets(currency) {
  const scale = await monthlyScale(currency);
  // One "cost unit" in the table above is a fifth of a month's rent, which
  // keeps equipment prices in a believable ratio to the running costs.
  const unit = Math.max(40, Math.round(scale / 5));

  const last = await Asset.findOne({ tag: /^AST-/ }).sort({ tag: -1 }).select('tag').lean();
  let sequence = last ? (parseInt(String(last.tag).slice(4), 10) || 0) + 1 : 1;

  const today = new Date();
  const rows = [];

  for (const template of ASSETS) {
    const purchasedOn = new Date(today.getTime() - template.months * 30.44 * L.DAY_MS);
    const lastServicedOn = template.service
      ? new Date(today.getTime() - randomInt(10, Math.round(template.service * 1.3)) * L.DAY_MS)
      : null;

    rows.push({
      tag: 'AST-' + String(sequence++).padStart(4, '0'),
      name: template.name,
      category: template.category,
      quantity: template.qty,
      unitCost: vary(unit * template.cost, 0.06),
      currency,
      purchasedOn,
      supplier: 'Fitness Equipment Co',
      condition: template.condition,
      status: template.status || 'active',
      location: template.location,
      usefulLifeYears: Asset.DEFAULT_LIFE_YEARS[template.category] || 5,
      salvageValue: 0,
      serviceIntervalDays: template.service,
      lastServicedOn,
      // Deliberately leaves a few overdue: an asset register where nothing is
      // ever due tells you nothing about whether the screen works.
      nextServiceDue: lastServicedOn ? new Date(lastServicedOn.getTime() + template.service * L.DAY_MS) : null,
      warrantyUntil: new Date(purchasedOn.getTime() + 730 * L.DAY_MS),
      notes: SEED_NOTE
    });
  }

  await Asset.insertMany(rows);

  const overdue = rows.filter((row) => row.nextServiceDue && row.nextServiceDue < today).length;
  console.log(`Assets: ${rows.length} items (${overdue} overdue a service)`);
}

async function reset() {
  const expenses = await Expense.deleteMany({ notes: SEED_NOTE });
  const assets = await Asset.deleteMany({ notes: SEED_NOTE });
  console.log(`Removed ${expenses.deletedCount} expenses and ${assets.deletedCount} assets.`);
}

async function main() {
  const args = process.argv.slice(2);
  await connect();

  if (args.includes('--reset')) {
    await reset();
    await mongoose.connection.close();
    return;
  }

  const monthsArg = args.indexOf('--months');
  const months = monthsArg >= 0 ? Math.max(1, Math.min(36, parseInt(args[monthsArg + 1], 10) || 12)) : 12;

  // Re-running refreshes rather than stacking a second year on the first.
  await reset();

  const currency = await workingCurrency();
  console.log(`Working currency: ${currency}`);

  await seedExpenses(currency, months);
  await seedAssets(currency);

  console.log('\nDone. Undo with: node Seeder/createAccounts.js --reset');
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
