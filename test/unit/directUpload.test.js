// Direct browser -> Vercel Blob uploads: who may get a client token, for
// which types and sizes, and where the file is allowed to land. handleUpload()
// from @vercel/blob/client is replaced below, so nothing here talks to the
// store or to a database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

// Stand-in for handleUpload: records what it was given and, for a token
// request, asks onBeforeGenerateToken exactly as the real one does.
const calls = [];
let completionError = null;
const clientPath = require.resolve('@vercel/blob/client');
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    handleUpload: async (options) => {
      calls.push(options);
      const { body } = options;
      if (body.type === 'blob.upload-completed') {
        if (completionError) throw completionError;
        await options.onUploadCompleted(body.payload);
        return { type: body.type, response: 'ok' };
      }
      const { pathname, clientPayload, multipart } = body.payload;
      const tokenOptions = await options.onBeforeGenerateToken(pathname, clientPayload, multipart);
      return { type: body.type, clientToken: 'vercel_blob_client_fake', tokenOptions };
    },
  },
};

const uploads = require('../../src/controller/uploadController');
const { ownBlobUrl } = require('../../src/helper/blobUpload');

const MB = 1024 * 1024;

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function fakeReq(body, extra = {}) {
  return {
    body,
    headers: {},
    protocol: 'https',
    tenant: { slug: 'gym-a' },
    user: { id: 'u1' },
    get: (name) => (String(name).toLowerCase() === 'host' ? 'api.example.com' : undefined),
    ...extra,
  };
}

function tokenRequest(claim, pathname = 'clip.mp4', rest = {}) {
  return {
    type: 'blob.generate-client-token',
    payload: { pathname, callbackUrl: 'https://attacker.example/hook', clientPayload: JSON.stringify(claim), multipart: false, ...rest },
  };
}

async function withToken(value, fn) {
  const before = process.env.BLOB_READ_WRITE_TOKEN;
  if (value === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = before;
  }
}

// ---------------------------------------------------------------------------
// The decisions
// ---------------------------------------------------------------------------

test('each kind needs manage on its own tab and lands in its own folder', () => {
  const expected = {
    'homepage-image': ['homepage', 'home-sections'],
    'homepage-video': ['homepage', 'home-videos'],
    'hero-slide': ['hero-slides', 'hero-slides'],
    testimonial: ['testimonials', 'testimonials'],
  };
  assert.deepEqual(Object.keys(uploads.KINDS).sort(), Object.keys(expected).sort());
  for (const [kind, [tab, folder]] of Object.entries(expected)) {
    assert.equal(uploads.KINDS[kind].tab, tab, kind);
    assert.equal(uploads.KINDS[kind].folder, folder, kind);
  }
});

test('the path is chosen by the server, under the gym prefix, whatever the browser proposed', () => {
  const plan = uploads.planDirectUpload(
    { kind: 'homepage-video', contentType: 'video/mp4', size: 50 * MB, filename: '../../gym-b/home-videos/My Clip!.exe' },
    'gym-a'
  );
  assert.equal(plan.error, undefined);
  assert.equal(plan.prefix, 'gym-a/home-videos/');
  assert.match(plan.pathname, /^gym-a\/home-videos\/\d+-\d+-My-Clip\.mp4$/);
  assert.ok(!plan.pathname.includes('..'));

  // No slug (outside a gym): the bare folder, as the API path does.
  assert.match(uploads.planDirectUpload({ kind: 'testimonial', contentType: 'image/png', size: 5 * MB }, '').pathname, /^testimonials\/\d+-\d+-file\.png$/);
  assert.equal(uploads.safeBaseName('a/b\\c/..'), 'file');
  assert.equal(uploads.safeBaseName('photo.final.JPG'), 'photo-final');
});

test('only the kind\'s own types are allowed -- never SVG', () => {
  const refused = (kind, contentType) => uploads.planDirectUpload({ kind, contentType, size: MB }, 'gym-a').error;
  assert.equal(refused('hero-slide', 'image/svg+xml').code, 'UPLOAD_TYPE_NOT_ALLOWED');
  assert.equal(refused('hero-slide', 'image/gif').code, 'UPLOAD_TYPE_NOT_ALLOWED');
  assert.equal(refused('hero-slide', 'video/mp4').code, 'UPLOAD_TYPE_NOT_ALLOWED');
  assert.equal(refused('homepage-video', 'video/quicktime').code, 'UPLOAD_TYPE_NOT_ALLOWED');
  assert.equal(refused('homepage-video', 'image/png').code, 'UPLOAD_TYPE_NOT_ALLOWED');
  assert.equal(refused('homepage-video', 'text/html').status, 400);
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    for (const kind of ['homepage-image', 'hero-slide', 'testimonial']) assert.equal(refused(kind, type), undefined, `${kind} ${type}`);
  }
  assert.equal(refused('homepage-video', 'video/mp4'), undefined);
  assert.equal(refused('homepage-video', 'VIDEO/WEBM'), undefined);
});

test('size ceilings: 100 MB for video, 20 MB for images, and a size is required', () => {
  const plan = (kind, contentType, size) => uploads.planDirectUpload({ kind, contentType, size }, 'gym-a');
  assert.equal(plan('homepage-video', 'video/mp4', 100 * MB).error, undefined);
  assert.equal(plan('homepage-video', 'video/mp4', 100 * MB + 1).error.status, 413);
  assert.equal(plan('homepage-video', 'video/mp4', 100 * MB + 1).error.code, 'FILE_TOO_LARGE');
  assert.equal(plan('hero-slide', 'image/jpeg', 20 * MB).error, undefined);
  assert.equal(plan('hero-slide', 'image/jpeg', 20 * MB + 1).error.status, 413);
  assert.equal(plan('testimonial', 'image/jpeg', 0).error.code, 'UPLOAD_SIZE_MISSING');
  assert.equal(plan('testimonial', 'image/jpeg', undefined).error.code, 'UPLOAD_SIZE_MISSING');
  assert.equal(plan('testimonial', 'image/jpeg', 'lots').error.code, 'UPLOAD_SIZE_MISSING');
});

test('unknown kinds are refused, including inherited property names', () => {
  for (const kind of [undefined, '', 'blog', '__proto__', 'constructor', 'toString']) {
    assert.equal(uploads.planDirectUpload({ kind, contentType: 'image/png', size: MB }, 'gym-a').error.code, 'UPLOAD_KIND_UNKNOWN', String(kind));
  }
});

test('the token allows only the planned path, the declared type and the kind\'s ceiling', () => {
  const plan = uploads.planDirectUpload({ kind: 'hero-slide', contentType: 'image/webp', size: 8 * MB }, 'gym-a');
  const options = uploads.tokenOptionsFor(plan, plan.pathname, { slug: 'gym-a', userId: 'u1' });
  assert.deepEqual(options.allowedContentTypes, ['image/webp']);
  assert.equal(options.maximumSizeInBytes, 20 * MB);
  assert.deepEqual(JSON.parse(options.tokenPayload), { kind: 'hero-slide', gym: 'gym-a', user: 'u1' });
  assert.throws(() => uploads.tokenOptionsFor(plan, 'gym-b/hero-slides/x.webp'));
  assert.throws(() => uploads.tokenOptionsFor(plan, `${plan.pathname}.html`));
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test('without BLOB_READ_WRITE_TOKEN the route answers 409 BLOB_NOT_CONFIGURED', async () => {
  await withToken(undefined, async () => {
    calls.length = 0;
    const res = fakeRes();
    await uploads.handleBlobUpload(fakeReq(tokenRequest({ kind: 'homepage-video', contentType: 'video/mp4', size: 10 * MB })), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'BLOB_NOT_CONFIGURED');
    assert.equal(calls.length, 0);
  });
});

test('a token request is rebuilt: our path, our callback, no browser payload passed on', async () => {
  await withToken('vercel_blob_rw_store_secret', async () => {
    calls.length = 0;
    const res = fakeRes();
    const req = fakeReq(tokenRequest({ kind: 'homepage-video', contentType: 'video/mp4', size: 30 * MB, extra: 'x' }, '../other-gym/clip.mp4', { multipart: true }));
    await uploads.handleBlobUpload(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    const { payload } = calls[0].body;
    assert.match(payload.pathname, /^gym-a\/home-videos\/\d+-\d+-clip\.mp4$/);
    assert.equal(payload.callbackUrl, 'https://api.example.com/api/uploads/blob?tenant=gym-a');
    assert.equal(payload.clientPayload, null);
    assert.equal(payload.multipart, true);

    assert.equal(res.body.clientToken, 'vercel_blob_client_fake');
    assert.equal(res.body.pathname, payload.pathname);
    assert.deepEqual(res.body.tokenOptions.allowedContentTypes, ['video/mp4']);
    assert.equal(res.body.tokenOptions.maximumSizeInBytes, 100 * MB);
  });
});

test('a refused request never reaches the store', async () => {
  await withToken('vercel_blob_rw_store_secret', async () => {
    calls.length = 0;
    const big = fakeRes();
    await uploads.handleBlobUpload(fakeReq(tokenRequest({ kind: 'testimonial', contentType: 'image/jpeg', size: 25 * MB })), big);
    assert.equal(big.statusCode, 413);
    assert.equal(big.body.code, 'FILE_TOO_LARGE');

    const svg = fakeRes();
    await uploads.handleBlobUpload(fakeReq(tokenRequest({ kind: 'hero-slide', contentType: 'image/svg+xml', size: MB })), svg);
    assert.equal(svg.statusCode, 400);

    const junk = fakeRes();
    await uploads.handleBlobUpload(fakeReq({ type: 'something-else' }), junk);
    assert.equal(junk.statusCode, 400);

    assert.equal(calls.length, 0);
  });
});

test('Vercel\'s completion callback is handed to handleUpload to verify, and cannot mint a token', async () => {
  await withToken('vercel_blob_rw_store_secret', async () => {
    calls.length = 0;
    completionError = null;
    const body = { type: 'blob.upload-completed', payload: { blob: { url: 'https://x.public.blob.vercel-storage.com/gym-a/home-videos/a.mp4' }, tokenPayload: '{}' } };
    const res = fakeRes();
    await uploads.handleBlobUpload(fakeReq(body, { user: undefined }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { type: 'blob.upload-completed', response: 'ok' });
    assert.equal(calls[0].body, body);
    await assert.rejects(() => calls[0].onBeforeGenerateToken('gym-a/home-videos/x.mp4', null, false));

    // A bad signature (handleUpload throws) is a 400, not a crash.
    completionError = new Error('Vercel Blob: Invalid callback signature');
    const bad = fakeRes();
    await uploads.handleBlobUpload(fakeReq(body, { user: undefined }), bad);
    assert.equal(bad.statusCode, 400);
    completionError = null;
  });
});

test('the gate lets only the completion callback past without a signed-in user', async () => {
  let passed = false;
  const callback = fakeRes();
  uploads.authorizeBlobUpload(fakeReq({ type: 'blob.upload-completed', payload: {} }, { user: undefined }), callback, () => {
    passed = true;
  });
  assert.equal(passed, true);

  passed = false;
  const anonymous = fakeRes();
  await uploads.authorizeBlobUpload(
    fakeReq(tokenRequest({ kind: 'homepage-video', contentType: 'video/mp4', size: MB }), { user: undefined }),
    anonymous,
    () => {
      passed = true;
    }
  );
  assert.equal(passed, false);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.body.code, 'TOKEN_MISSING');
});

test('capabilities say whether direct upload is on, and each kind\'s ceilings', async () => {
  const { MAX_FILE_BYTES, MAX_VIDEO_FILE_BYTES } = require('../../src/helper/upload');
  await withToken(undefined, async () => {
    const res = fakeRes();
    uploads.capabilities(fakeReq(undefined), res);
    assert.equal(res.body.data.direct, false);
  });
  await withToken('vercel_blob_rw_store_secret', async () => {
    const res = fakeRes();
    uploads.capabilities(fakeReq(undefined), res);
    const { direct, kinds } = res.body.data;
    assert.equal(direct, true);
    assert.equal(kinds['homepage-video'].apiMaxBytes, MAX_VIDEO_FILE_BYTES);
    assert.equal(kinds['homepage-video'].directMaxBytes, 100 * MB);
    assert.equal(kinds['hero-slide'].apiMaxBytes, MAX_FILE_BYTES);
    assert.equal(kinds['hero-slide'].directMaxBytes, 20 * MB);
    assert.deepEqual(kinds.testimonial.contentTypes, ['image/jpeg', 'image/png', 'image/webp']);
  });
});

// ---------------------------------------------------------------------------
// Saving the URL afterwards
// ---------------------------------------------------------------------------

test('an uploaded URL is only accepted from the Blob host, under this gym\'s folder', () => {
  const good = 'https://abc123.public.blob.vercel-storage.com/gym-a/hero-slides/1-2-sunrise.jpg';
  assert.equal(ownBlobUrl(good, 'gym-a', 'hero-slides'), good);
  // Query and fragment are dropped.
  assert.equal(ownBlobUrl(`${good}?download=1#x`, 'gym-a', 'hero-slides'), good);

  const refused = [
    'https://abc123.public.blob.vercel-storage.com/gym-b/hero-slides/1.jpg', // another gym
    'https://abc123.public.blob.vercel-storage.com/gym-a/testimonials/1.jpg', // another folder
    'https://abc123.public.blob.vercel-storage.com/gym-a/hero-slides-evil/1.jpg', // prefix trick
    'https://abc123.public.blob.vercel-storage.com/gym-a/hero-slides/', // the folder itself
    'https://abc123.public.blob.vercel-storage.com/gym-a/hero-slides/../../gym-b/hero-slides/1.jpg', // climbs out
    'https://abc123.public.blob.vercel-storage.com/gym-a/hero-slides/%2e%2e/%2e%2e/gym-b/hero-slides/1.jpg',
    'http://abc123.public.blob.vercel-storage.com/gym-a/hero-slides/1.jpg', // not https
    'https://abc123.public.blob.vercel-storage.com.evil.com/gym-a/hero-slides/1.jpg',
    'https://public.blob.vercel-storage.com/gym-a/hero-slides/1.jpg',
    'https://evil.com/gym-a/hero-slides/1.jpg',
    'https://user:pw@abc123.public.blob.vercel-storage.com/gym-a/hero-slides/1.jpg',
    '/uploads/gym-a/1.jpg',
    'javascript:alert(1)',
    '',
    undefined,
    { url: good },
  ];
  for (const value of refused) assert.equal(ownBlobUrl(value, 'gym-a', 'hero-slides'), null, String(value));

  // Outside a gym the bare folder is the prefix, as for the API path.
  assert.equal(ownBlobUrl('https://s.public.blob.vercel-storage.com/testimonials/1.png', '', 'testimonials'), 'https://s.public.blob.vercel-storage.com/testimonials/1.png');
});
