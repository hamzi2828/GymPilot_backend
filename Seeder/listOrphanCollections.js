require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;

const ACTIVE_MODELS = [
  'ActivityLog','AffiliateCommission','Attendance','Author','Bank','Blog','BlogCategory',
  'BlogComment','BlogHero','Cart','Category','Color','Contact','Country','CustomOrder',
  'Customer','Discount','Employee','Expense','Fabric','Guideline','GymClass','HeroSlide',
  'Kind','Measurement','Newsletter','Order','POSOrder','Package','PackageOrder',
  'PackageRegistration','Page','Payment','Preorder','Product','Purchase','ReturnOrder',
  'Review','Salary','Settings','Shipping','ShippingOption','Size','SizeGuide','Style',
  'Trainer','User','Vendor','Wishlist'
];

function pluralize(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies';
  if (lower.endsWith('s')) return lower + 'es';
  return lower + 's';
}

const ACTIVE_COLLECTIONS = new Set(ACTIVE_MODELS.map(pluralize));

(async () => {
  await mongoose.connect(MONGO_URI);
  const adminDb = mongoose.connection.db.admin();
  const { databases } = await adminDb.listDatabases();
  console.log('=== Databases on cluster ===');
  for (const d of databases) console.log(`  ${d.name.padEnd(30)} ${(d.sizeOnDisk/1024/1024).toFixed(2)} MB`);
  console.log('');

  const db = mongoose.connection.db;
  const cols = await db.listCollections().toArray();
  console.log(`=== InkedWear DB has ${cols.length} collections ===\n`);

  const orphans = [];
  const active = [];
  for (const c of cols) {
    if (c.name.startsWith('system.')) continue;
    if (ACTIVE_COLLECTIONS.has(c.name.toLowerCase())) {
      active.push(c.name);
    } else {
      orphans.push(c.name);
    }
  }

  console.log(`Active (used by app): ${active.length}`);
  console.log(`Orphan (not in current models): ${orphans.length}\n`);

  console.log('--- Orphan collections (with doc counts) ---');
  for (const name of orphans) {
    try {
      const count = await db.collection(name).countDocuments();
      console.log(`  ${name.padEnd(40)} ${count} docs`);
    } catch (e) {
      console.log(`  ${name.padEnd(40)} (err: ${e.message})`);
    }
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
