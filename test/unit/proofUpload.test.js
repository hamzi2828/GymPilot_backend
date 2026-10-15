// Payment receipts may be a PDF: Pakistani bank and wallet apps usually
// export one. Only the proof upload takes them, at the image size limit, and
// only when the file's own first bytes say PDF -- on local disk (multer, then
// helper/upload.js proofUploadSingle) and on the Blob store (uploadToBlob
// with kind 'proof'). @vercel/blob is replaced below, so nothing here talks
// to the store.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const puts = [];
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
    del: async () => {},
  },
};

const upload = require('../../src/helper/upload');
const blob = require('../../src/helper/blobUpload');
const { runWithTenant } = require('../../src/platform/tenantContext');

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const FAKE_PDF = Buffer.from('<html><script>alert(1)</script></html>', 'latin1');

test('the first bytes decide what a file really is', () => {
  assert.equal(upload.startsLike(PDF, 'application/pdf'), true);
  assert.equal(upload.startsLike(PNG, 'image/png'), true);
  assert.equal(upload.startsLike(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), true);
  assert.equal(upload.startsLike(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), 'image/webp'), true);
  assert.equal(upload.startsLike(FAKE_PDF, 'application/pdf'), false);
  assert.equal(upload.startsLike(PDF, 'image/png'), false);
  assert.equal(upload.startsLike(Buffer.alloc(0), 'application/pdf'), false);
  assert.equal(upload.startsLike(PDF, 'text/html'), false);
});

test('Blob store: a real PDF receipt is stored as .pdf, a fake one and an oversized one are refused', async () => {
  puts.length = 0;
  const url = await runWithTenant({ gym: { slug: 'gym-a' }, connection: {} }, () =>
    blob.uploadToBlob(PDF, 'HBL receipt.pdf', 'application/pdf', 'payment-proofs', { kind: 'proof' })
  );
  assert.match(url, /\/gym-a\/payment-proofs\/\d+-[0-9a-f]{32}-HBL-receipt\.pdf$/);
  assert.equal(puts[0].options.contentType, 'application/pdf');

  await assert.rejects(
    () => blob.uploadToBlob(FAKE_PDF, 'receipt.pdf', 'application/pdf', 'payment-proofs', { kind: 'proof' }),
    /photo .* or a PDF/
  );
  const big = Buffer.concat([PDF, Buffer.alloc(blob.MAX_FILE_SIZE)]);
  await assert.rejects(
    () => blob.uploadToBlob(big, 'receipt.pdf', 'application/pdf', 'payment-proofs', { kind: 'proof' }),
    /exceeds/
  );
  // Images still go through, checked the same way.
  await blob.uploadToBlob(PNG, 'screenshot.png', 'image/png', 'payment-proofs', { kind: 'proof' });
  await assert.rejects(() => blob.uploadToBlob(PDF, 'x.png', 'image/png', 'payment-proofs', { kind: 'proof' }));
  assert.equal(puts.length, 2);
});

// The local-disk path, through a real multipart request.
async function withServer(fn) {
  const app = express();
  app.post('/proof', upload.proofUploadSingle('proof'), (req, res) =>
    res.json({ ok: true, file: req.file ? { name: req.file.filename, type: req.file.mimetype } : null })
  );
  app.post('/image', upload.uploadSingle('proof'), (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function send(base, route, bytes, type, name) {
  const form = new FormData();
  form.append('proof', new Blob([bytes], { type }), name);
  return fetch(`${base}${route}`, { method: 'POST', body: form }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const before = () => new Set(fs.existsSync(upload.UPLOADS_DIR) ? fs.readdirSync(upload.UPLOADS_DIR) : []);

test('local disk: a PDF receipt is kept, a fake PDF is refused and removed, other types are refused', async () => {
  const existing = before();
  await withServer(async (base) => {
    const ok = await send(base, '/proof', PDF, 'application/pdf', 'receipt.pdf');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.file.name, /\.pdf$/);
    const stored = path.join(upload.UPLOADS_DIR, ok.body.file.name);
    assert.ok(fs.existsSync(stored));
    fs.unlinkSync(stored);

    const fake = await send(base, '/proof', FAKE_PDF, 'application/pdf', 'receipt.pdf');
    assert.equal(fake.status, 400);
    assert.equal(fake.body.code, 'FILE_NOT_ALLOWED');

    const word = await send(base, '/proof', Buffer.from('PK\x03\x04'), 'application/msword', 'receipt.doc');
    assert.equal(word.status, 400);
    assert.match(word.body.message, /photo .* or a PDF/);

    // Every other image upload still refuses a PDF.
    const elsewhere = await send(base, '/image', PDF, 'application/pdf', 'receipt.pdf');
    assert.notEqual(elsewhere.status, 200);
  });
  // Nothing left behind: the fake was deleted after it was read.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const left = [...before()].filter((name) => !existing.has(name));
  assert.deepEqual(left, []);
});
