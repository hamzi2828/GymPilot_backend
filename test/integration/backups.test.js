// Settings → Data & backup against a real MongoDB: the owner's download is
// the whole gym and nothing but the gym, with every secret still sealed.

const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('stream');
const h = require('./helpers/harness');

let gym;
let other;
let owner;
let User;
let Settings;
let backups;
let controller;
let secretBox;

const test = h.suite(async () => {
  User = h.src('models/user');
  Settings = h.src('models/settings');
  backups = h.src('services/backupService');
  controller = h.src('controller/backupController');
  secretBox = h.src('services/secretBox');

  gym = await h.createGym('backup-gym', { settings: { stripe: { secretKey: 'sk_test_backup_gym_secret', enabled: true } } });
  other = await h.createGym('other-gym');

  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    owner = await User.create({ firstName: 'Olive', lastName: 'Owner', email: 'olive@backup.test', role: 'admin' });
    await User.create({ firstName: 'Mo', lastName: 'Member', email: 'mo@backup.test', role: 'user' });
  });
  await h.inGym(other, async () => {
    await User.create({ firstName: 'Stranger', lastName: 'Danger', email: 'stranger@other.test', role: 'user' });
  });

  // What the first gym's database also holds when it is the platform's own:
  // the list of gyms and the super admins. Written straight to the database.
  const raw = h.rawDb(gym.database.name);
  await raw.collection('gyms').insertOne({ slug: 'someone-else', database: { uri: 'mongodb://secret' } });
  await raw.collection('super_admins').insertOne({ email: 'root@platform.test', passwordHash: 'x' });
  await raw.collection('platform_plans').insertOne({ slug: 'starter' });
  // A Stripe webhook secret saved before sealing existed: plaintext at rest.
  await raw.collection('settings').updateOne({}, { $set: { 'stripe.webhookSecret': 'whsec_plaintext_from_2025' } });
});

/** A response that is a stream, as Express's is, collecting what is written. */
function streamRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.statusCode = 200;
  res.headers = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
  };
  res.json = (body) => {
    res.body = body;
    res.end();
    return res;
  };
  res.bytes = () => Buffer.concat(chunks);
  return res;
}

async function download(asGym) {
  return h.inGym(asGym, async () => {
    const res = streamRes();
    await controller.download({ method: 'POST', originalUrl: '/api/backups/download', user: { id: String(owner._id), email: owner.email }, roleSlug: 'admin' }, res);
    return res;
  });
}

async function read(bytes) {
  const events = [];
  for await (const event of backups.readArchive(Readable.from([bytes]))) events.push(event);
  return events;
}

test('the owner downloads the whole gym as one archive, named for the gym', async () => {
  const res = await download(gym);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/gzip');
  assert.match(res.headers['content-disposition'], /^attachment; filename="backup-gym-backup-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz"$/);
  assert.equal(res.headers['cache-control'], 'no-store');

  const events = await read(res.bytes());
  const header = events[0].header;
  assert.equal(header.gym.id, String(gym._id));
  assert.equal(header.gym.slug, 'backup-gym');
  assert.equal(header.trigger, 'download');

  const names = events.filter((e) => e.type === 'collection').map((e) => e.collection.name);
  assert.ok(names.includes('users'), names.join());
  assert.ok(names.includes('settings'), names.join());

  const users = events.filter((e) => e.type === 'documents' && e.name === 'users').flatMap((e) => e.documents);
  assert.deepEqual(users.map((u) => u.email).sort(), ['mo@backup.test', 'olive@backup.test']);

  // Indexes travel with their collection.
  const userIndexes = events.find((e) => e.type === 'collection' && e.collection.name === 'users').collection.indexes;
  assert.ok(userIndexes.some((i) => i.name !== '_id_'), JSON.stringify(userIndexes));

  const manifest = events[events.length - 1].manifest;
  assert.equal(manifest.documents, events.filter((e) => e.type === 'documents').reduce((n, e) => n + e.documents.length, 0));
});

test('nothing of the platform or of another gym is in it', async () => {
  const events = await read((await download(gym)).bytes());
  const names = events.filter((e) => e.type === 'collection').map((e) => e.collection.name);
  for (const name of ['gyms', 'super_admins', 'platform_plans']) assert.ok(!names.includes(name), `${name} leaked into the backup`);
  const everything = JSON.stringify(events.filter((e) => e.type === 'documents').flatMap((e) => e.documents));
  assert.ok(!everything.includes('stranger@other.test'));
  assert.ok(!everything.includes('mongodb://secret'));
});

test('secrets stay sealed: stored ones as they are, a plaintext leftover sealed on the way out', async () => {
  const events = await read((await download(gym)).bytes());
  const [settings] = events.find((e) => e.type === 'documents' && e.name === 'settings').documents;
  assert.ok(secretBox.isSealed(settings.stripe.secretKey), settings.stripe.secretKey);
  assert.ok(secretBox.isSealed(settings.stripe.webhookSecret), settings.stripe.webhookSecret);
  const text = JSON.stringify(settings);
  assert.ok(!text.includes('sk_test_backup_gym_secret'));
  assert.ok(!text.includes('whsec_plaintext_from_2025'));
  // …and this gym's key still opens both.
  await h.inGym(gym, async () => {
    assert.equal(secretBox.open(settings.stripe.secretKey), 'sk_test_backup_gym_secret');
    assert.equal(secretBox.open(settings.stripe.webhookSecret), 'whsec_plaintext_from_2025');
  });
  // The database itself is untouched by the download.
  const stored = await h.rawDb(gym.database.name).collection('settings').findOne({});
  assert.equal(stored.stripe.webhookSecret, 'whsec_plaintext_from_2025');
});

test('each gym downloads its own data only', async () => {
  const events = await read((await download(other)).bytes());
  assert.equal(events[0].header.gym.slug, 'other-gym');
  const users = events.filter((e) => e.type === 'documents' && e.name === 'users').flatMap((e) => e.documents);
  assert.deepEqual(users.map((u) => u.email), ['stranger@other.test']);
});
