// Settings → Data & backup against a real MongoDB: the owner's download is
// the whole gym and nothing but the gym, with every secret still sealed;
// stored backups are encrypted, kept for as long as they should be, and made
// once a day for every gym -- or not at all, with the reason, when the server
// has nowhere to keep them or no key to lock them with.
//
// The Blob store is replaced by a map in memory (useMemoryStore below).

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
let storage;
let PlatformBackup;

// The Blob store, in memory: public-looking URLs, bytes kept as given.
const blobs = new Map();
// Stands in for the store's random suffix: never reused, even after deletes
// (blobs.size was, so a backup made in the same second as a deleted one got
// its URL).
let blobSerial = 0;
let storeOn = true;
function useMemoryStore() {
  storage.configured = () => storeOn;
  storage.save = async (pathname, body) => {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const url = `https://teststore.public.blob.vercel-storage.com/${pathname.replace(/\.gpbackup$/, '')}-${(blobSerial += 1)}.gpbackup`;
    blobs.set(url, Buffer.concat(chunks));
    return { url, pathname };
  };
  storage.open = async (url) => {
    if (!blobs.has(url)) {
      const error = new Error('This backup is no longer in storage.');
      error.status = 404;
      throw error;
    }
    return Readable.from([blobs.get(url)]);
  };
  storage.remove = async (urls) => {
    for (const url of [].concat(urls)) blobs.delete(url);
  };
}

const test = h.suite(async () => {
  User = h.src('models/user');
  Settings = h.src('models/settings');
  backups = h.src('services/backupService');
  controller = h.src('controller/backupController');
  secretBox = h.src('services/secretBox');
  storage = h.src('services/backupStorage');
  PlatformBackup = h.src('platform/models/platformBackupModel');
  useMemoryStore();

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

test('the counters are read last, after everything numbered from them', async () => {
  // The gym keeps running while its collections are read one by one. Read
  // before the sales and orders, a counter could miss a number handed out
  // meanwhile -- and after a restore, the next receipt or invoice would
  // repeat it. Read last, it can only be ahead of them (a gap, never a repeat).
  await h.inGym(gym, () => h.src('gymfolio/models/counterModel').next('invoice'));
  const events = await read((await download(gym)).bytes());
  const names = events.filter((e) => e.type === 'collection').map((e) => e.collection.name);
  assert.ok(names.includes('users'), names.join());
  assert.equal(names[names.length - 1], 'gym_counters', names.join());
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

/* ------------------------------ stored backups ------------------------------ */

const ownerReq = (extra = {}) => ({
  method: 'POST',
  originalUrl: '/api/backups',
  user: { id: String(owner._id), email: 'olive@backup.test' },
  roleSlug: 'admin',
  params: {},
  query: {},
  body: {},
  headers: {},
  ...extra
});
const cron = (query = {}, secret = 'backup-cron-secret') =>
  h.call(controller.runDaily, { headers: secret ? { authorization: `Bearer ${secret}` } : {}, query });

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('without a store or a key nothing is stored, and the owner and the cron are told why', async () => {
  setEnv({ BACKUP_ENCRYPTION_KEY: undefined, CRON_SECRET: 'backup-cron-secret' });
  storeOn = false;
  await h.inGym(gym, async () => {
    const list = await h.call(controller.list, ownerReq({ method: 'GET' }));
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.data.ready, false);
    assert.match(list.body.data.reason, /BLOB_READ_WRITE_TOKEN/);
    const run = await h.call(controller.run, ownerReq());
    assert.equal(run.statusCode, 409);
    assert.equal(run.body.code, 'BACKUPS_NOT_CONFIGURED');
  });
  const skipped = await cron();
  assert.equal(skipped.statusCode, 200);
  assert.match(skipped.body.skipped, /BLOB_READ_WRITE_TOKEN/);

  storeOn = true;
  await h.inGym(gym, async () => {
    const list = await h.call(controller.list, ownerReq({ method: 'GET' }));
    assert.equal(list.body.data.ready, false);
    assert.match(list.body.data.reason, /BACKUP_ENCRYPTION_KEY/);
  });
  assert.match((await cron()).body.skipped, /BACKUP_ENCRYPTION_KEY/);
  assert.equal(blobs.size, 0);
  assert.equal(await PlatformBackup.countDocuments({}), 0);
});

test('"Back up now" stores an encrypted backup, listed with its date, size and contents', async () => {
  setEnv({ BACKUP_ENCRYPTION_KEY: 'integration-backup-key' });
  await h.inGym(gym, async () => {
    const run = await h.call(controller.run, ownerReq());
    assert.equal(run.statusCode, 201, JSON.stringify(run.body));
    const list = await h.call(controller.list, ownerReq({ method: 'GET' }));
    assert.equal(list.body.data.ready, true);
    assert.equal(list.body.data.keep, 7);
    const [entry] = list.body.data.backups;
    assert.equal(entry.kind, 'manual');
    assert.ok(entry.size > 0);
    assert.ok(entry.documents >= 3);
    assert.equal(entry.createdBy, 'olive@backup.test');

    // What the store holds is not readable: no member's address in it.
    const row = await PlatformBackup.findById(entry.id).lean();
    const stored = blobs.get(row.url);
    assert.equal(stored.length, entry.size);
    assert.equal(stored.subarray(0, 8).toString(), 'GPBKENC1');
    assert.ok(!stored.includes(Buffer.from('olive@backup.test')));
    assert.match(row.pathname, /^backup-gym\/backups\/manual\//);
  });
});

test('a stored backup downloads as the same archive the owner would download now', async () => {
  await h.inGym(gym, async () => {
    const [entry] = (await h.call(controller.list, ownerReq({ method: 'GET' }))).body.data.backups;
    const res = streamRes();
    await controller.downloadStored(ownerReq({ params: { id: entry.id } }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.headers['content-disposition'], /backup-gym-backup-.*\.tar\.gz/);
    const events = await read(res.bytes());
    assert.equal(events[0].header.gym.slug, 'backup-gym');
    assert.equal(events[0].header.trigger, 'manual');
    const users = events.filter((e) => e.type === 'documents' && e.name === 'users').flatMap((e) => e.documents);
    assert.ok(users.some((u) => u.email === 'olive@backup.test'));
  });
});

test('a stored backup that cannot be opened is refused before the download starts', async () => {
  await h.inGym(gym, async () => {
    const [entry] = (await h.call(controller.list, ownerReq({ method: 'GET' }))).body.data.backups;
    setEnv({ BACKUP_ENCRYPTION_KEY: 'a-different-key' });
    try {
      const res = streamRes();
      await controller.downloadStored(ownerReq({ params: { id: entry.id } }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'BACKUP_WRONG_KEY');
      assert.equal(res.headers['content-disposition'], undefined);
    } finally {
      setEnv({ BACKUP_ENCRYPTION_KEY: 'integration-backup-key' });
    }
  });
});

test('one gym cannot reach another gym\'s stored backup', async () => {
  const id = (await PlatformBackup.findOne({ gymSlug: 'backup-gym' }).lean())._id;
  await h.inGym(other, async () => {
    const res = streamRes();
    await controller.downloadStored(ownerReq({ params: { id: String(id) } }), res);
    assert.equal(res.statusCode, 404);
    const list = await h.call(controller.list, ownerReq({ method: 'GET' }));
    assert.deepEqual(list.body.data.backups, []);
  });
});

test('the daily job needs CRON_SECRET', async () => {
  assert.equal((await cron({}, 'wrong-secret')).statusCode, 401);
  assert.equal((await cron({}, null)).statusCode, 401);
  setEnv({ CRON_SECRET: undefined });
  try {
    assert.equal((await cron()).statusCode, 503);
  } finally {
    setEnv({ CRON_SECRET: 'backup-cron-secret' });
  }
});

test('the daily job backs up every active gym once a day and keeps the newest BACKUP_KEEP_DAILY', async () => {
  setEnv({ BACKUP_KEEP_DAILY: '2' });
  try {
    const dry = await cron({ dryRun: '1' });
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
    assert.deepEqual(dry.body.gyms['backup-gym'], { would: 'back up' });
    assert.equal(await PlatformBackup.countDocuments({ kind: 'daily' }), 0);

    const first = await cron();
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.ok(first.body.gyms['backup-gym'].backup, JSON.stringify(first.body.gyms));
    assert.ok(first.body.gyms['other-gym'].backup, JSON.stringify(first.body.gyms));
    assert.equal(first.body.schedule.processed, 2);

    // Called again the same day: nothing new.
    const again = await cron();
    assert.match(again.body.gyms['backup-gym'].skipped, /last 20 hours/);
    assert.equal(await PlatformBackup.countDocuments({ kind: 'daily', gymSlug: 'backup-gym' }), 1);

    // Three more days: two daily backups are kept, the older files are gone.
    const raw = h.rawDb(h.PLATFORM_DB).collection('platform_backups');
    for (let day = 1; day <= 3; day += 1) {
      await raw.updateMany({ kind: 'daily' }, [{ $set: { createdAt: { $subtract: ['$createdAt', 21 * 3600 * 1000] } } }]);
      const res = await cron();
      assert.ok(res.body.gyms['backup-gym'].backup, JSON.stringify(res.body.gyms));
    }
    const kept = await PlatformBackup.find({ kind: 'daily', gymSlug: 'backup-gym' }).lean();
    assert.equal(kept.length, 2);
    const everyUrl = (await PlatformBackup.find({}).lean()).map((row) => row.url).sort();
    assert.deepEqual([...blobs.keys()].sort(), everyUrl, 'every stored file is listed, and every listed file is stored');
    // The manual backup is kept under its own count.
    assert.equal(await PlatformBackup.countDocuments({ kind: 'manual', gymSlug: 'backup-gym' }), 1);

    // ?gym= runs that one gym only.
    await raw.updateMany({ kind: 'daily' }, [{ $set: { createdAt: { $subtract: ['$createdAt', 21 * 3600 * 1000] } } }]);
    const one = await cron({ gym: 'other-gym' });
    assert.deepEqual(Object.keys(one.body.gyms), ['other-gym']);
    assert.equal((await cron({ gym: 'no-such-gym' })).statusCode, 404);
  } finally {
    setEnv({ BACKUP_KEEP_DAILY: undefined });
  }
});
