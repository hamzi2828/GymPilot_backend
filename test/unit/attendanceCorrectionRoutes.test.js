// The admin attendance router (/api/attendance) gates each of its own routes
// -- corrections included -- and nothing else. Requests for the other routes
// under /api/attendance (the fingerprints, mounted in routes/allRoutes.js with
// gates of their own) pass through it untouched: a router-wide gate here used
// to run for them too, checking permission twice and writing every
// fingerprint removal to the audit log twice.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../../src/attendance/routes/adminRoutes');

// Runs one request through the router alone. Resolves with how it ended: an
// answer from this router, or passed on to whatever is mounted after it.
function run(method, url) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        resolve({ passedOn: false, res: this });
        return this;
      },
      on() {},
      setHeader() {},
      getHeader() {}
    };
    const req = { method, url, originalUrl: `/api/attendance${url}`, headers: {} };
    router(req, res, (error) => resolve({ passedOn: true, error, res }));
  });
}

const OWN_ROUTES = [
  ['get', '/records'],
  ['get', '/live'],
  ['get', '/people'],
  ['get', '/person/:personType/:personId'],
  ['patch', '/records/:id'],
  ['post', '/records/:id/void'],
  ['get', '/settings'],
  ['put', '/settings']
];

test('every route is gated on its own, and nothing is gated router-wide', () => {
  const layers = router.stack;
  assert.ok(layers.every((layer) => layer.route), 'no router.use() middleware that would run for other routes');

  const routes = new Map(
    layers.map((layer) => [`${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`, layer.route])
  );

  for (const [method, path] of OWN_ROUTES) {
    const route = routes.get(`${method} ${path}`);
    assert.ok(route, `${method.toUpperCase()} ${path} is routed`);
    const chain = route.stack.map((layer) => layer.handle.name);
    assert.equal(chain[0], 'auth', `${method.toUpperCase()} ${path} checks the token first`);
    assert.equal(chain[1], 'permissionGate', `${method.toUpperCase()} ${path} checks the attendance permission`);
    assert.equal(chain.filter((name) => name === 'permissionGate').length, 1, `${method.toUpperCase()} ${path} is gated once`);
  }

  // A member's own attendance needs a token and nothing more.
  for (const path of ['/me', '/me/qr']) {
    const chain = routes.get(`get ${path}`).stack.map((layer) => layer.handle.name);
    assert.equal(chain[0], 'auth');
    assert.ok(!chain.includes('permissionGate'), `${path} is not behind the attendance permission`);
  }
});

test('the fingerprint routes pass through untouched, to be gated once where they are mounted', async () => {
  for (const [method, url] of [
    ['DELETE', '/fingerprints/member/0000000000000000000000a1'],
    ['DELETE', '/fingerprints/staff/0000000000000000000000a1/3'],
    ['GET', '/fingerprints']
  ]) {
    const { passedOn, error, res } = await run(method, url);
    assert.equal(passedOn, true, `${method} ${url} is passed on`);
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 200, 'nothing here answered it');
  }
});

test('this router\'s own routes still refuse a request without a token', async () => {
  for (const [method, url] of [
    ['GET', '/records'],
    ['GET', '/live'],
    ['GET', '/people'],
    ['GET', '/person/member/0000000000000000000000a1'],
    ['PATCH', '/records/0000000000000000000000a1'],
    ['POST', '/records/0000000000000000000000a1/void'],
    ['GET', '/settings'],
    ['PUT', '/settings'],
    ['GET', '/me']
  ]) {
    const { passedOn, res } = await run(method, url);
    assert.equal(passedOn, false, `${method} ${url} is answered here`);
    assert.equal(res.statusCode, 401, `${method} ${url}`);
    assert.equal(res.body.code, 'TOKEN_MISSING');
  }
});
