// Restoring a gym from a backup, against a real MongoDB: back up, change
// things, restore -- and the gym's data is exactly what was backed up, with
// the audit log kept and a backup of the changed gym taken first. A backup
// of another gym, a damaged file or a wrong confirmation changes nothing.
//
// Uploaded files are encrypted here the way the admin page's browser code
// encrypts them (WebCrypto, admin/settings/backupApi.ts), so the two ends of
// that format are checked against each other. The Blob store is a map.

const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('stream');
const { webcrypto } = require('crypto');
const mongoose = require('mongoose');
const h = require('./helpers/harness');

let gym;
let intruder;
let owner;
let User;
let Settings;
let AdminAuditLog;
let PlatformBackup;
let backups;
let controller;
let storage;
let EJSON;

const blobs = new Map();
const STORE = 'https://teststore.public.blob.vercel-storage.com';
function useMemoryStore() {
  storage.configured = () => true;
  storage.save = async (pathname, body) => {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const url = `${STORE}/${pathname.replace(/\.gpbackup$/, '')}-${blobs.size + 1}.gpbackup`;
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
  storage.uploadToken = async (pathname, maxBytes) => `test-token:${pathname}:${maxBytes}`;
}

const test = h.suite(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = 'integration-restore-key';
  User = h.src('models/user');
  Settings = h.src('models/settings');
  AdminAuditLog = h.src('models/adminAuditLogModel');
  PlatformBackup = h.src('platform/models/platformBackupModel');
  backups = h.src('services/backupService');
  controller = h.src('controller/backupController');
  storage = h.src('services/backupStorage');
  EJSON = mongoose.mongo.BSON.EJSON;
  useMemoryStore();

  gym = await h.createGym('restore-gym', { settings: { stripe: { secretKey: 'sk_test_restore_gym', enabled: true } } });
  intruder = await h.createGym('intruder-gym');

  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, AdminAuditLog);
    owner = await User.create({ firstName: 'Rita', lastName: 'Owner', email: 'rita@restore.test', role: 'admin' });
    for (let i = 0; i < 25; i += 1) await User.create({ firstName: `Member${i}`, lastName: 'Test', email: `m${i}@restore.test`, role: 'user' });
  });
  await h.inGym(intruder, async () => {
    await User.create({ firstName: 'Ivan', lastName: 'Intruder', email: 'ivan@intruder.test', role: 'user' });
  });
});

const as = (extra = {}) => ({
  method: 'POST',
  originalUrl: '/api/backups',
  user: { id: String(owner._id), email: 'rita@restore.test' },
  roleSlug: 'admin',
  params: {},
  query: {},
  body: {},
  headers: {},
  ...extra
});

// Every collection a restore replaces, as it is in the database right now.
// Empty ones are left out: mongoose creates a model's collection in the
// background whenever the model is first compiled on a connection, so when
// an empty one appears is not something a test can pin down. An account's
// tokenVersion is left out too: a restore moves every one on, on purpose,
// so that every session ends (see the sessions test below).
async function snapshot() {
  const db = h.rawDb(gym.database.name);
  const names = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((name) => backups.isGymCollection({ name, type: 'collection' }) && name !== 'gym_admin_audit_logs')
    .sort();
  const out = {};
  for (const name of names) {
    const docs = await db.collection(name).find({}, name === 'users' ? { projection: { tokenVersion: 0 } } : {}).sort({ _id: 1 }).toArray();
    if (!docs.length) continue;
    const indexes = (await db.collection(name).indexes()).map((i) => `${i.name}:${JSON.stringify(i.key)}:${!!i.unique}`).sort();
    out[name] = { docs: EJSON.stringify(docs, { relaxed: false }), indexes };
  }
  return out;
}

async function mutate() {
  await h.inGym(gym, async () => {
    await User.updateOne({ email: 'm1@restore.test' }, { $set: { firstName: 'Changed' } });
    await User.deleteOne({ email: 'm2@restore.test' });
    await User.create({ firstName: 'New', lastName: 'Since', email: 'new@restore.test', role: 'user' });
    await Settings.updateOne({}, { $set: { siteName: 'Renamed after the backup' } });
    await AdminAuditLog.create({ actorEmail: 'rita@restore.test', method: 'PUT', path: '/settings', tab: 'settings', status: 200 });
  });
  await h.rawDb(gym.database.name).collection('made_since').insertOne({ note: 'not in the backup' });
}

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

async function downloadNow(asGym) {
  return h.inGym(asGym, async () => {
    const res = streamRes();
    await controller.download(as(), res);
    assert.equal(res.statusCode, 200);
    return res.bytes();
  });
}

// What the admin page does with a file the owner picks: ask for a grant,
// encrypt with WebCrypto in the grant's format, put it where the grant says,
// then say it is there.
async function upload(plain) {
  const grant = await h.call(controller.grantUpload, as({ body: { size: plain.length } }));
  assert.equal(grant.statusCode, 201, JSON.stringify(grant.body));
  const { uploadId, pathname, header: headerB64, key: keyB64, chunkBytes } = grant.body.data;

  const header = Buffer.from(headerB64, 'base64');
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(keyB64, 'base64'), 'AES-GCM', false, ['encrypt']);
  const count = Math.max(1, Math.ceil(plain.length / chunkBytes));
  const parts = [header];
  for (let i = 0; i < count; i += 1) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(7, i);
    iv[11] = i === count - 1 ? 1 : 0;
    const piece = plain.subarray(i * chunkBytes, (i + 1) * chunkBytes);
    parts.push(Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, piece)));
  }
  const url = `${STORE}/${pathname}`;
  blobs.set(url, Buffer.concat(parts));

  const done = await h.call(controller.completeUpload, as({ params: { id: uploadId }, body: { url } }));
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  return uploadId;
}

const preview = (backupId) => h.call(controller.previewRestore, as({ body: { backupId } }));
const restore = (backupId, confirm) => h.call(controller.restore, as({ body: { backupId, confirm } }));

async function stagingLeft() {
  return (await h.rawDb(gym.database.name).listCollections().toArray()).map((c) => c.name).filter((name) => name.startsWith('__restoring__'));
}

test('back up, change things, restore: the data is exactly what was backed up', async () => {
  await h.inGym(gym, async () => {
    const before = await snapshot();
    const run = await h.call(controller.run, as());
    assert.equal(run.statusCode, 201, JSON.stringify(run.body));
    const backupId = run.body.data.id;

    await mutate();
    assert.notDeepEqual(await snapshot(), before);

    // The dry run: what is in it, from which gym, when.
    const dry = await preview(backupId);
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.data.gym.slug, 'restore-gym');
    assert.equal(dry.body.data.sameGym, true);
    assert.equal(dry.body.data.refusal, null);
    assert.equal(dry.body.data.actorInBackup, true);
    assert.equal(dry.body.data.confirmWith, 'restore-gym');
    assert.ok(Date.parse(dry.body.data.createdAt));
    const users = dry.body.data.collections.find((c) => c.name === 'users');
    assert.equal(users.documents, 26);
    assert.equal(users.kept, false);
    // Nothing was changed by looking.
    assert.equal(await User.countDocuments({ email: 'new@restore.test' }), 1);

    // The slug must be typed.
    const wrong = await restore(backupId, 'restore gym');
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.body.code, 'CONFIRMATION_MISMATCH');
    assert.equal(await User.countDocuments({ email: 'new@restore.test' }), 1);

    const done = await restore(backupId, 'Restore-Gym ');
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.data.dropped, ['made_since']);

    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await stagingLeft(), []);

    // Through the models too, secrets opening as they did.
    assert.equal(await User.countDocuments({ email: 'new@restore.test' }), 0);
    assert.equal((await User.findOne({ email: 'm1@restore.test' }).lean()).firstName, 'Member1');
    const settings = await Settings.getSettings();
    assert.equal(settings.siteName, 'Gym restore-gym');
    assert.equal(settings.stripe.secretKey, 'sk_test_restore_gym');

    // The audit log keeps what happened since the backup.
    assert.equal(await AdminAuditLog.countDocuments({ path: '/settings', method: 'PUT' }), 1);

    // A backup of the gym as it was just before, which has the member added since.
    const safety = await PlatformBackup.findById(done.body.data.safetyBackup).lean();
    assert.equal(safety.kind, 'pre-restore');
    const safetyDry = await preview(String(safety._id));
    assert.equal(safetyDry.body.data.collections.find((c) => c.name === 'users').documents, 26);
    assert.ok(safetyDry.body.data.collections.some((c) => c.name === 'made_since'));
  });
});

test('an uploaded copy of the owner\'s own download restores the same way, and the upload is removed', async () => {
  const before = await h.inGym(gym, () => snapshot());
  const archive = await downloadNow(gym);
  await mutate();
  await h.inGym(gym, async () => {
    const uploadId = await upload(archive);
    const row = await PlatformBackup.findById(uploadId).lean();
    assert.equal(row.kind, 'upload');
    // The store only ever held ciphertext.
    assert.ok(!blobs.get(row.url).includes(Buffer.from('rita@restore.test')));

    const dry = await preview(uploadId);
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.data.sameGym, true);

    const done = await restore(uploadId, 'restore-gym');
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.deepEqual(await snapshot(), before);
    assert.equal(await PlatformBackup.countDocuments({ _id: uploadId }), 0);
    assert.ok(!blobs.has(row.url));

    // Uploads are never in the list of backups.
    const list = await h.call(controller.list, as({ method: 'GET' }));
    assert.ok(list.body.data.backups.every((b) => b.kind !== 'upload'));
  });
});

test('a backup of another gym is described, then refused, and nothing is touched', async () => {
  const foreign = await downloadNow(intruder);
  await h.inGym(gym, async () => {
    const before = await snapshot();
    const safetiesBefore = await PlatformBackup.countDocuments({ gymId: gym._id, kind: 'pre-restore' });
    const uploadId = await upload(foreign);

    const dry = await preview(uploadId);
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.data.sameGym, false);
    assert.equal(dry.body.data.gym.slug, 'intruder-gym');
    assert.match(dry.body.data.refusal, /another gym/);

    const refused = await restore(uploadId, 'restore-gym');
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.code, 'BACKUP_OTHER_GYM');
    assert.deepEqual(await snapshot(), before);
    assert.equal(await PlatformBackup.countDocuments({ gymId: gym._id, kind: 'pre-restore' }), safetiesBefore);
  });

  // Another gym's stored backup cannot even be named.
  const theirs = await h.inGym(intruder, async () => (await h.call(controller.run, as())).body.data.id);
  await h.inGym(gym, async () => {
    assert.equal((await preview(theirs)).statusCode, 404);
    assert.equal((await restore(theirs, 'restore-gym')).statusCode, 404);
  });
});

test('a damaged file is refused and the gym is left exactly as it was', async () => {
  const archive = await downloadNow(gym);
  await h.inGym(gym, async () => {
    const before = await snapshot();
    // A download cut off part-way: the header reads, the rest does not.
    const zlib = require('zlib');
    const tar = zlib.gunzipSync(archive);
    const cut = zlib.gzipSync(tar.subarray(0, Math.floor(tar.length * 0.7)));
    const uploadId = await upload(cut);

    const dry = await preview(uploadId);
    assert.equal(dry.statusCode, 400);
    assert.equal(dry.body.code, 'BACKUP_UNREADABLE');

    const failed = await restore(uploadId, 'restore-gym');
    assert.equal(failed.statusCode, 400, JSON.stringify(failed.body));
    assert.match(failed.body.message, /incomplete/);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await stagingLeft(), []);
  });
});

test('an upload is only finished with the file it was granted for', async () => {
  await h.inGym(gym, async () => {
    const grant = await h.call(controller.grantUpload, as({ body: { size: 1000 } }));
    const { uploadId, pathname } = grant.body.data;
    for (const url of [`${STORE}/intruder-gym/backups/uploads/x.gpbackup`, `https://evil.example/${pathname}`, `${STORE}/${pathname.replace(/[a-f0-9]{32}/, 'f'.repeat(32))}`]) {
      const res = await h.call(controller.completeUpload, as({ params: { id: uploadId }, body: { url } }));
      assert.equal(res.statusCode, 400, url);
    }
    // Still pending: it cannot be previewed or restored.
    assert.equal((await preview(uploadId)).statusCode, 404);
    assert.equal((await h.call(controller.grantUpload, as({ body: { size: 600 * 1024 * 1024 } }))).statusCode, 413);
  });
});

test('an uploaded file never restored from is removed a day later', async () => {
  await h.inGym(gym, async () => {
    const archive = await downloadNow(gym);
    const uploadId = await upload(archive);
    const { url } = await PlatformBackup.findById(uploadId).lean();
    const pending = (await h.call(controller.grantUpload, as({ body: { size: 10 } }))).body.data.uploadId;
    await h.rawDb(h.PLATFORM_DB)
      .collection('platform_backups')
      .updateMany({ _id: { $in: [uploadId, pending].map((id) => new mongoose.Types.ObjectId(id)) } }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    // Old uploads go whenever the gym's backups are tidied: after any backup.
    assert.equal((await h.call(controller.run, as())).statusCode, 201);
    assert.equal(await PlatformBackup.countDocuments({ _id: { $in: [uploadId, pending] } }), 0);
    assert.ok(!blobs.has(url));
  });
});

test('one restore at a time: a running one refuses a second, a stale lock does not', async () => {
  const runs = h.rawDb(h.PLATFORM_DB).collection('platform_job_runs');
  await h.inGym(gym, async () => {
    const backupId = (await h.call(controller.run, as())).body.data.id;
    await runs.updateOne({ job: 'restore', gymId: gym._id }, { $set: { lastStartedAt: new Date(), lastRunAt: null } }, { upsert: true });
    const busy = await restore(backupId, 'restore-gym');
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.body.code, 'RESTORE_IN_PROGRESS');

    await runs.updateOne({ job: 'restore', gymId: gym._id }, { $set: { lastStartedAt: new Date(Date.now() - 16 * 60 * 1000) } });
    const done = await restore(backupId, 'restore-gym');
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    const lock = await runs.findOne({ job: 'restore', gymId: gym._id });
    assert.equal(lock.lastOutcome, 'ok');
    assert.ok(lock.lastRunAt >= lock.lastStartedAt);
  });
});

test('a restore ends every session, including ones ended since the backup that it would bring back', async () => {
  const auth = h.src('middleware/auth');
  const DesktopToken = h.src('attendance/models/desktopTokenModel');
  const ENDED = /session has ended/;
  await h.inGym(gym, async () => {
    await h.ensureIndexes(DesktopToken);
    const member = await User.findOne({ email: 'm3@restore.test' }).lean();
    const ownerNow = await User.findById(owner._id).lean();
    // A token and a desk sign-in as the backup will remember them.
    const stolen = member.tokenVersion || 0;
    const desk = await DesktopToken.issue(member._id, { deviceLabel: 'DESK-9', ip: '127.0.0.1' });
    const backupId = (await h.call(controller.run, as())).body.data.id;

    // Then the token is found to be stolen and the password reset, which
    // ends it and the desk sign-in; the member signs in again since.
    await User.updateOne({ _id: member._id }, { $inc: { tokenVersion: 1 } });
    await DesktopToken.revokeAllForUser(member._id);
    auth.forgetSession(member._id);
    const since = stolen + 1;
    assert.match(await auth.sessionProblem({ id: String(member._id), tv: stolen }), ENDED);
    assert.equal(await auth.sessionProblem({ id: String(member._id), tv: since }), null);

    const done = await restore(backupId, 'restore-gym');
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.signedOut, true);
    assert.match(done.body.message, /sign in again/);

    // Neither the stolen token the backup remembers nor the one from since
    // works, nor the desk sign-in -- and that is everyone, the owner too.
    assert.match(await auth.sessionProblem({ id: String(member._id), tv: stolen }), ENDED);
    assert.match(await auth.sessionProblem({ id: String(member._id), tv: since }), ENDED);
    assert.equal(await DesktopToken.findUsable(desk.token), null);
    assert.match(await auth.sessionProblem({ id: String(owner._id), tv: ownerNow.tokenVersion || 0 }), ENDED);

    // A sign-in after the restore is an ordinary one.
    const restored = await User.findById(member._id).lean();
    assert.equal(await auth.sessionProblem({ id: String(member._id), tv: restored.tokenVersion }), null);
  });
});

test('the tidy-up after the safety backup never removes the backup being restored', async () => {
  // Storing the safety backup prunes the gym's backups, which used to run
  // before the file being restored was opened: an upload over a day old, or
  // the oldest backup of a kind at its keep limit, was deleted for good and
  // the restore failed on a file that was no longer there.
  const previousKeep = process.env.BACKUP_KEEP_DAILY;
  process.env.BACKUP_KEEP_DAILY = '1';
  try {
    const archive = await downloadNow(gym);
    await h.inGym(gym, async () => {
      const uploadId = await upload(archive);
      await h.rawDb(h.PLATFORM_DB)
        .collection('platform_backups')
        .updateOne({ _id: new mongoose.Types.ObjectId(uploadId) }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
      const fromUpload = await restore(uploadId, 'restore-gym');
      assert.equal(fromUpload.statusCode, 200, JSON.stringify(fromUpload.body));

      // One 'Before a restore' is kept, and restoring it makes another.
      const safety = fromUpload.body.data.safetyBackup;
      assert.equal(await PlatformBackup.countDocuments({ gymId: gym._id, kind: 'pre-restore' }), 1);
      const fromSafety = await restore(safety, 'restore-gym');
      assert.equal(fromSafety.statusCode, 200, JSON.stringify(fromSafety.body));
      const kept = await PlatformBackup.findById(safety).lean();
      assert.ok(kept && blobs.has(kept.url), 'the backup restored from is still there');
    });
  } finally {
    if (previousKeep === undefined) delete process.env.BACKUP_KEEP_DAILY;
    else process.env.BACKUP_KEEP_DAILY = previousKeep;
  }
});
