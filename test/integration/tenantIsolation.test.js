// Tenant isolation against a real MongoDB: one model proxy, used inside
// runWithTenant for gym A and for gym B, writes to two different databases;
// many interleaved contexts in flight at once never cross; per-gym caches stay
// per gym; platform models always reach the platform database.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let alpha;
let bravo;
let ctx;
let User;
let Lead;
let L;
let bookingRules;
let Settings;
let MemberDirectory;

const test = h.suite(async () => {
  ctx = h.src('platform/tenantContext');
  User = h.src('models/user');
  Lead = h.src('models/leadModel');
  Settings = h.src('models/settings');
  L = h.src('accounts/services/ledger');
  bookingRules = h.src('gymfolio/services/bookingRules');
  MemberDirectory = h.src('platform/models/memberDirectoryModel');

  alpha = await h.createGym('alpha', { timezone: 'Europe/London', currency: 'GBP', settings: { booking: { cutoffMinutes: 45 } } });
  bravo = await h.createGym('bravo', { timezone: 'Asia/Karachi', currency: 'PKR' });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the same model writes to each gym\'s own database', async () => {
  const a = await h.inGym(alpha, () => User.create({ firstName: 'Alice', lastName: 'Alpha', email: 'alice@alpha.test' }));
  const b = await h.inGym(bravo, () => User.create({ firstName: 'Bob', lastName: 'Bravo', email: 'bob@bravo.test' }));

  assert.deepEqual(await h.inGym(alpha, () => User.find().distinct('email')), ['alice@alpha.test']);
  assert.deepEqual(await h.inGym(bravo, () => User.find().distinct('email')), ['bob@bravo.test']);
  assert.equal(await h.inGym(alpha, () => User.findById(b._id)), null, 'gym A cannot read gym B\'s user by id');

  // Straight from the driver: two databases, one user each, none in the platform database.
  assert.equal(await h.rawDb(alpha.database.name).collection('users').countDocuments(), 1);
  assert.equal(await h.rawDb(bravo.database.name).collection('users').countDocuments(), 1);
  assert.equal(await h.rawDb(h.PLATFORM_DB).collection('users').countDocuments(), 0);
  assert.equal(String((await h.rawDb(alpha.database.name).collection('users').findOne())._id), String(a._id));
});

test('platform models reach the platform database from inside a gym', async () => {
  // Saving a user publishes their username to the platform directory.
  const rows = await MemberDirectory.find({}).lean();
  const bySlug = Object.fromEntries(rows.map((row) => [row.gymSlug, String(row.gymId)]));
  assert.equal(bySlug.alpha, String(alpha._id));
  assert.equal(bySlug.bravo, String(bravo._id));
  assert.equal(await h.rawDb(h.PLATFORM_DB).collection('platform_member_logins').countDocuments(), 2);
  assert.equal(await h.rawDb(alpha.database.name).collection('platform_member_logins').countDocuments(), 0);
});

test('forty interleaved contexts in flight at once never cross', async () => {
  const work = [];
  for (let i = 0; i < 40; i++) {
    const gym = i % 2 ? bravo : alpha;
    work.push(
      h.inGym(gym, async () => {
        // Yield between every step so the contexts genuinely interleave.
        await sleep(Math.floor(Math.random() * 10));
        assert.equal(ctx.currentTenantSlug(), gym.slug);
        const lead = await Lead.create({ firstName: `lead-${gym.slug}-${i}`, email: `lead${i}@${gym.slug}.test` });
        await sleep(Math.floor(Math.random() * 10));
        assert.equal(ctx.currentTenantSlug(), gym.slug);
        const back = await Lead.findById(lead._id).lean();
        assert.ok(back, `lead ${i} readable in its own gym`);
        return ctx.currentTenantSlug();
      })
    );
  }
  const slugs = await Promise.all(work);
  assert.deepEqual(slugs, Array.from({ length: 40 }, (_, i) => (i % 2 ? 'bravo' : 'alpha')));

  const names = async (gym) => (await h.rawDb(gym.database.name).collection(Lead.collection.collectionName).find().toArray()).map((row) => row.firstName);
  const inAlpha = await h.inGym(alpha, () => names(alpha));
  const inBravo = await h.inGym(bravo, () => names(bravo));
  assert.equal(inAlpha.length, 20);
  assert.equal(inBravo.length, 20);
  assert.ok(inAlpha.every((name) => name.startsWith('lead-alpha-')));
  assert.ok(inBravo.every((name) => name.startsWith('lead-bravo-')));
});

test('per-gym caches and settings stay per gym under concurrency', async () => {
  const read = (gym) =>
    h.inGym(gym, async () => {
      await sleep(Math.floor(Math.random() * 5));
      const [currency, rules, settings] = await Promise.all([L.baseCurrency(), bookingRules.bookingRules(), Settings.getSettings()]);
      return { slug: ctx.currentTenantSlug(), currency, cutoff: rules.cutoffMinutes, siteName: settings.siteName, tz: ctx.tenantTimezone() };
    });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => read(i % 2 ? bravo : alpha)));
  for (const r of results) {
    if (r.slug === 'alpha') assert.deepEqual(r, { slug: 'alpha', currency: 'GBP', cutoff: 45, siteName: alpha.name, tz: 'Europe/London' });
    else assert.deepEqual(r, { slug: 'bravo', currency: 'PKR', cutoff: 15, siteName: bravo.name, tz: 'Asia/Karachi' });
  }
});

test('a nested context wins inside and is gone again afterwards', async () => {
  await h.inGym(alpha, async () => {
    const inner = await h.inGym(bravo, async () => {
      await sleep(1);
      return { slug: ctx.currentTenantSlug(), users: await User.find().distinct('email') };
    });
    assert.deepEqual(inner, { slug: 'bravo', users: ['bob@bravo.test'] });
    assert.equal(ctx.currentTenantSlug(), 'alpha');
    assert.deepEqual(await User.find().distinct('email'), ['alice@alpha.test']);
  });
});

test('outside any context a tenant model refuses to run rather than guess', async () => {
  assert.equal(ctx.currentTenant(), null);
  assert.throws(() => User.find(), /outside a tenant context/);
  // Work started inside a context keeps it after the caller has moved on.
  let later;
  await h.inGym(bravo, async () => {
    later = sleep(20).then(() => User.countDocuments());
  });
  assert.equal(await later, 1);
});
