// Stored files: every name the Blob store is given carries 128 random bits
// (the store is public, so the URL is the only thing in front of an ID scan),
// and deleteStoredFile() removes a gym's own file -- in the store or on local
// disk -- and nothing else. @vercel/blob is replaced below, so nothing here
// talks to the store.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const puts = [];
const dels = [];
let delError = null;
const blobPath = require.resolve('@vercel/blob');
require.cache[blobPath] = {
  id: blobPath,
  filename: blobPath,
  loaded: true,
  exports: {
    put: async (pathname, body, options) => {
      puts.push({ pathname, options });
      return { url: `https://store1.public.blob.vercel-storage.com/${pathname}` };
    },
    del: async (url) => {
      dels.push(url);
      if (delError) throw delError;
    },
  },
};

const blob = require('../../src/helper/blobUpload');
const { UPLOADS_DIR } = require('../../src/helper/upload');
const { runWithTenant } = require('../../src/platform/tenantContext');

const HOST = 'https://store1.public.blob.vercel-storage.com';
const inGym = (slug, fn) => runWithTenant({ gym: { slug }, connection: {} }, fn);

test('every stored name carries 128 random bits, a new one each time', async () => {
  puts.length = 0;
  const png = Buffer.from('not really a png');
  const urls = await inGym('gym-a', async () => [
    await blob.uploadToBlob(png, 'passport scan.png', 'image/png', 'member-documents'),
    await blob.uploadToBlob(png, 'passport scan.png', 'image/png', 'member-documents'),
    await blob.uploadScreenshot(png, 'proof.png', 'image/png'),
  ]);

  const shape = /^gym-a\/(member-documents|screenshots)\/\d+-([0-9a-f]{32})-[^/]+\.png$/;
  const randoms = puts.map(({ pathname }) => {
    assert.match(pathname, shape);
    return pathname.match(shape)[2];
  });
  assert.equal(new Set(randoms).size, 3, 'no two names share their random part');
  assert.equal(urls[0], `${HOST}/${puts[0].pathname}`);
});

test('a file in the store is deleted only from the gym\'s own folder', async () => {
  dels.length = 0;
  const own = `${HOST}/gym-a/member-documents/1-abc-id.pdf`;

  assert.equal(await inGym('gym-a', () => blob.deleteStoredFile(`${own}?download=1`, 'member-documents')), true);
  assert.deepEqual(dels, [own], 'asked for by its plain URL');

  dels.length = 0;
  const left = [
    [`${HOST}/gym-b/member-documents/1-abc-id.pdf`, 'member-documents'], // another gym's
    [`${HOST}/gym-a/hero-slides/1-abc-logo.png`, 'member-documents'],     // this gym's, another folder
    [`${HOST}/gym-a/member-documents/../../gym-b/member-documents/x.pdf`, 'member-documents'],
    [`${HOST}/member-documents/1-abc-id.pdf`, 'member-documents'],        // in no gym's folder
    ['https://lh3.googleusercontent.com/a/photo', 'members'],             // not ours at all
    ['http://store1.public.blob.vercel-storage.com/gym-a/members/x.png', 'members'],
    ['', 'members'],
    [null, 'members'],
  ];
  for (const [url, folder] of left) {
    assert.equal(await inGym('gym-a', () => blob.deleteStoredFile(url, folder)), false, String(url));
  }
  // No gym, no delete.
  assert.equal(await blob.deleteStoredFile(own, 'member-documents'), false);
  assert.deepEqual(dels, []);

  // With no folder named, anywhere under the gym's own prefix -- and still
  // nowhere else.
  assert.equal(await inGym('gym-a', () => blob.deleteStoredFile(own)), true);
  assert.equal(await inGym('gym-a', () => blob.deleteStoredFile(`${HOST}/gym-b/members/x.png`)), false);
  assert.deepEqual(dels, [own]);
});

test('a delete the store refuses is logged, never thrown', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  delError = new Error('store unavailable');
  try {
    assert.equal(await inGym('gym-a', () => blob.deleteStoredFile(`${HOST}/gym-a/members/1-a.png`, 'members')), false);
  } finally {
    delError = null;
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /store unavailable/);
});

test('a local file is deleted only from the gym\'s own folder, and twice is fine', async () => {
  const mine = `unit-files-a-${process.pid}`;
  const theirs = `unit-files-b-${process.pid}`;
  for (const slug of [mine, theirs]) {
    fs.mkdirSync(path.join(UPLOADS_DIR, slug), { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, slug, 'letter.pdf'), 'x');
  }
  try {
    const exists = (slug) => fs.existsSync(path.join(UPLOADS_DIR, slug, 'letter.pdf'));

    // Another gym's file, by its own path and by climbing to it.
    assert.equal(await inGym(mine, () => blob.deleteStoredFile(`/uploads/${theirs}/letter.pdf`, 'member-documents')), false);
    assert.equal(await inGym(mine, () => blob.deleteStoredFile(`/uploads/${mine}/../${theirs}/letter.pdf`)), false);
    assert.equal(await inGym(mine, () => blob.deleteStoredFile('/uploads/../package.json')), false);
    assert.equal(exists(theirs), true);
    assert.equal(fs.existsSync(path.resolve(UPLOADS_DIR, '..', 'package.json')), true);

    assert.equal(await inGym(mine, () => blob.deleteStoredFile(`/uploads/${mine}/letter.pdf`, 'member-documents')), true);
    assert.equal(exists(mine), false);
    // Already gone: not an error.
    assert.equal(await inGym(mine, () => blob.deleteStoredFile(`/uploads/${mine}/letter.pdf`, 'member-documents')), true);
  } finally {
    for (const slug of [mine, theirs]) fs.rmSync(path.join(UPLOADS_DIR, slug), { recursive: true, force: true });
  }
});
