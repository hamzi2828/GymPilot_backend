// Stored backups are encrypted (services/backupCrypto.js): what goes in
// comes out, whatever its size; nothing comes out of a file that was
// changed, cut short, or made for another gym or with another key -- and
// each of those says so in words the owner can act on.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Readable, PassThrough } = require('stream');
const { pipeline } = require('stream/promises');
const backupCrypto = require('../../src/services/backupCrypto');

const GYM = '64b000000000000000000001';
const OTHER_GYM = '64b000000000000000000002';
const { CHUNK_BYTES, HEADER_BYTES, TAG_BYTES } = backupCrypto;

function withKey(value, fn) {
  const before = process.env.BACKUP_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
  else process.env.BACKUP_ENCRYPTION_KEY = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (before === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
      else process.env.BACKUP_ENCRYPTION_KEY = before;
    });
}

async function through(transform, input, pieceBytes = 64 * 1024) {
  const pieces = [];
  for (let i = 0; i < input.length; i += pieceBytes) pieces.push(input.subarray(i, i + pieceBytes));
  const sink = new PassThrough();
  const out = [];
  sink.on('data', (c) => out.push(c));
  await pipeline(Readable.from(pieces.length ? pieces : [Buffer.alloc(0)]), transform, sink);
  return Buffer.concat(out);
}

const encrypt = (data, gym = GYM) => through(backupCrypto.encryptStream(gym), data);
const decrypt = (data, gym = GYM, pieceBytes) => through(backupCrypto.decryptStream(gym), data, pieceBytes);

test('what goes in comes out, at every size around the chunk boundaries', async () => {
  await withKey('unit-backup-key', async () => {
    for (const size of [0, 1, 1000, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 2 * CHUNK_BYTES, 2 * CHUNK_BYTES + 12345]) {
      const plain = crypto.randomBytes(size);
      const sealed = await encrypt(plain);
      const chunks = Math.floor(size / CHUNK_BYTES) + (size % CHUNK_BYTES || size === 0 ? 1 : 0);
      assert.equal(sealed.length, HEADER_BYTES + size + chunks * TAG_BYTES, `size ${size}`);
      // Read back in pieces that never line up with the chunks.
      assert.ok((await decrypt(sealed, GYM, 7919)).equals(plain), `size ${size}`);
    }
  });
});

test('the same backup encrypts differently every time', async () => {
  await withKey('unit-backup-key', async () => {
    const plain = Buffer.from('the same members');
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    assert.ok(!a.equals(b));
    assert.ok(!a.includes(plain));
  });
});

test('a changed byte anywhere is refused, and nothing after the first chunk is released unchecked', async () => {
  await withKey('unit-backup-key', async () => {
    const plain = crypto.randomBytes(CHUNK_BYTES + 5000);
    const sealed = await encrypt(plain);
    for (const at of [HEADER_BYTES + 10, HEADER_BYTES + CHUNK_BYTES + TAG_BYTES + 10, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] ^= 0x01;
      await assert.rejects(decrypt(bad), (error) => error instanceof backupCrypto.BackupCryptoError && /damaged/.test(error.message), `byte ${at}`);
    }
    // The salt is covered too (the header is the chunks' additional data).
    const salted = Buffer.from(sealed);
    salted[HEADER_BYTES - 1] ^= 0x01;
    await assert.rejects(decrypt(salted), backupCrypto.BackupCryptoError);
  });
});

test('a file cut short is refused, even exactly at a chunk boundary', async () => {
  await withKey('unit-backup-key', async () => {
    const sealed = await encrypt(crypto.randomBytes(3 * CHUNK_BYTES));
    const atBoundary = sealed.subarray(0, HEADER_BYTES + 2 * (CHUNK_BYTES + TAG_BYTES));
    await assert.rejects(decrypt(atBoundary), /damaged or incomplete/);
    await assert.rejects(decrypt(sealed.subarray(0, HEADER_BYTES + 100)), /damaged or incomplete/);
    await assert.rejects(decrypt(sealed.subarray(0, 20)), /not an encrypted GymPilot backup/);
  });
});

test('another gym\'s backup, or one made with another key, cannot be opened -- and says so', async () => {
  const sealed = await withKey('unit-backup-key', () => encrypt(Buffer.from('gym one only')));
  await withKey('unit-backup-key', async () => {
    await assert.rejects(decrypt(sealed, OTHER_GYM), (error) => error.code === 'BACKUP_WRONG_KEY' && /another gym/.test(error.message));
  });
  await withKey('a-rotated-key', async () => {
    await assert.rejects(decrypt(sealed, GYM), (error) => error.code === 'BACKUP_WRONG_KEY' && /BACKUP_ENCRYPTION_KEY was changed/.test(error.message));
  });
});

test('no key, no stored backups: nothing is encrypted with a stand-in', async () => {
  await withKey(undefined, async () => {
    assert.equal(backupCrypto.keyConfigured(), false);
    assert.throws(() => backupCrypto.encryptStream(GYM), (error) => error.code === 'BACKUP_KEY_MISSING');
  });
  // JWT_SECRET is set in this process; it is not used in its place.
  assert.ok(process.env.JWT_SECRET);
});

test('something that is not ours is refused before any key is needed', async () => {
  await withKey('unit-backup-key', async () => {
    await assert.rejects(decrypt(Buffer.from('x'.repeat(200))), /not an encrypted GymPilot backup/);
    await assert.rejects(decrypt(Buffer.alloc(0)), /empty/);
  });
});
