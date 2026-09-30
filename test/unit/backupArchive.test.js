// The backup archive both ways (services/backupService.js), with a stand-in
// database: what goes in comes out with its BSON types, in parts when a
// collection is big, and a file that is not ours -- or not whole -- is
// refused in words the owner can act on. No MongoDB needed.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { PassThrough, Readable } = require('stream');
const mongoose = require('mongoose');
const backups = require('../../src/services/backupService');

const { ObjectId, Decimal128, Long } = mongoose.mongo;

// Just enough of a driver Db for the writer: listCollections, listIndexes, find.
function fakeDb(collections) {
  return {
    listCollections: () => ({
      toArray: async () => Object.keys(collections).map((name) => ({ name, type: collections[name].type || 'collection', options: collections[name].options || {} }))
    }),
    collection: (name) => ({
      listIndexes: () => ({ toArray: async () => collections[name].indexes || [{ v: 2, key: { _id: 1 }, name: '_id_' }] }),
      find: () => ({
        async *[Symbol.asyncIterator]() {
          for (const doc of collections[name].docs || []) yield doc;
        }
      })
    })
  };
}

const GYM = { _id: new ObjectId('64b000000000000000000001'), slug: 'iron', name: 'Iron Works' };

async function archiveOf(collections, options = {}) {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(c));
  // gym: null keeps the writer away from the tenant-bound Settings model.
  const manifest = await backups.writeArchive({ db: fakeDb(collections), gym: null, trigger: 'test', ...options }, sink);
  return { bytes: Buffer.concat(chunks), manifest };
}

async function readAll(bytes) {
  const events = [];
  for await (const event of backups.readArchive(Readable.from([bytes]))) events.push(event);
  return events;
}

const members = [
  { _id: new ObjectId('64b0000000000000000000aa'), email: 'a@iron.test', joined: new Date('2026-01-02T03:04:05Z'), credit: Decimal128.fromString('12.50'), visits: Long.fromNumber(2 ** 40), tags: ['x'] },
  { _id: new ObjectId('64b0000000000000000000ab'), email: 'b@iron.test', joined: new Date('2026-02-03T04:05:06Z'), nested: { deep: { value: 1.5 } } }
];

test('what goes in comes out: header, definitions, documents with their types, manifest', async () => {
  const { bytes, manifest } = await archiveOf(
    {
      users: { docs: members, indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, { v: 2, key: { email: 1 }, name: 'email_1', unique: true }] },
      empty_things: { docs: [] }
    },
    { gym: null, now: new Date('2026-09-30T02:00:00Z') }
  );
  assert.equal(manifest.documents, 2);
  assert.deepEqual(manifest.collections.map((c) => [c.name, c.documents, c.parts]), [['empty_things', 0, 1], ['users', 2, 1]]);

  const events = await readAll(bytes);
  assert.deepEqual(events.map((e) => e.type), ['header', 'collection', 'documents', 'collection', 'documents', 'manifest']);
  assert.equal(events[0].header.format, 'gympilot-backup');
  assert.equal(events[0].header.createdAt, '2026-09-30T02:00:00.000Z');
  const users = events[4].documents;
  assert.equal(users.length, 2);
  assert.ok(users[0]._id instanceof ObjectId);
  assert.equal(String(users[0]._id), '64b0000000000000000000aa');
  assert.ok(users[0].joined instanceof Date);
  assert.equal(users[0].joined.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(users[0].credit.toString(), '12.50');
  assert.equal(users[0].visits.toString(), String(2 ** 40));
  assert.equal(Number(users[1].nested.deep.value), 1.5);
  const definition = events[3].collection;
  assert.equal(definition.name, 'users');
  assert.equal(definition.indexes[1].name, 'email_1');
  assert.equal(definition.indexes[1].unique, true);
});

test('a big collection goes out in parts, and every part comes back', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ _id: i, pad: 'x'.repeat(200) }));
  const { bytes, manifest } = await archiveOf({ attendance: { docs: many } }, { partBytes: 8 * 1024 });
  assert.ok(manifest.collections[0].parts > 3, `parts: ${manifest.collections[0].parts}`);
  const summary = await backups.summarizeArchive(Readable.from([bytes]));
  assert.deepEqual(summary.collections, [{ name: 'attendance', indexes: 1, documents: 300 }]);
  assert.equal(summary.documents, 300);
});

test('the platform\'s own collections and MongoDB\'s are never in a gym\'s backup', () => {
  for (const name of ['gyms', 'super_admins', 'platform_plans', 'platform_backups', 'system.views']) {
    assert.equal(backups.isGymCollection({ name, type: 'collection' }), false, name);
  }
  assert.equal(backups.isGymCollection({ name: 'users', type: 'collection' }), true);
  assert.equal(backups.isGymCollection({ name: 'members_view', type: 'view' }), false);
});

test('the archive is a real tar: every header carries a valid checksum', async () => {
  const { bytes } = await archiveOf({ users: { docs: members } });
  const tar = zlib.gunzipSync(bytes);
  const header = tar.subarray(0, 512);
  assert.equal(header.subarray(0, 11).toString(), 'backup.json');
  assert.equal(header.subarray(257, 262).toString(), 'ustar');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  assert.equal(parseInt(header.subarray(148, 154).toString(), 8), sum);
});

test('a file cut short is refused as incomplete', async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ _id: i, pad: 'y'.repeat(300) }));
  const { bytes } = await archiveOf({ attendance: { docs: many } }, { partBytes: 4 * 1024 });
  const tar = zlib.gunzipSync(bytes);
  // Whole gzip, but the tar inside stops half-way: no manifest.
  const cut = zlib.gzipSync(tar.subarray(0, Math.floor(tar.length / 2)));
  await assert.rejects(readAll(cut), (error) => error instanceof backups.BackupFileError && /incomplete/.test(error.message));
  // And a gzip stream that is itself cut off.
  await assert.rejects(readAll(bytes.subarray(0, Math.floor(bytes.length / 2))), (error) => error instanceof backups.BackupFileError);
});

test('something that is not a backup is refused, whatever it is', async () => {
  await assert.rejects(readAll(Buffer.from('name,email\nA,a@b.c\n')), (error) => error instanceof backups.BackupFileError && /not a GymPilot backup/.test(error.message));
  await assert.rejects(readAll(zlib.gzipSync(Buffer.from('{"hello":"world"}'))), (error) => error instanceof backups.BackupFileError);

  // A well-formed tar.gz of somebody else's files.
  const tarOf = (name, data) => {
    const header = backups.tarHeader(name, data.length, Date.now());
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    return zlib.gzipSync(Buffer.concat([header, data, pad, Buffer.alloc(1024)]));
  };
  await assert.rejects(readAll(tarOf('notes.txt', Buffer.from('hello'))), /not a GymPilot backup/);
  await assert.rejects(readAll(tarOf('backup.json', Buffer.from('{"format":"something-else"}'))), /not a GymPilot backup/);
  await assert.rejects(readAll(tarOf('backup.json', Buffer.from('{"format":"gympilot-backup","version":99}'))), /newer version/);
});

test('a manifest that does not match what was read is refused', async () => {
  const { bytes } = await archiveOf({ users: { docs: members } });
  const tar = zlib.gunzipSync(bytes);
  // Rewrite the manifest to claim a third member, keeping the entry's size.
  const text = tar.toString('latin1');
  const at = text.indexOf('"documents": 2', text.indexOf('"finishedAt"'));
  assert.ok(at > 0);
  const tampered = Buffer.from(tar);
  tampered.write('"documents": 3', at, 'latin1');
  const collectionAt = text.indexOf('"documents": 2', text.indexOf('"collections": ['));
  tampered.write('"documents": 3', collectionAt, 'latin1');
  await assert.rejects(readAll(zlib.gzipSync(tampered)), /incomplete: users does not hold the 3 document/);
});
