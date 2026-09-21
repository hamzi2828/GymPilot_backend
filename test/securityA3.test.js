// Path containment for upload deletes, regex escaping for blog search,
// signed unsubscribe links, who may change whose pay, the per-account login
// limiter, the upload size refusal and what the checkout verify endpoint
// gives away. No database: everything here stops before a model is used.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../src/platform/tenantContext');

const gymA = { _id: '000000000000000000000001', slug: 'a', database: { name: 'gympilot_unit_a' } };
const gymB = { _id: '000000000000000000000002', slug: 'b', database: { name: 'gympilot_unit_b' } };

// A stand-in for an Express response that records what was sent.
function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

test('a stored image path only ever resolves inside the uploads folder', () => {
  const { localUploadPath, UPLOADS_DIR } = require('../src/helper/upload');
  const inside = localUploadPath('/uploads/gym-a/123-photo.jpg');
  assert.equal(inside, path.join(UPLOADS_DIR, 'gym-a', '123-photo.jpg'));

  for (const hostile of ['/uploads/../.env', '/uploads/../../etc/passwd', '../.env', '.env', '/etc/passwd', '/uploads/gym/../../.env', '', null, 42]) {
    assert.equal(localUploadPath(hostile), null, String(hostile));
  }
  // A blob URL is not one of our files either.
  assert.equal(localUploadPath('https://x.public.blob.vercel-storage.com/a/b.jpg'), null);
});

test('blog search text is matched literally', () => {
  const { escapeRegex } = require('../src/services/blogs/getAllBlogsService');
  assert.equal(escapeRegex('('), '\\(');
  // "(" used to be a regex syntax error, and so a 500.
  assert.doesNotThrow(() => new RegExp(escapeRegex('(((')));
  const rx = new RegExp(escapeRegex('a.b*'), 'i');
  assert.ok(rx.test('A.B*'));
  assert.ok(!rx.test('axbbb'));
  // A catastrophic-backtracking pattern becomes plain text.
  assert.equal(escapeRegex('(a+)+$'), '\\(a\\+\\)\\+\\$');
});

test('an unsubscribe token is tied to the address and the gym', async () => {
  const { unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } = require('../src/services/unsubscribeLinks');

  const token = await runWithTenant(gymA, () => unsubscribeToken('Ann@Example.com'));
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);

  await runWithTenant(gymA, () => {
    assert.equal(verifyUnsubscribeToken('ann@example.com', token), true);
    assert.equal(verifyUnsubscribeToken('  ANN@example.com ', token), true, 'case and spacing do not matter');
    assert.equal(verifyUnsubscribeToken('bob@example.com', token), false, 'another address');
    assert.equal(verifyUnsubscribeToken('ann@example.com', token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')), false, 'tampered');
    assert.equal(verifyUnsubscribeToken('ann@example.com', ''), false);
    assert.equal(verifyUnsubscribeToken('ann@example.com', undefined), false);
    assert.equal(verifyUnsubscribeToken('ann@example.com', { length: 32 }), false);
    assert.equal(verifyUnsubscribeToken('', token), false);
  });

  await runWithTenant(gymB, () => {
    assert.equal(verifyUnsubscribeToken('ann@example.com', token), false, 'another gym');
  });

  const url = await runWithTenant(gymA, () => unsubscribeUrl('https://gym.example/', 'Ann@Example.com'));
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://gym.example/unsubscribe');
  assert.equal(parsed.searchParams.get('email'), 'ann@example.com');
  assert.equal(parsed.searchParams.get('token'), token);
});

test('the unsubscribe endpoint wants the token, not just an address', async () => {
  const controller = require('../src/controller/newsletterController');

  const missing = fakeRes();
  await controller.unsubscribe({ body: { email: 'ann@example.com' } }, missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.code, 'UNSUBSCRIBE_TOKEN_MISSING');

  const forged = fakeRes();
  await runWithTenant(gymA, () => controller.unsubscribe({ body: { email: 'ann@example.com', token: 'x'.repeat(32) } }, forged));
  assert.equal(forged.statusCode, 400);
  assert.equal(forged.body.code, 'UNSUBSCRIBE_TOKEN_INVALID');
});

test('nobody below an administrator changes their own pay, or an administrator\'s', () => {
  const { payChangeProblem } = require('../src/services/payGuards');
  const manager = { _id: 'm1', role: 'manager' };
  const otherManager = { _id: 'm2', role: 'manager' };
  const admin = { _id: 'a1', role: 'admin' };
  const receptionist = { _id: 'r1', role: 'receptionist' };

  assert.match(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: manager, what: 'pay' }), /your own pay/);
  assert.match(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: manager, what: 'leave' }), /your own leave/);
  assert.match(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: manager, what: 'payslip' }), /your own payslip/);
  assert.match(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: admin, what: 'payslip' }), /Only an administrator/);
  assert.match(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: admin, what: 'pay' }), /Only an administrator/);
  // Ids compare as strings, so an ObjectId and its text form match.
  assert.match(payChangeProblem({ actorId: { toString: () => 'm1' }, actorRole: 'manager', target: manager }), /your own/);

  assert.equal(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: otherManager, what: 'pay' }), null);
  assert.equal(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: receptionist, what: 'leave' }), null);
  // An administrator is not held to it -- including for their own pay.
  assert.equal(payChangeProblem({ actorId: 'a1', actorRole: 'admin', target: admin, what: 'pay' }), null);
  assert.equal(payChangeProblem({ actorId: 'a1', actorRole: 'admin', target: manager, what: 'payslip' }), null);
  assert.equal(payChangeProblem({ actorId: 'm1', actorRole: 'manager', target: null }), null);
});

test('one member fumbling a password does not lock out the rest of the gym\'s Wi-Fi', async () => {
  const express = require('express');
  const { loginLimiter, identityKey } = require('../src/middleware/rateLimit');

  assert.equal(identityKey({ ip: '203.0.113.9', body: { email: ' Ann@Gym.COM ' } }), '203.0.113.9|ann@gym.com');
  assert.equal(identityKey({ ip: '203.0.113.9', body: { username: 'Ann123' } }), '203.0.113.9|ann123');

  const app = express();
  app.use(express.json());
  app.post('/login', loginLimiter, (req, res) => res.status(401).json({ message: 'Invalid credentials' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/login`;
  const attempt = (email) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'wrong' }) });

  try {
    const who = `fumbler-${Date.now()}@gym.test`;
    let last;
    for (let i = 0; i < 21; i += 1) last = await attempt(who);
    assert.equal(last.status, 429, 'the same account from the same address is limited');
    assert.match((await last.json()).message, /Too many sign-in attempts/);

    const neighbour = await attempt(`neighbour-${Date.now()}@gym.test`);
    assert.equal(neighbour.status, 401, 'another member on the same Wi-Fi can still try');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an upload over its limit is a 413 that says what to do', () => {
  const { sizeLimited, ALLOWED_IMAGE_MIME_TYPES, EXTENSION_FOR_MIME } = require('../src/helper/upload');
  const blob = require('../src/helper/blobUpload');

  const tooBig = fakeRes();
  let passedOn = 'not called';
  sizeLimited((req, res, next) => next(Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' })), 20 * 1024 * 1024)(
    {},
    tooBig,
    (error) => {
      passedOn = error;
    }
  );
  assert.equal(passedOn, 'not called');
  assert.equal(tooBig.statusCode, 413);
  assert.equal(tooBig.body.code, 'FILE_TOO_LARGE');
  assert.match(tooBig.body.message, /20 MB/);

  // Any other upload error still reaches the global handler.
  const other = new Error('Only image files are allowed');
  sizeLimited((req, res, next) => next(other), 1)({}, fakeRes(), (error) => {
    passedOn = error;
  });
  assert.equal(passedOn, other);

  // SVG can carry script: refused on the way in and on the way to the store.
  assert.equal(ALLOWED_IMAGE_MIME_TYPES.has('image/svg+xml'), false);
  assert.equal(blob.ALLOWED_IMAGE_MIME_TYPES.has('image/svg+xml'), false);
  assert.equal(EXTENSION_FOR_MIME['image/png'], '.png');
  assert.equal(EXTENSION_FOR_MIME['image/svg+xml'], undefined);
});

test('the checkout verify endpoint returns the order number, not the payer', async () => {
  const service = require('../src/services/gymfolioPaymentService');
  const controller = require('../src/gymfolio/controller/gymfolioPaymentController');
  const original = service.verifyPackagePayment;
  service.verifyPackagePayment = async () => ({
    success: true,
    paid: true,
    session: { id: 'cs_test_1', customer_details: { email: 'payer@example.com', name: 'Pat Payer', address: { line1: '1 High St' } } },
    order: {
      orderNumber: 'GP-202609-0001',
      packageId: 'p1',
      packageDetails: { name: 'Monthly' },
      status: 'active',
      payment: { amount: 50, currency: 'gbp', stripeCustomerId: 'cus_1' },
      customerInfo: { fullName: 'Pat Payer', email: 'payer@example.com', phone: '0123' }
    }
  });

  try {
    const res = fakeRes();
    await controller.verifyPackagePayment({ params: { sessionId: 'cs_test_1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.paid, true);
    assert.equal(res.body.order.orderNumber, 'GP-202609-0001');
    assert.equal(res.body.session, undefined);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('payer@example.com'), 'no email');
    assert.ok(!text.includes('Pat Payer'), 'no name');
    assert.ok(!text.includes('cus_1'), 'no Stripe customer');
  } finally {
    service.verifyPackagePayment = original;
  }
});
